import { STATES, canTransition } from "./logic.js";
import { loadOpenCv, loadJscanify } from "../../shared/loadOpenCv.js";

// Live border detection (sub-issue #7) runs on a small downscaled copy of the
// video frame for speed, and only a few times per second to keep CPU/battery in
// check on mid-range phones.
const DETECT_MAX_SIDE = 480; // longest side of the detection frame, in px
const DETECT_INTERVAL_MS = 125; // ~8 fps throttle (not every animation frame)

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

    // In-memory captured pages. Placeholder objects for now; later tasks store
    // the compressed blob + object-URL thumbnail here. Capture order preserved.
    let pages = [];

    // Camera (sub-issue #6). Single source of truth for the live stream + the
    // <video> it is attached to, so cleanup is reliable from anywhere. Later
    // tasks (live border detection) read frames from `videoEl`.
    let currentStream = null;
    let videoEl = null;

    // Live border detection (sub-issue #7). The CV stack is lazy-loaded on
    // entering `scanning`; `cv` is the initialized OpenCV global and `scanner`
    // a jscanify instance. The throttled loop draws each frame to a small
    // offscreen canvas, finds the document quad, and paints it on `overlayEl`.
    let cv = null;
    let scanner = null;
    let cvLoadToken = 0; // guards against a stale async load attaching late
    let overlayEl = null;
    let overlayCtx = null;
    let detectCanvas = null; // offscreen, downscaled frame for detection
    let detectRaf = null; // requestAnimationFrame handle for the detect loop
    let lastDetectAt = 0;
    // Latest detected corners, in full-resolution (video-intrinsic) coordinates,
    // so the capture task (#8) can reuse them at full resolution. null when no
    // document is currently detected.
    let lastCorners = null;

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
        // Placeholder capture: real frame grab + warp arrives in a later task.
        panel.querySelector("#ds-capture").addEventListener("click", () => setState(STATES.REVIEW));
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

    // Lazy-load the CV stack and start the throttled detection loop. Called once
    // the camera feed is actually playing. Safe to call repeatedly.
    function startDetection() {
        if (!panel || state !== STATES.SCANNING) return;
        overlayEl = panel.querySelector("#ds-overlay");
        overlayCtx = overlayEl ? overlayEl.getContext("2d") : null;
        if (!detectCanvas) detectCanvas = document.createElement("canvas");

        const statusEl = panel.querySelector("#ds-cv-status");

        // Already loaded (e.g. re-entered scanning) — just (re)start the loop.
        if (cv && scanner) {
            if (statusEl) statusEl.hidden = true;
            startDetectLoop();
            return;
        }

        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = "Loading scanner…";
        }

        // Token guards against an async load resolving after we've left scanning.
        const token = ++cvLoadToken;
        // Load sequentially, NOT concurrently: loadOpenCv() must fully resolve
        // before loadJscanify(). Calling both at once would run the loader's
        // runtime-ready wait twice before init and only resolve one of them.
        let readyCv = null;
        loadOpenCv()
            .then((c) => {
                readyCv = c;
                return loadJscanify();
            })
            .then((Jscanify) => {
                if (token !== cvLoadToken || state !== STATES.SCANNING) return;
                cv = readyCv;
                scanner = new Jscanify();
                const el = panel && panel.querySelector("#ds-cv-status");
                if (el) el.hidden = true;
                startDetectLoop();
            })
            .catch((err) => {
                console.error("doc-scanner: failed to load CV stack", err);
                if (token !== cvLoadToken) return;
                const el = panel && panel.querySelector("#ds-cv-status");
                // Detection is a non-blocking aid — capture still works without it.
                if (el) {
                    el.hidden = false;
                    el.textContent = "Live border detection unavailable.";
                }
            });
    }

    function startDetectLoop() {
        if (detectRaf != null) return; // already running
        lastDetectAt = 0;
        detectRaf = requestAnimationFrame(detectTick);
    }

    function detectTick(now) {
        // Schedule the next frame first so an exception can't kill the loop.
        detectRaf = requestAnimationFrame(detectTick);

        if (!cv || !scanner || !videoEl || state !== STATES.SCANNING) return;
        // Throttle: only run a detection every DETECT_INTERVAL_MS.
        if (now - lastDetectAt < DETECT_INTERVAL_MS) return;
        lastDetectAt = now;

        const video = videoEl;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (video.readyState < 2 || !vw || !vh) return;

        // Detect on a downscaled frame for speed (longest side ~DETECT_MAX_SIDE).
        const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(vw, vh));
        const dw = Math.max(1, Math.round(vw * scale));
        const dh = Math.max(1, Math.round(vh * scale));
        if (detectCanvas.width !== dw) detectCanvas.width = dw;
        if (detectCanvas.height !== dh) detectCanvas.height = dh;
        const dctx = detectCanvas.getContext("2d");
        dctx.drawImage(video, 0, 0, dw, dh);

        let img = null;
        let contour = null;
        try {
            img = cv.imread(detectCanvas);
            contour = scanner.findPaperContour(img);
            const corners = contour ? scanner.getCornerPoints(contour) : null;
            if (corners && hasAllCorners(corners)) {
                // Map the downscaled corners back to full-resolution video coords
                // so the capture task can reuse them; keep the latest set around.
                const inv = 1 / scale;
                lastCorners = {
                    topLeftCorner: scalePoint(corners.topLeftCorner, inv),
                    topRightCorner: scalePoint(corners.topRightCorner, inv),
                    bottomRightCorner: scalePoint(corners.bottomRightCorner, inv),
                    bottomLeftCorner: scalePoint(corners.bottomLeftCorner, inv),
                };
                drawOverlay(lastCorners, vw, vh);
            } else {
                // No document this frame — clear, don't crash.
                lastCorners = null;
                clearOverlay();
            }
        } catch (e) {
            console.error("doc-scanner: detection error", e);
        } finally {
            // Free WASM-backed Mats every iteration to avoid memory growth.
            if (contour) { try { contour.delete(); } catch (e) { /* ignore */ } }
            if (img) { try { img.delete(); } catch (e) { /* ignore */ } }
        }
    }

    function hasAllCorners(c) {
        return !!(c.topLeftCorner && c.topRightCorner && c.bottomRightCorner && c.bottomLeftCorner);
    }

    function scalePoint(p, factor) {
        return { x: p.x * factor, y: p.y * factor };
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

    // Stop the detection loop and release its DOM refs. CV Mats are freed each
    // iteration, and the loaded `cv`/`scanner` are cached (idempotent loader) so
    // re-entering scanning doesn't reload the WASM. Invalidate any in-flight load.
    function stopDetection() {
        cvLoadToken++;
        if (detectRaf != null) {
            cancelAnimationFrame(detectRaf);
            detectRaf = null;
        }
        clearOverlay();
        overlayEl = null;
        overlayCtx = null;
        lastCorners = null;
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
        <div class="ds-viewport">
          <div class="ds-viewport-placeholder muted">Captured page preview (coming soon)</div>
        </div>
        <div class="row">
          <button id="ds-accept" class="primary">Accept</button>
          <button id="ds-retake">Retake</button>
        </div>
      </div>
    `;
        panel.querySelector("#ds-accept").addEventListener("click", () => {
            // Placeholder page; later tasks store the warped+compressed image here.
            pages.push({ id: Date.now() + Math.random() });
            setState(STATES.PAGES);
        });
        panel.querySelector("#ds-retake").addEventListener("click", () => setState(STATES.SCANNING));
    }

    function renderPages() {
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
          <div class="ds-thumb-img muted">Page ${i + 1}</div>
          <button class="mini" data-act="delete">Delete</button>
        `;
                item.querySelector('[data-act="delete"]').addEventListener("click", () => {
                    // Later tasks revoke this page's object URL before removing it.
                    pages = pages.filter((p) => p !== page);
                    renderState();
                });
                thumbs.appendChild(item);
            });
        }

        panel.querySelector("#ds-add").addEventListener("click", () => setState(STATES.SCANNING));
        panel.querySelector("#ds-finish").addEventListener("click", () => {
            // Placeholder export: PDF assembly + Web Share / download arrives later.
            panel.querySelector("#ds-status").textContent =
                "Export (PDF + share) is implemented in a later step.";
        });
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

        // Guarantee the detection loop and camera are released on unmount,
        // regardless of which state we tear down from. Registered camera-first so
        // it runs last (teardown unwinds in reverse), i.e. loop stops first.
        registerTeardown(stopCamera);
        registerTeardown(stopDetection);

        renderState();

        container.appendChild(root);
    }

    function destroy() {
        runTeardown();
        pages = [];
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
