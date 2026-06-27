// Document scanner — pure, DOM-free logic.
//
// The capture state machine plus the testable geometry for the perspective
// warp (sub-issue #8) and the PDF assembly (sub-issue #10) live here,
// independent of the DOM, mirroring the other tools' logic.js. The raw OpenCV
// warp call itself runs in scanWorker.js (that is where `cv` lives), but the
// decisions it needs — the output size and the corner quad — are computed by
// the pure helpers below.

import { PDFDocument } from "pdf-lib";

/** The capture states the tool can be in. */
export const STATES = Object.freeze({
    IDLE: "idle",
    SCANNING: "scanning",
    REVIEW: "review",
    PAGES: "pages",
});

// Allowed forward/backward transitions between states.
//   idle    → scanning
//   scanning→ review        (capture)
//           → idle          (cancel, no pages yet)
//           → pages         (back, pages already captured)
//   review  → scanning      (retake)
//           → pages         (accept)
//   pages   → scanning      (add more pages)
// Export is an action triggered from `pages`, not a separate render state.
const TRANSITIONS = Object.freeze({
    [STATES.IDLE]: [STATES.SCANNING],
    [STATES.SCANNING]: [STATES.REVIEW, STATES.IDLE, STATES.PAGES],
    [STATES.REVIEW]: [STATES.SCANNING, STATES.PAGES],
    [STATES.PAGES]: [STATES.SCANNING],
});

/**
 * Whether moving from `from` to `to` is a legal transition.
 * Re-entering the same state is always allowed (re-render).
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
    if (from === to) return true;
    return (TRANSITIONS[from] || []).includes(to);
}

/**
 * The states reachable from `from`.
 * @param {string} from
 * @returns {string[]}
 */
export function nextStates(from) {
    return (TRANSITIONS[from] || []).slice();
}

// --- Perspective warp geometry (sub-issue #8) --------------------------------

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ topLeftCorner: Point, topRightCorner: Point, bottomRightCorner: Point, bottomLeftCorner: Point }} Quad */

/**
 * Output pixel size for a perspective-corrected document, given its detected
 * corner quad. Preserves the corrected aspect ratio by taking the longer of
 * each opposing edge pair, then caps the longest side to `maxSide` so the
 * exported page never balloons past a reasonable resolution.
 *
 * Pure and DOM-free — unit-testable on its own.
 * @param {Quad} corners
 * @param {number} maxSide longest output side cap, in px
 * @returns {{ width: number, height: number }}
 */
export function quadOutputSize(corners, maxSide) {
    const { topLeftCorner: tl, topRightCorner: tr, bottomRightCorner: br, bottomLeftCorner: bl } = corners;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (Number.isFinite(maxSide) && maxSide > 0) {
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
    }
    return { width: w, height: h };
}

/**
 * The four corners of the whole frame, in the canonical TL/TR/BR/BL shape the
 * scanner uses everywhere. Serves as the fallback "quad" when no document was
 * detected — warping it is effectively just a resize of the full frame.
 * @param {number} width
 * @param {number} height
 * @returns {Quad}
 */
export function fullFrameCorners(width, height) {
    return {
        topLeftCorner: { x: 0, y: 0 },
        topRightCorner: { x: width, y: 0 },
        bottomRightCorner: { x: width, y: height },
        bottomLeftCorner: { x: 0, y: height },
    };
}

// --- PDF assembly (sub-issue #10) --------------------------------------------

/**
 * Build a single multi-page PDF from the captured pages, one image per page,
 * each page sized to its image (mirrors image-to-pdf/logic.js). Pages are
 * lossless PNG blobs from the capture pipeline (shared/image.js), so we embed
 * them directly with embedPng — no lossy re-encode here. Capture order is
 * preserved.
 *
 * Kept DOM-free so it is unit-testable on its own.
 * @param {Blob[]} pageBlobs PNG blobs, in page order
 * @returns {Promise<Blob>} the assembled PDF
 */
export async function buildScanPdf(pageBlobs) {
    if (!pageBlobs?.length) throw new Error("No pages to export.");

    const out = await PDFDocument.create();
    for (const blob of pageBlobs) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = await out.embedPng(bytes);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const outBytes = await out.save();
    return new Blob([outBytes], { type: "application/pdf" });
}

/**
 * A filesystem-safe timestamp for the exported file name, e.g.
 * `20260626-184501`.
 * @param {Date} [now]
 * @returns {string}
 */
export function pdfTimestamp(now = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
        `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
        `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    );
}
