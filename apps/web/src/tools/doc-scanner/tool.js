import { STATES, canTransition } from "./logic.js";

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
          <div class="ds-viewport-placeholder muted">Camera preview (coming soon)</div>
        </div>
        <div class="row">
          <button id="ds-capture" class="primary">Capture</button>
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
