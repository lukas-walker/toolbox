export function createPdfCompressAdvancedTool() {
    let root = null;

    function render(container) {
        root = document.createElement("div");
        root.className = "tool";

        root.innerHTML = `
      <h1>Compress PDF (Advanced)</h1>
      <p>Coming soon: stronger PDF compression using a WASM engine (Ghostscript) running locally in your browser.</p>

      <div class="panel">
        <div class="muted">
          Standard mode compression is available in <b>Image to PDF</b> (optional JPEG re-encode and downscaling).
        </div>
        <div class="muted" style="margin-top:10px;">
          Advanced mode will be opt-in and loaded only when you open this tab.
        </div>
      </div>
    `;

        container.appendChild(root);
    }

    function destroy() {
        root = null;
    }

    return {
        id: "pdf-compress-advanced",
        label: "Compress PDF (Advanced)",
        init: render,
        destroy
    };
}
