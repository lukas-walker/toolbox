import { mergePdfFiles } from "./logic.js";
import { downloadBlob } from "../../shared/download.js";

export function createPdfCombineTool() {
    let files = [];
    let root = null;

    function render(container) {
        root = document.createElement("div");
        root.className = "tool";

        root.innerHTML = `
      <h1>Combine PDFs</h1>
      <p>Select multiple PDF files. They will be merged in the selected order.</p>

      <div class="panel">
        <div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Drop PDF files here or click to select">
          <div class="dropzone-title">Drag & drop PDFs here</div>
          <div class="dropzone-sub">or click to choose files</div>
          <input id="pdf-input" class="dropzone-input" type="file" accept="application/pdf" multiple />
        </div>

        <div class="row">
          <button id="merge-btn" class="primary" disabled>Merge & Download</button>
          <button id="clear-btn" disabled>Clear</button>
        </div>

        <div id="file-list" class="file-list"></div>
        <div id="status" class="status"></div>
      </div>
    `;

        const dropzone = root.querySelector("#dropzone");
        const input = root.querySelector("#pdf-input");
        const mergeBtn = root.querySelector("#merge-btn");
        const clearBtn = root.querySelector("#clear-btn");
        const list = root.querySelector("#file-list");
        const status = root.querySelector("#status");

        function setStatus(msg) {
            status.textContent = msg || "";
        }

        function isPdfFile(f) {
            // Some browsers may not set type reliably, so also check extension
            const nameOk = (f.name || "").toLowerCase().endsWith(".pdf");
            const typeOk = f.type === "application/pdf";
            return typeOk || nameOk;
        }

        function addFiles(newFiles) {
            const onlyPdf = newFiles.filter(isPdfFile);
            if (!onlyPdf.length) {
                setStatus("No PDF files detected.");
                updateUI();
                return;
            }

            // Append to existing selection (useful for multiple drags)
            files = files.concat(onlyPdf);
            setStatus("");
            updateUI();
        }

        function updateUI() {
            list.innerHTML = "";
            if (!files.length) {
                list.innerHTML = `<div class="muted">No files selected.</div>`;
            } else {
                const ul = document.createElement("ul");
                files.forEach((f, i) => {
                    const li = document.createElement("li");
                    li.textContent = `${i + 1}. ${f.name} (${Math.round(f.size / 1024)} KB)`;
                    ul.appendChild(li);
                });
                list.appendChild(ul);
            }

            mergeBtn.disabled = files.length < 2;
            clearBtn.disabled = files.length === 0;
        }

        // Click on dropzone triggers file input
        dropzone.addEventListener("click", () => input.click());
        dropzone.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                input.click();
            }
        });

        // Standard file picker
        input.addEventListener("change", () => {
            addFiles(Array.from(input.files || []));
            // reset input so selecting same file again still triggers change
            input.value = "";
        });

        // Drag & drop
        const prevent = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ["dragenter", "dragover"].forEach(evt => {
            dropzone.addEventListener(evt, (e) => {
                prevent(e);
                dropzone.classList.add("dragover");
            });
        });

        ["dragleave", "drop"].forEach(evt => {
            dropzone.addEventListener(evt, (e) => {
                prevent(e);
                dropzone.classList.remove("dragover");
            });
        });

        dropzone.addEventListener("drop", (e) => {
            const dt = e.dataTransfer;
            const dropped = Array.from(dt?.files || []);
            addFiles(dropped);
        });

        clearBtn.addEventListener("click", () => {
            files = [];
            setStatus("");
            updateUI();
        });

        mergeBtn.addEventListener("click", async () => {
            try {
                mergeBtn.disabled = true;
                clearBtn.disabled = true;
                setStatus("Merging…");

                const blob = await mergePdfFiles(files);
                const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                downloadBlob(blob, `combined-${ts}.pdf`);

                setStatus("Done. Download started.");
            } catch (e) {
                console.error(e);
                setStatus(`Error: ${e?.message || e}`);
            } finally {
                updateUI();
            }
        });

        updateUI();
        container.appendChild(root);
    }

    function destroy() {
        // Nothing special yet; placeholder for future cleanup.
        root = null;
    }

    return {
        id: "pdf-combine",
        label: "Combine",
        init: render,
        destroy
    };
}