import { downloadBlob } from "../../shared/download.js";
import { buildPdfFromFiles } from "./logic.js";

export function createImageToPdfTool() {
    let files = [];
    let root = null;

    function render(container) {
        root = document.createElement("div");
        root.className = "tool";

        root.innerHTML = `
      <h1>Image to PDF</h1>
      <p>Add images, PDFs, or take a photo. Everything stays on your device.</p>

      <div class="panel">
        <div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Drop files here or click to select">
          <div class="dropzone-title">Drag & drop files here</div>
          <div class="dropzone-sub">Images (JPG/PNG) and PDFs supported • click to choose</div>
        </div>

        <!-- Hidden inputs: we trigger these explicitly (prevents double-open) -->
        <input id="file-input" type="file" accept="image/*,application/pdf" multiple style="display:none;" />
        <input id="camera-input" type="file" accept="image/*" capture="environment" style="display:none;" />

        <div class="row">
          <button id="camera-btn">Take photo</button>
          <button id="build-btn" class="primary" disabled>Create PDF & Download</button>
          <button id="clear-btn" disabled>Clear</button>
        </div>

        <div class="panel" style="margin-top:12px;">
          <label style="display:flex; align-items:center; gap:8px;">
            <input id="compress" type="checkbox" />
            Compress images (JPEG)
          </label>

          <div class="row" style="align-items:center;">
            <label class="muted">
              Quality
              <input id="quality" type="number" min="0.1" max="1" step="0.05" value="0.80" style="width:6em; margin-left:6px;" disabled />
            </label>

            <label class="muted">
              Max dimension (px)
              <input id="maxdim" type="number" min="800" max="8000" step="100" value="2480" style="width:7em; margin-left:6px;" disabled />
            </label>

            <span class="muted">Tip: 2480px ≈ A4 @ 300 DPI width</span>
          </div>

          <div class="muted" style="margin-top:6px;">
            Note: PDFs you add are appended as-is in standard mode.
          </div>
        </div>

        <div id="file-list" class="file-list"></div>
        <div id="status" class="status"></div>
      </div>
    `;

        const dropzone = root.querySelector("#dropzone");
        const fileInput = root.querySelector("#file-input");
        const cameraInput = root.querySelector("#camera-input");

        const cameraBtn = root.querySelector("#camera-btn");
        const buildBtn = root.querySelector("#build-btn");
        const clearBtn = root.querySelector("#clear-btn");
        const list = root.querySelector("#file-list");
        const status = root.querySelector("#status");

        const compress = root.querySelector("#compress");
        const quality = root.querySelector("#quality");
        const maxdim = root.querySelector("#maxdim");

        function setStatus(msg) {
            status.textContent = msg || "";
        }

        function isPdfFile(f) {
            const nameOk = (f.name || "").toLowerCase().endsWith(".pdf");
            const typeOk = f.type === "application/pdf";
            return typeOk || nameOk;
        }

        function isImageFile(f) {
            return (f.type || "").startsWith("image/");
        }

        function addFiles(newFiles) {
            const accepted = newFiles.filter(f => isPdfFile(f) || isImageFile(f));
            if (!accepted.length) {
                setStatus("No supported files detected (use images or PDFs).");
                updateUI();
                return;
            }
            files = files.concat(accepted);
            setStatus("");
            updateUI();
        }

        function move(index, dir) {
            const j = index + dir;
            if (j < 0 || j >= files.length) return;
            const copy = files.slice();
            const tmp = copy[index];
            copy[index] = copy[j];
            copy[j] = tmp;
            files = copy;
            updateUI();
        }

        function removeAt(index) {
            files = files.filter((_, i) => i !== index);
            updateUI();
        }

        function updateUI() {
            list.innerHTML = "";

            if (!files.length) {
                list.innerHTML = `<div class="muted">No files selected.</div>`;
            } else {
                const table = document.createElement("div");
                table.className = "file-table";

                files.forEach((f, i) => {
                    const kind = isPdfFile(f) ? "PDF" : "IMG";
                    const row = document.createElement("div");
                    row.className = "file-row";

                    row.innerHTML = `
            <div class="file-meta">
              <div class="file-name">${escapeHtml(f.name || "camera.jpg")}</div>
              <div class="file-sub muted">[${kind}] ${Math.round((f.size || 0) / 1024)} KB</div>
            </div>
            <div class="file-actions">
              <button class="mini" data-act="up" ${i === 0 ? "disabled" : ""}>Up</button>
              <button class="mini" data-act="down" ${i === files.length - 1 ? "disabled" : ""}>Down</button>
              <button class="mini" data-act="remove">Remove</button>
            </div>
          `;

                    row.querySelectorAll("button").forEach(btn => {
                        btn.addEventListener("click", () => {
                            const act = btn.dataset.act;
                            if (act === "up") move(i, -1);
                            if (act === "down") move(i, 1);
                            if (act === "remove") removeAt(i);
                        });
                    });

                    table.appendChild(row);
                });

                list.appendChild(table);
            }

            buildBtn.disabled = files.length === 0;
            clearBtn.disabled = files.length === 0;

            quality.disabled = !compress.checked;
            maxdim.disabled = !compress.checked;
        }

        function openPicker() {
            // Prevent double-trigger behavior by only ever opening the hidden input.
            fileInput.click();
        }

        // Dropzone click/keyboard opens picker
        dropzone.addEventListener("click", openPicker);
        dropzone.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openPicker();
            }
        });

        // File picker selection
        fileInput.addEventListener("change", () => {
            addFiles(Array.from(fileInput.files || []));
            fileInput.value = "";
        });

        // Drag & drop
        const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
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
            const dropped = Array.from(e.dataTransfer?.files || []);
            addFiles(dropped);
        });

        compress.addEventListener("change", updateUI);

        clearBtn.addEventListener("click", () => {
            files = [];
            setStatus("");
            updateUI();
        });

        // Camera capture:
        // On mobile, this usually opens the camera UI. On desktop, it opens a file chooser.
        cameraBtn.addEventListener("click", () => {
            setStatus("");
            cameraInput.click();
        });

        cameraInput.addEventListener("change", () => {
            addFiles(Array.from(cameraInput.files || []));
            cameraInput.value = "";
        });

        buildBtn.addEventListener("click", async () => {
            try {
                buildBtn.disabled = true;
                clearBtn.disabled = true;
                setStatus("Building PDF…");

                const blob = await buildPdfFromFiles(files, {
                    compressImages: compress.checked,
                    jpegQuality: Number(quality.value || 0.8),
                    maxDim: Number(maxdim.value || 2480)
                });

                const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                downloadBlob(blob, `images-to-pdf-${ts}.pdf`);
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
        root = null;
    }

    return {
        id: "image-to-pdf",
        label: "Image to PDF",
        init: render,
        destroy
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
