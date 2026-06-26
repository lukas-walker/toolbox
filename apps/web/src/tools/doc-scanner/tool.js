import { STATES, canTransition, quadOutputSize, fullFrameCorners, buildScanPdf, pdfTimestamp } from "./logic.js";
import { compressToJpegBlob } from "../../shared/image.js";
import { downloadBlob } from "../../shared/download.js";

// Live border detection (sub-issue #7) runs on a small downscaled copy of the
// video frame for speed, and only a few times per second to keep CPU/battery in
// check on mid-range phones. The CV stack (OpenCV.js + jscanify) is run in a
// dedicated Web Worker — see scanWorker.js — because OpenCV.js is a ~9 MB build
// with the WASM embedded, and compiling/running it on the main thread freezes
// the whole page. The worker keeps the UI responsive while it loads and detects.
const DETECT_MAX_SIDE = 480; // longest side of the detection frame, in px
const DETECT_INTERVAL_MS = 125; // ~8 fps throttle (not every animation frame)
// Cap the longest side of a captured/warped page (sub-issue #8). Keeps documents
// sharp without producing needlessly huge images to compress and embed in the PDF.
const CAPTURE_MAX_SIDE = 2000;
// Page compression (sub-issue #9). On Accept the warped page <canvas> is
// re-encoded to a JPEG blob through the shared image pipeline so behavior matches
// the Image-to-PDF tool. The page is already capped at CAPTURE_MAX_SIDE by the
// warp, so we cap compression at the same longest side (no upscaling).
const PAGE_JPEG_QUALITY = 0.8;
const PAGE_MAX_DIM = CAPTURE_MAX_SIDE;

// Same-origin, precached worker + vendored CV scripts (absolute so the worker's
// importScripts resolves them regardless of base path). NEVER load from a CDN.
const WORKER_URL = `${import.meta.env.BASE_URL}scanWorker.js`;
const OPENCV_URL = new URL(`${import.meta.env.BASE_URL}vendor/opencv/opencv.js`, location.href).href;
const JSCANIFY_URL = new URL(`${import.meta.env.BASE_URL}vendor/jscanify.js`, location.href).href;

// Scan Document — mobile-first, fully client-side document scanner.
//
// This is the scaffold (sub-issue #5 of #3): the tool factory, tab registration,
// the capture state machine, and placeholder panels for each state. Camera
// capture, live border detection, perspective warp, compression and PDF/share
// export are wired in by the later sub-issues.
//
// DOM ownership stays inside this tool's `root`. Anything that needs cleanup
// (camera tracks, RAF/interval handles, object URLs, OpenCV Mats) is registered
// via registerTeardown() so destroy() can release everything reliably.
export function createDocScannerTool() {
    let root = null;
    let panel = null;
    let state = STATES.IDLE;

    // In-memory captured pages (sub-issue #9). Each is { id, blob, url } where
    // `blob` is the compressed JPEG and `url` is its object-URL thumbnail. Nothing
    // is persisted across reload. Capture order is preserved (no reordering in v1).
    let pages = [];

    // When the user taps "Retake" on an existing page, we remove that page and
    // remember its index here so the next accepted capture is inserted back in the
    // same position (rather than appended), preserving page order. null for a
    // normal capture/append.
    let retakeIndex = null;

    // Camera (sub-issue #6). Single source of truth for the live stream + the
    // <video> it is attached to, so cleanup is reliable from anywhere. Later
    // tasks (live border detection) read frames from `videoEl`.
    let currentStream = null;
    let videoEl = null;

    // Live border detection (sub-issue #7). The CV stack runs in a Web Worker
    // (scanWorker.js) so the heavy OpenCV load/detection never blocks the UI.
    // The throttled loop downscales each frame and posts it to the worker; the
    // worker posts back the document corners, which we paint on `overlayEl`.
    let scanWorker = null;
    let workerReady = false; // worker has loaded OpenCV + jscanify
    let workerBusy = false; // a frame is currently being processed (one at a time)
    let overlayEl = null;
    let overlayCtx = null;
    let detectCanvas = null; // offscreen, downscaled frame for detection
    let detectRaf = null; // requestAnimationFrame handle for the send loop
    let lastDetectAt = 0;
    let frameSeq = 0;
    // Dimensions of the frame currently in flight to the worker, so its result
    // can be mapped back to display coordinates.
    let inFlight = null;
    // Latest detected corners, in full-resolution (video-intrinsic) coordinates,
    // so the capture task (#8) can reuse them at full resolution. null when no
    // document is currently detected.
    let lastCorners = null;

    // Capture + warp (sub-issue #8). On Capture we grab a full-resolution frame,
    // reuse the latest live-detected corners, and hand both to the worker for a
    // perspective warp. `capturedCanvas` holds the deskewed page awaiting
    // Accept/Retake in the `review` state. `captureJob` carries the original
    // frame as a fallback if the warp fails; `captureToken` invalidates stale
    // async results (a retake or unmount that lands after the warp comes back).
    let capturedCanvas = null;
    let captureJob = null;
    let captureToken = 0;

    // Teardown registry — later tasks push cleanup callbacks here.
    let teardownFns = [];

    function registerTeardown(fn) {
        teardownFns.push(fn);
    }

    function runTeardown() {
        // Run in reverse registration order; never let one failure block the rest.
        while (teardownFns.length) {
            const fn = teardownFns.pop();
            try { fn(); } catch (e) { console.error(e); }
        }
    }

    function setState(next) {
        if (!canTransition(state, next)) {
            console.warn(`doc-scanner: ignoring illegal transition ${state} -> ${next}`);
            return;
        }
        // Leaving the live preview must release the camera immediately (no light
        // left on), per the resource-ownership checklist in #3.
        if (state === STATES.SCANNING && next !== STATES.SCANNING) {
            stopDetection();
            stopCamera();
        }
        state = next;
        renderState();
    }

    // --- Per-state panels -----------------------------------------------------

    function renderIdle() {
        panel.innerHTML = `
      <div class="panel">
        <p class="muted">
          Scan a document with your camera. Borders are detected live, the page
          is flattened and cropped, then exported as a PDF — all on your device.
        </p>
        <div class="row">
          <button id="ds-start" class="primary">Start scanning</button>
        </div>
      </div>
    `;
        panel.querySelector("#ds-start").addEventListener("click", () => setState(STATES.SCANNING));
    }

    function renderScanning() {
        panel.innerHTML = `
      <div class="panel">
        <div class="ds-viewport">
          <!-- playsinline + muted are required for iOS Safari inline playback. -->
          <video id="ds-video" class="ds-video" autoplay playsinline muted></video>
          <!-- Live border-detection overlay, drawn over the video feed. -->
          <canvas id="ds-overlay" class="ds-overlay"></canvas>
          <div id="ds-cv-status" class="ds-cv-status" hidden>Loading scanner…</div>
          <div id="ds-cam-msg" class="ds-viewport-placeholder muted" hidden></div>
        </div>
        <div class="row">
          <button id="ds-capture" class="primary" disabled>Capture</button>
          <button id="ds-back">${pages.length ? "Back to pages" : "Cancel"}</button>
        </div>
        <div class="muted" style="margin-top:6px;">
          ${pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"} captured so far.` : "Point the camera at a document."}
        </div>
      </div>
    `;
        panel.querySelector("#ds-capture").addEventListener("click", onCaptureClick);
        panel.querySelector("#ds-back").addEventListener("click", () =>
            setState(pages.length ? STATES.PAGES : STATES.IDLE)
        );

        // Start the live preview. Capture stays disabled until the feed is playing.
        startCamera();
    }

    // --- Camera (sub-issue #6) ------------------------------------------------

    async function startCamera() {
        // Single source of truth: drop any previous stream before opening a new one.
        stopCamera();
        resetCameraView();

        const video = panel ? panel.querySelector("#ds-video") : null;
        if (!video) return;
        videoEl = video;

        // getUserMedia is only exposed in secure contexts (HTTPS or localhost).
        if (!window.isSecureContext) {
            showCameraMessage({
                title: "Camera needs a secure connection",
                detail: "The camera is only available over HTTPS or on localhost.",
            });
            return;
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            showCameraMessage({
                title: "Camera not supported",
                detail: "This browser does not support live camera capture.",
            });
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false,
            });
        } catch (err) {
            showCameraMessage(cameraErrorMessage(err));
            return;
        }

        // The user may have left the scanning state while we awaited permission;
        // if so, this stream is orphaned — stop it instead of attaching.
        if (!root || state !== STATES.SCANNING || videoEl !== video || !video.isConnected) {
            stream.getTracks().forEach((t) => stopTrack(t));
            return;
        }

        currentStream = stream;
        video.srcObject = stream;
        video.addEventListener(
            "playing",
            () => {
                const capture = panel && panel.querySelector("#ds-capture");
                if (capture) capture.disabled = false;
                // The feed is live — kick off live border detection.
                startDetection();
            },
            { once: true }
        );
        // Some browsers need an explicit play(); ignore benign interruption errors.
        const playPromise = video.play && video.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => { });
        }
    }

    function stopCamera() {
        if (currentStream) {
            currentStream.getTracks().forEach((t) => stopTrack(t));
            currentStream = null;
        }
        if (videoEl) {
            try { videoEl.pause && videoEl.pause(); } catch (e) { /* ignore */ }
            videoEl.srcObject = null;
            videoEl = null;
        }
    }

    function stopTrack(track) {
        try { track.stop(); } catch (e) { /* ignore */ }
    }

    // --- Live border detection (sub-issue #7) ---------------------------------

    // Spin up the CV worker (if needed) and start the throttled send loop once
    // the camera feed is playing. Safe to call repeatedly. The heavy OpenCV load
    // happens inside the worker, so the UI stays responsive (the page used to
    // freeze when OpenCV.js was compiled on the main thread).
    function startDetection() {
        if (!panel || state !== STATES.SCANNING) return;
        overlayEl = panel.querySelector("#ds-overlay");
        overlayCtx = overlayEl ? overlayEl.getContext("2d") : null;
        if (!detectCanvas) detectCanvas = document.createElement("canvas");

        const statusEl = panel.querySelector("#ds-cv-status");

        // Worker already loaded (e.g. re-entered scanning) — just restart the loop.
        if (workerReady && scanWorker) {
            if (statusEl) statusEl.hidden = true;
            startDetectLoop();
            return;
        }

        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = "Loading scanner…";
        }

        if (!scanWorker) {
            try {
                scanWorker = new Worker(WORKER_URL);
            } catch (err) {
                console.error("doc-scanner: could not start CV worker", err);
                showCvUnavailable();
                return;
            }
            scanWorker.onmessage = onWorkerMessage;
            scanWorker.onerror = (e) => {
                console.error("doc-scanner: CV worker error", e && e.message);
                showCvUnavailable();
            };
            scanWorker.postMessage({ type: "init", opencvUrl: OPENCV_URL, jscanifyUrl: JSCANIFY_URL });
        }
        // Otherwise the worker exists but is still loading; the "ready" message
        // will start the loop.
    }

    function onWorkerMessage(e) {
        const msg = e.data;
        if (!msg) return;
        if (msg.type === "ready") {
            workerReady = true;
            const el = panel && panel.querySelector("#ds-cv-status");
            if (el) el.hidden = true;
            if (state === STATES.SCANNING) startDetectLoop();
        } else if (msg.type === "error") {
            console.error("doc-scanner: CV worker:", msg.error);
            showCvUnavailable();
        } else if (msg.type === "result") {
            workerBusy = false;
            handleResult(msg);
        } else if (msg.type === "warpResult") {
            handleWarpResult(msg);
        }
    }

    // Detection is a non-blocking aid — capture still works without it.
    function showCvUnavailable() {
        const el = panel && panel.querySelector("#ds-cv-status");
        if (el) {
            el.hidden = false;
            el.textContent = "Live border detection unavailable.";
        }
    }

    function startDetectLoop() {
        if (detectRaf != null) return; // already running
        lastDetectAt = 0;
        detectRaf = requestAnimationFrame(sendTick);
    }

    // Throttled loop: when the worker is idle, grab a downscaled frame and post
    // it for detection. We never block the main thread on CV work here.
    function sendTick(now) {
        // Schedule the next frame first so an exception can't kill the loop.
        detectRaf = requestAnimationFrame(sendTick);

        if (!workerReady || !scanWorker || !videoEl || state !== STATES.SCANNING) return;
        if (workerBusy) return; // worker still processing the previous frame
        if (now - lastDetectAt < DETECT_INTERVAL_MS) return;

        const video = videoEl;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (video.readyState < 2 || !vw || !vh) return;
        lastDetectAt = now;

        // Detect on a downscaled frame for speed (longest side ~DETECT_MAX_SIDE).
        const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(vw, vh));
        const dw = Math.max(1, Math.round(vw * scale));
        const dh = Math.max(1, Math.round(vh * scale));
        if (detectCanvas.width !== dw) detectCanvas.width = dw;
        if (detectCanvas.height !== dh) detectCanvas.height = dh;
        const dctx = detectCanvas.getContext("2d", { willReadFrequently: true });
        dctx.drawImage(video, 0, 0, dw, dh);

        let imageData;
        try {
            imageData = dctx.getImageData(0, 0, dw, dh);
        } catch (err) {
            // e.g. a tainted canvas — shouldn't happen with the same-origin camera.
            return;
        }

        workerBusy = true;
        inFlight = { vw, vh, dw, dh };
        const buffer = imageData.data.buffer;
        // Transfer the pixel buffer to avoid a copy.
        scanWorker.postMessage(
            { type: "frame", frameId: ++frameSeq, width: dw, height: dh, buffer },
            [buffer]
        );
    }

    // Map a worker detection result onto the overlay.
    function handleResult(msg) {
        if (state !== STATES.SCANNING) return;
        const sent = inFlight;
        inFlight = null;
        if (!sent || !overlayEl) return;

        if (msg.corners) {
            // Map the downscaled corners back to full-resolution video coords so
            // the capture task can reuse them; keep the latest set around.
            const inv = sent.vw / msg.width; // == 1 / scale
            lastCorners = {
                topLeftCorner: scalePoint(msg.corners.topLeftCorner, inv),
                topRightCorner: scalePoint(msg.corners.topRightCorner, inv),
                bottomRightCorner: scalePoint(msg.corners.bottomRightCorner, inv),
                bottomLeftCorner: scalePoint(msg.corners.bottomLeftCorner, inv),
            };
            drawOverlay(lastCorners, sent.vw, sent.vh);
        } else {
            // No document this frame — clear, don't crash.
            lastCorners = null;
            clearOverlay();
        }
    }

    function scalePoint(p, factor) {
        return { x: p.x * factor, y: p.y * factor };
    }

    // --- Capture + perspective warp (sub-issue #8) ----------------------------

    // Grab the current frame at full camera resolution and warp it to a flat,
    // cropped page. The heavy OpenCV warp runs in the worker (cv only lives
    // there), so this stays async: we transition to `review` once the warped
    // result comes back. If detection never found a document, or the CV worker
    // is unavailable, we fall back to the full (unwarped) frame instead of
    // failing.
    function onCaptureClick() {
        if (state !== STATES.SCANNING || !videoEl) return;
        const video = videoEl;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (video.readyState < 2 || !vw || !vh) return;

        // Guard against a double press / navigation while the warp is in flight.
        const captureBtn = panel && panel.querySelector("#ds-capture");
        const backBtn = panel && panel.querySelector("#ds-back");
        if (captureBtn) { captureBtn.disabled = true; captureBtn.textContent = "Processing…"; }
        if (backBtn) backBtn.disabled = true;

        // Full-resolution frame grab.
        const frame = document.createElement("canvas");
        frame.width = vw;
        frame.height = vh;
        const fctx = frame.getContext("2d", { willReadFrequently: true });
        fctx.drawImage(video, 0, 0, vw, vh);

        // Reuse the latest live-detected corners (already mapped to full-res). When
        // none were found, fall back to the whole frame — warping that quad is just
        // a resize, giving one uniform code path.
        const corners = lastCorners || fullFrameCorners(vw, vh);

        // Stop posting detection frames so the worker is free to warp promptly.
        if (detectRaf != null) { cancelAnimationFrame(detectRaf); detectRaf = null; }

        const token = ++captureToken;
        captureJob = { token, frame };

        // No CV worker (load failed) → cannot warp; use the plain resized frame.
        if (!workerReady || !scanWorker) {
            finishCapture(token, downscaledCanvas(frame, CAPTURE_MAX_SIDE));
            return;
        }

        let imageData;
        try {
            imageData = fctx.getImageData(0, 0, vw, vh);
        } catch (err) {
            // Tainted canvas shouldn't happen with the same-origin camera, but if
            // it does, degrade gracefully to the unwarped frame.
            finishCapture(token, downscaledCanvas(frame, CAPTURE_MAX_SIDE));
            return;
        }

        const { width: outW, height: outH } = quadOutputSize(corners, CAPTURE_MAX_SIDE);
        const buffer = imageData.data.buffer;
        scanWorker.postMessage(
            {
                type: "warp",
                jobId: token,
                width: vw,
                height: vh,
                buffer,
                corners,
                outWidth: outW,
                outHeight: outH,
            },
            [buffer] // transfer the pixel buffer to avoid a copy
        );
    }

    function handleWarpResult(msg) {
        const job = captureJob;
        // Ignore stale results (a newer capture, retake, or unmount happened).
        if (!job || job.token !== msg.jobId) return;
        captureJob = null;

        if (msg.ok && msg.buffer && msg.width && msg.height) {
            const canvas = document.createElement("canvas");
            canvas.width = msg.width;
            canvas.height = msg.height;
            const imageData = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
            canvas.getContext("2d").putImageData(imageData, 0, 0);
            finishCapture(job.token, canvas);
        } else {
            // Warp failed in the worker — fall back to the unwarped frame.
            console.error("doc-scanner: warp failed", msg.error);
            finishCapture(job.token, downscaledCanvas(job.frame, CAPTURE_MAX_SIDE));
        }
    }

    function finishCapture(token, canvas) {
        // A newer capture or teardown landed while we were processing.
        if (token !== captureToken || !root || state !== STATES.SCANNING) return;
        capturedCanvas = canvas;
        setState(STATES.REVIEW);
    }

    // Draw a source canvas onto a new one, scaled so its longest side is at most
    // `maxSide`. Used for the no-warp fallbacks.
    function downscaledCanvas(src, maxSide) {
        const sw = src.width;
        const sh = src.height;
        const scale = Math.min(1, maxSide / Math.max(sw, sh));
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(sw * scale));
        out.height = Math.max(1, Math.round(sh * scale));
        out.getContext("2d").drawImage(src, 0, 0, out.width, out.height);
        return out;
    }

    // Draw the detected quad onto the overlay, mapping video-intrinsic coords to
    // display coords. The <video> uses object-fit: contain, so the rendered feed
    // is letterboxed inside the viewport — mirror that fit here so the quad lines
    // up across orientation/resize.
    function drawOverlay(corners, vw, vh) {
        if (!overlayEl || !overlayCtx) return;
        const cssW = overlayEl.clientWidth;
        const cssH = overlayEl.clientHeight;
        if (!cssW || !cssH) return;

        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(cssW * dpr);
        const bh = Math.round(cssH * dpr);
        if (overlayEl.width !== bw) overlayEl.width = bw;
        if (overlayEl.height !== bh) overlayEl.height = bh;

        const ctx = overlayCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        // object-fit: contain mapping from intrinsic → CSS pixels.
        const fit = Math.min(cssW / vw, cssH / vh);
        const offX = (cssW - vw * fit) / 2;
        const offY = (cssH - vh * fit) / 2;
        const tx = (p) => ({ x: offX + p.x * fit, y: offY + p.y * fit });

        const tl = tx(corners.topLeftCorner);
        const tr = tx(corners.topRightCorner);
        const br = tx(corners.bottomRightCorner);
        const bl = tx(corners.bottomLeftCorner);

        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(br.x, br.y);
        ctx.lineTo(bl.x, bl.y);
        ctx.closePath();
        ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(34, 197, 94, 0.95)";
        ctx.stroke();
    }

    function clearOverlay() {
        if (!overlayEl || !overlayCtx) return;
        const dpr = window.devicePixelRatio || 1;
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        overlayCtx.clearRect(0, 0, overlayEl.clientWidth, overlayEl.clientHeight);
    }

    // Stop the send loop and release the overlay. The worker is kept alive (and
    // reused) across scanning sessions so re-entering doesn't recompile the
    // ~9 MB OpenCV WASM; it is terminated in destroy() via terminateWorker().
    function stopDetection() {
        if (detectRaf != null) {
            cancelAnimationFrame(detectRaf);
            detectRaf = null;
        }
        workerBusy = false;
        inFlight = null;
        clearOverlay();
        overlayEl = null;
        overlayCtx = null;
        lastCorners = null;
    }

    function terminateWorker() {
        if (scanWorker) {
            try { scanWorker.terminate(); } catch (e) { /* ignore */ }
            scanWorker = null;
        }
        workerReady = false;
        workerBusy = false;
    }

    // Map a getUserMedia rejection onto a clear, actionable message.
    function cameraErrorMessage(err) {
        const name = err && err.name;
        if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
            return {
                title: "Camera permission denied",
                detail: "Allow camera access for this site in your browser, then try again.",
            };
        }
        if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
            return {
                title: "No camera found",
                detail: "This device has no usable camera for scanning.",
            };
        }
        if (name === "NotReadableError" || name === "TrackStartError") {
            return {
                title: "Camera unavailable",
                detail: "Another app may be using the camera. Close it and try again.",
            };
        }
        return {
            title: "Could not start the camera",
            detail: (err && err.message) || String(err),
        };
    }

    // Show an in-viewport message (errors / unsupported) with a retry affordance,
    // hiding the video feed while it is up.
    function showCameraMessage({ title, detail }) {
        if (!panel) return;
        const video = panel.querySelector("#ds-video");
        if (video) video.style.display = "none";
        const msg = panel.querySelector("#ds-cam-msg");
        if (!msg) return;
        msg.hidden = false;
        msg.innerHTML = `
      <div class="ds-cam-msg-title">${escapeHtml(title)}</div>
      <div>${escapeHtml(detail)}</div>
      <div class="row" style="justify-content:center; margin-top:12px;">
        <button id="ds-cam-retry" class="primary">Try again</button>
      </div>
    `;
        const retry = msg.querySelector("#ds-cam-retry");
        if (retry) retry.addEventListener("click", () => startCamera());
    }

    // Restore the default camera view (feed visible, message cleared).
    function resetCameraView() {
        if (!panel) return;
        const video = panel.querySelector("#ds-video");
        if (video) video.style.display = "";
        const msg = panel.querySelector("#ds-cam-msg");
        if (msg) {
            msg.hidden = true;
            msg.innerHTML = "";
        }
    }

    function renderReview() {
        panel.innerHTML = `
      <div class="panel">
        <div class="ds-viewport" id="ds-review-viewport"></div>
        <div class="row">
          <button id="ds-accept" class="primary">Accept</button>
          <button id="ds-retake">Retake</button>
        </div>
      </div>
    `;
        const viewport = panel.querySelector("#ds-review-viewport");
        if (capturedCanvas) {
            capturedCanvas.className = "ds-review-img";
            viewport.appendChild(capturedCanvas);
        } else {
            viewport.innerHTML = `<div class="ds-viewport-placeholder muted">No preview available.</div>`;
        }

        const acceptBtn = panel.querySelector("#ds-accept");
        acceptBtn.addEventListener("click", async () => {
            const canvas = capturedCanvas;
            if (!canvas) return;

            // Compression is async (canvas.toBlob); guard against double taps and
            // a Retake landing mid-encode.
            const retakeBtn = panel.querySelector("#ds-retake");
            acceptBtn.disabled = true;
            acceptBtn.textContent = "Saving…";
            if (retakeBtn) retakeBtn.disabled = true;

            let blob;
            try {
                // Reuse the shared JPEG pipeline so behavior matches Image-to-PDF.
                blob = await compressToJpegBlob(canvas, {
                    quality: PAGE_JPEG_QUALITY,
                    maxDim: PAGE_MAX_DIM,
                });
            } catch (err) {
                console.error("doc-scanner: page compression failed", err);
                if (acceptBtn.isConnected) { acceptBtn.disabled = false; acceptBtn.textContent = "Accept"; }
                if (retakeBtn && retakeBtn.isConnected) retakeBtn.disabled = false;
                return;
            }

            // The user may have torn down or moved on while we encoded; drop the
            // result rather than mutating stale state (and don't leak a URL).
            if (!root || state !== STATES.REVIEW || capturedCanvas !== canvas) return;

            capturedCanvas = null; // ownership transferred to the page
            commitPage(blob);
            setState(STATES.PAGES);
        });
        panel.querySelector("#ds-retake").addEventListener("click", () => {
            capturedCanvas = null; // discard; back to live scanning
            setState(STATES.SCANNING);
        });
    }

    // --- Page list management (sub-issue #9) ----------------------------------

    // Store a freshly compressed page, with an object-URL thumbnail. Inserts at
    // `retakeIndex` when replacing a retaken page, otherwise appends; either way
    // capture order is preserved.
    function commitPage(blob) {
        const url = URL.createObjectURL(blob);
        const page = { id: Date.now() + Math.random(), blob, url };
        if (retakeIndex != null && retakeIndex >= 0 && retakeIndex <= pages.length) {
            pages.splice(retakeIndex, 0, page);
        } else {
            pages.push(page);
        }
        retakeIndex = null;
    }

    // Revoke a single page's thumbnail object URL (idempotent).
    function revokePage(page) {
        if (page && page.url) {
            try { URL.revokeObjectURL(page.url); } catch (e) { /* ignore */ }
            page.url = null;
        }
    }

    function revokeAllPages() {
        pages.forEach(revokePage);
    }

    function renderPages() {
        // A normal entry into the page list is never mid-retake (commitPage clears
        // retakeIndex before we get here); reset it so a backed-out retake can't
        // misplace a later capture.
        retakeIndex = null;

        const count = pages.length;
        panel.innerHTML = `
      <div class="panel">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <strong>${count} page${count === 1 ? "" : "s"}</strong>
        </div>
        <div id="ds-thumbs" class="ds-thumbs"></div>
        <div class="row">
          <button id="ds-add" class="primary">Add more pages</button>
          <button id="ds-finish" ${count ? "" : "disabled"}>Finish</button>
        </div>
        <div id="ds-status" class="status"></div>
      </div>
    `;

        const thumbs = panel.querySelector("#ds-thumbs");
        if (!count) {
            thumbs.innerHTML = `<div class="muted">No pages yet.</div>`;
        } else {
            pages.forEach((page, i) => {
                const item = document.createElement("div");
                item.className = "ds-thumb";
                item.innerHTML = `
          <img class="ds-thumb-img" alt="Page ${i + 1}" />
          <div class="ds-thumb-label muted">Page ${i + 1}</div>
          <div class="row ds-thumb-actions">
            <button class="mini" data-act="retake">Retake</button>
            <button class="mini" data-act="delete">Delete</button>
          </div>
        `;
                item.querySelector("img").src = page.url;

                item.querySelector('[data-act="delete"]').addEventListener("click", () => {
                    revokePage(page);
                    pages = pages.filter((p) => p !== page);
                    renderState();
                });
                item.querySelector('[data-act="retake"]').addEventListener("click", () => {
                    // Remove the page, but remember where it was so the next capture
                    // takes its place rather than landing at the end.
                    const idx = pages.indexOf(page);
                    revokePage(page);
                    pages = pages.filter((p) => p !== page);
                    retakeIndex = idx;
                    setState(STATES.SCANNING);
                });
                thumbs.appendChild(item);
            });
        }

        panel.querySelector("#ds-add").addEventListener("click", () => setState(STATES.SCANNING));
        panel.querySelector("#ds-finish").addEventListener("click", exportPdf);
    }

    // --- PDF assembly + export (sub-issue #10) --------------------------------

    // Build a single multi-page PDF from the captured pages, then hand it to the
    // OS share sheet (mobile) or fall back to a download (desktop / browsers that
    // can't share files). Async, so guard against navigation while it runs and
    // re-query live DOM after each await (a delete/retake may have re-rendered).
    let exporting = false;

    async function exportPdf() {
        if (exporting || !pages.length || state !== STATES.PAGES) return;
        exporting = true;

        const setStatus = (msg) => {
            const el = panel && panel.querySelector("#ds-status");
            if (el) el.textContent = msg;
        };
        const setExportDisabled = (disabled) => {
            const finish = panel && panel.querySelector("#ds-finish");
            const add = panel && panel.querySelector("#ds-add");
            if (finish) finish.disabled = disabled || !pages.length;
            if (add) add.disabled = disabled;
        };

        setExportDisabled(true);
        setStatus("Building PDF…");

        // Snapshot the page blobs now so a concurrent delete can't change the set
        // mid-build. The blobs outlive a thumbnail-URL revoke, so this stays valid.
        const blobs = pages.map((p) => p.blob);

        let blob;
        try {
            blob = await buildScanPdf(blobs);
        } catch (err) {
            console.error("doc-scanner: PDF assembly failed", err);
            setStatus("Could not build the PDF. Please try again.");
            setExportDisabled(false);
            exporting = false;
            return;
        }

        // The user may have torn the tool down while the PDF was assembling.
        if (!root || state !== STATES.PAGES) { exporting = false; return; }

        const filename = `scan-${pdfTimestamp()}.pdf`;
        const file = new File([blob], filename, { type: "application/pdf" });

        // Prefer the native share sheet. File sharing needs a secure context and
        // is unsupported on most desktop browsers — feature-detect and fall back
        // to a plain download when it isn't available.
        const canShareFiles =
            typeof navigator !== "undefined" &&
            typeof navigator.share === "function" &&
            !!navigator.canShare?.({ files: [file] });

        if (canShareFiles) {
            try {
                await navigator.share({ files: [file], title: "Scanned document", text: filename });
                setStatus("Shared.");
            } catch (err) {
                // Dismissing the share sheet rejects with AbortError — that is a
                // normal user action, not a failure, and must NOT also download.
                if (err && err.name === "AbortError") {
                    setStatus("");
                } else {
                    // A genuine share failure (e.g. target error) → download instead.
                    console.error("doc-scanner: share failed, downloading instead", err);
                    downloadBlob(blob, filename);
                    setStatus("Downloaded.");
                }
            }
        } else {
            downloadBlob(blob, filename);
            setStatus("Downloaded.");
        }

        setExportDisabled(false);
        exporting = false;
    }

    function renderState() {
        if (!panel) return;
        switch (state) {
            case STATES.SCANNING: return renderScanning();
            case STATES.REVIEW: return renderReview();
            case STATES.PAGES: return renderPages();
            case STATES.IDLE:
            default: return renderIdle();
        }
    }

    // --- Lifecycle ------------------------------------------------------------

    function render(container) {
        root = document.createElement("div");
        root.className = "tool doc-scanner";
        root.innerHTML = `
      <h1>Scan Document</h1>
      <p>Scan documents with your camera and export a PDF — 100% on your device.</p>
      <div id="ds-panel"></div>
    `;

        panel = root.querySelector("#ds-panel");
        state = STATES.IDLE;
        pages = [];
        retakeIndex = null;
        capturedCanvas = null;
        captureJob = null;

        // Guarantee the detection loop, CV worker, camera and page thumbnail URLs
        // are all released on unmount, regardless of which state we tear down from.
        // Teardown unwinds in reverse, so the loop stops first, then the worker is
        // terminated.
        registerTeardown(stopCamera);
        registerTeardown(terminateWorker);
        registerTeardown(stopDetection);
        registerTeardown(revokeAllPages);

        renderState();

        container.appendChild(root);
    }

    function destroy() {
        runTeardown(); // revokes all page thumbnail URLs (revokeAllPages) too
        // Invalidate any in-flight warp and drop the captured page.
        captureToken++;
        captureJob = null;
        capturedCanvas = null;
        pages = [];
        retakeIndex = null;
        state = STATES.IDLE;
        panel = null;
        if (root) root.innerHTML = "";
        root = null;
    }

    return {
        id: "doc-scanner",
        label: "Scan Document",
        init: render,
        destroy,
    };
}

function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
