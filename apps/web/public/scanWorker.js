/*
 * Document scanner detection worker.
 *
 * OpenCV.js is a ~9 MB build with the WASM embedded; importing/compiling it and
 * running per-frame contour detection are heavy, synchronous operations. Doing
 * that on the main thread freezes the whole page (the UI locks up while the feed
 * keeps streaming). This worker runs the entire CV stack off the main thread so
 * the page stays responsive: it loads OpenCV.js + jscanify via importScripts
 * (same-origin, precached) and processes one downscaled frame at a time, posting
 * back the detected document corners.
 *
 * Protocol (main thread -> worker):
 *   { type: "init", opencvUrl, jscanifyUrl }
 *   { type: "frame", frameId, width, height, buffer }   // buffer = RGBA ImageData, transferred
 *   { type: "warp", jobId, width, height, buffer, corners, outWidth, outHeight }
 *       // buffer = full-res RGBA ImageData (transferred); corners = full-res quad
 * Worker -> main thread:
 *   { type: "ready" }
 *   { type: "error", error }
 *   { type: "result", frameId, width, height, corners|null }
 *   { type: "warpResult", jobId, ok, width, height, buffer }   // buffer = warped RGBA, transferred
 *   { type: "warpResult", jobId, ok: false, error }
 */

let cvReady = false;
let scanner = null;
// Only ever keep the most recent frame: if frames pile up faster than we can
// process them, drop the stale ones instead of building a backlog.
let pendingFrame = null;
let processing = false;

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "init") {
        init(msg.opencvUrl, msg.jscanifyUrl);
    } else if (msg.type === "frame") {
        pendingFrame = msg;
        processPending();
    } else if (msg.type === "warp") {
        warp(msg);
    }
};

function init(opencvUrl, jscanifyUrl) {
    try {
        importScripts(opencvUrl);
    } catch (err) {
        self.postMessage({ type: "error", error: "opencv import failed: " + (err && err.message || err) });
        return;
    }

    const onReady = () => {
        try {
            importScripts(jscanifyUrl);
            if (typeof self.jscanify !== "function") {
                throw new Error("jscanify global missing after import");
            }
            scanner = new self.jscanify();
            cvReady = true;
            self.postMessage({ type: "ready" });
            processPending();
        } catch (err) {
            self.postMessage({ type: "error", error: "jscanify init failed: " + (err && err.message || err) });
        }
    };

    const cv = self.cv;
    if (!cv) {
        self.postMessage({ type: "error", error: "cv global missing after import" });
        return;
    }
    // OpenCV.js may expose `cv` as a thenable, an already-initialized object, or
    // an object that signals readiness via onRuntimeInitialized.
    if (typeof cv.then === "function") {
        cv.then((mod) => {
            self.cv = mod;
            if (typeof mod.Mat === "function") onReady();
            else mod.onRuntimeInitialized = onReady;
        });
    } else if (typeof cv.Mat === "function") {
        onReady();
    } else {
        cv.onRuntimeInitialized = onReady;
    }
}

function processPending() {
    if (!cvReady || processing || !pendingFrame) return;
    processing = true;

    const job = pendingFrame;
    pendingFrame = null;
    const cv = self.cv;
    const { frameId, width, height, buffer } = job;

    let img = null;
    let contour = null;
    let corners = null;
    try {
        const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
        img = cv.matFromImageData(imageData);
        contour = scanner.findPaperContour(img);
        if (contour) {
            const c = scanner.getCornerPoints(contour);
            if (c && c.topLeftCorner && c.topRightCorner && c.bottomLeftCorner && c.bottomRightCorner) {
                // Plain {x,y} objects so they post cleanly across the boundary.
                corners = {
                    topLeftCorner: { x: c.topLeftCorner.x, y: c.topLeftCorner.y },
                    topRightCorner: { x: c.topRightCorner.x, y: c.topRightCorner.y },
                    bottomRightCorner: { x: c.bottomRightCorner.x, y: c.bottomRightCorner.y },
                    bottomLeftCorner: { x: c.bottomLeftCorner.x, y: c.bottomLeftCorner.y },
                };
            }
        }
    } catch (err) {
        // Skip this frame; don't crash the loop.
        corners = null;
    } finally {
        // Free WASM-backed Mats every iteration to avoid memory growth.
        if (contour) { try { contour.delete(); } catch (e) { /* ignore */ } }
        if (img) { try { img.delete(); } catch (e) { /* ignore */ } }
    }

    self.postMessage({ type: "result", frameId, width, height, corners });
    processing = false;
    // A newer frame may have arrived while we were busy.
    processPending();
}

// One-shot perspective warp of a captured full-resolution frame. The corner
// quad (in full-res coords) and the desired output size are supplied by the
// main thread; we just run getPerspectiveTransform + warpPerspective and post
// the deskewed RGBA pixels back. All Mats are freed before returning.
function warp(job) {
    const { jobId, width, height, buffer, corners, outWidth, outHeight } = job;
    if (!cvReady) {
        self.postMessage({ type: "warpResult", jobId, ok: false, error: "cv not ready" });
        return;
    }
    const cv = self.cv;
    let src = null;
    let srcTri = null;
    let dstTri = null;
    let M = null;
    let dst = null;
    try {
        const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
        src = cv.matFromImageData(imageData);

        const { topLeftCorner: tl, topRightCorner: tr, bottomRightCorner: br, bottomLeftCorner: bl } = corners;
        // srcTri and dstTri share the same TL, TR, BL, BR ordering.
        srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y]);
        dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outWidth, 0, 0, outHeight, outWidth, outHeight]);

        M = cv.getPerspectiveTransform(srcTri, dstTri);
        dst = new cv.Mat();
        cv.warpPerspective(
            src,
            dst,
            M,
            new cv.Size(outWidth, outHeight),
            cv.INTER_LINEAR,
            cv.BORDER_CONSTANT,
            // White, opaque fill for any pixels mapped outside the source.
            new cv.Scalar(255, 255, 255, 255)
        );

        // dst is CV_8UC4 (RGBA). Copy out of the WASM heap before freeing it.
        const out = new Uint8ClampedArray(dst.data);
        const outBuf = out.buffer;
        self.postMessage(
            { type: "warpResult", jobId, ok: true, width: outWidth, height: outHeight, buffer: outBuf },
            [outBuf]
        );
    } catch (err) {
        self.postMessage({ type: "warpResult", jobId, ok: false, error: (err && err.message) || String(err) });
    } finally {
        for (const m of [src, srcTri, dstTri, M, dst]) {
            if (m) { try { m.delete(); } catch (e) { /* ignore */ } }
        }
    }
}
