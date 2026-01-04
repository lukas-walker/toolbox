import { downloadBlob } from "../../shared/download.js";
import { getPdfPageCount, splitPdfRange } from "./logic.js";

export function createPdfSplitTool() {
    let file = null;
    let pageCount = 0;
    let root = null;

    function render(container) {
        root = document.createElement("div");
        root.className = "tool";

        root.innerHTML = `
      <h1>Split PDF</h1>
      <p>Extract a page range from a PDF and download it as a new file.</p>

      <div class="panel">
        <div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Drop a PDF here or click to select">
          <div class="dropzone-title">Drag & drop a PDF here</div>
          <div class="dropzone-sub">or click to choose a file</div>
          <input id="pdf-input" class="dropzone-input" type="file" accept="application/pdf" />
        </div>

        <div class="row" style="align-items:center;">
          <label>
            From
            <input id="from-page" type="number" min="1" value="1" style="width:6em; margin-left:6px;" disabled />
          </label>

          <label>
            To
            <input id="to-page" type="number" min="1" value="1" style="width:6em; margin-left:6px;" disabled />
          </label>

          <span id="meta" class="muted"></span>
        </div>

        <div class="row">
          <button id="split-btn" class="primary" disabled>Extract & Download</button>
          <button id="clear-btn" disabled>Clear</button>
        </div>

        <div id="status" class="status"></div>
      </div>
    `;

        const dropzone = root.querySelector("#dropzone");
        const input = root.querySelector("#pdf-input");
        const fromInput = root.querySelector("#from-page");
        const toInput = root.querySelector("#to-page");
        const meta = root.querySelector("#meta");
        const splitBtn = root.querySelector("#split-btn");
        const clearBtn = root.querySelector("#clear-btn");
        const status = root.querySelector("#status");

        function setStatus(msg) {
            status.textContent = msg || "";
        }

        function isPdfFile(f) {
            const nameOk = (f.name || "").toLowerCase().endsWith(".pdf");
            const typeOk = f.type === "application/pdf";
            return typeOk || nameOk;
        }

        async function setFile(newFile) {
            file = newFile || null;
            pageCount = 0;
            setStatus("");

            if (!file) {
                meta.textContent = "";
                fromInput.disabled = true;
                toInput.disabled = true;
                splitBtn.disabled = true;
                clearBtn.disabled = true;
                return;
            }

            setStatus("Reading PDF…");
            pageCount = await getPdfPageCount(file);

            meta.textContent = `${file.name} • ${pageCount} page(s)`;
            fromInput.disabled = false;
            toInput.disabled = false;
            fromInput.max = String(pageCount);
            toInput.max = String(pageCount);

            fromInput.value = "1";
            toInput.value = String(pageCount);

            clearBtn.disabled = false;
            splitBtn.disabled = false;
            setStatus("");
        }

        // Click / keyboard opens file picker
        dropzone.addEventListener("click", () => input.click());
        dropzone.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                input.click();
            }
        });

        // File picker
        input.addEventListener("change", async () => {
            const picked = Array.from(input.files || [])[0];
            input.value = "";
            if (picked && !isPdfFile(picked)) {
                setStatus("Please select a PDF file.");
                return;
            }
            try {
                await setFile(picked || null);
            } catch (e) {
                console.error(e);
                setStatus(`Error: ${e?.message || e}`);
            }
        });

        // Drag & drop behavior
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

        dropzone.addEventListener("drop", async (e) => {
            const dropped = Array.from(e.dataTransfer?.files || []);
            const picked = dropped[0];
            if (picked && !isPdfFile(picked)) {
                setStatus("Please drop a PDF file.");
                return;
            }
            try {
                await setFile(picked || null);
            } catch (err) {
                console.error(err);
                setStatus(`Error: ${err?.message || err}`);
            }
        });

        clearBtn.addEventListener("click", () => {
            setFile(null);
        });

        splitBtn.addEventListener("click", async () => {
            try {
                if (!file) return;

                splitBtn.disabled = true;
                clearBtn.disabled = true;
                setStatus("Extracting…");

                const from = Number(fromInput.value);
                const to = Number(toInput.value);

                const blob = await splitPdfRange(file, from, to);
                const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                downloadBlob(blob, `split-${from}-${to}-${ts}.pdf`);

                setStatus("Done. Download started.");
            } catch (e) {
                console.error(e);
                setStatus(`Error: ${e?.message || e}`);
            } finally {
                splitBtn.disabled = false;
                clearBtn.disabled = !file;
            }
        });

        container.appendChild(root);
    }

    function destroy() {
        root = null;
    }

    return {
        id: "pdf-split",
        label: "Split",
        init: render,
        destroy
    };
}
