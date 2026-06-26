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
 * Worker -> main thread:
 *   { type: "ready" }
 *   { type: "error", error }
 *   { type: "result", frameId, width, height, corners|null }
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
