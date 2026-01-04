import { loadScript } from "../../shared/loadScript.js";
import { downloadBlob } from "../../shared/download.js";

export function createQrTool() {
    let root = null;

    async function render(container) {
        root = document.createElement("div");
        root.className = "tool";

        root.innerHTML = `
      <h1>QR Code</h1>
      <p>Generate an SVG QR code locally. Download as SVG or PNG.</p>

      <div class="panel">
        <div class="row" style="align-items:center;">
          <label class="muted">Size
            <input id="in1" type="number" value="256" min="128" max="4096" step="64" style="width:7em; margin-left:6px;" />
          </label>

          <label class="muted">Padding
            <input id="in2" type="number" value="4" min="0" max="40" step="1" style="width:6em; margin-left:6px;" />
          </label>

          <label class="muted">ECL
            <select id="in4" style="margin-left:6px;">
              <option value="L">LOW</option>
              <option value="M" selected>MEDIUM</option>
              <option value="Q">QUARTILE</option>
              <option value="H">HIGH</option>
            </select>
          </label>

          <label class="muted" style="display:flex; align-items:center; gap:8px;">
            <input id="in5" type="checkbox" checked />
            Boost ECL
          </label>
        </div>

        <div class="row" style="align-items:center;">
          <label class="muted">Foreground
            <input id="in6" type="color" value="#000000" style="margin-left:6px;" />
          </label>

          <label class="muted">Background
            <input id="in7" type="color" value="#f2f4f8" style="margin-left:6px;" />
          </label>

          <label class="muted" style="display:flex; align-items:center; gap:8px;">
            <input id="in8" type="checkbox" />
            Background opaque
          </label>

          <label class="muted" style="display:flex; align-items:center; gap:8px;">
            <input id="in9" type="checkbox" checked />
            Optimize SVG size
          </label>
        </div>

        <div class="row">
          <textarea id="msg" rows="4" style="width:100%; padding:10px; border-radius:12px; border:1px solid var(--border);"></textarea>
        </div>

        <div class="row">
          <button id="dl-svg" class="primary">Download SVG</button>
          <button id="dl-png">Download PNG</button>
          <span id="status" class="muted"></span>
        </div>

        <div class="row" style="justify-content:center;">
          <div id="box" style="width:100%; min-height:320px; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid var(--border); border-radius:14px; padding:14px;"></div>
        </div>

        <div class="muted" style="margin-top:10px;">
          Implementation based on qrcode-svg. The generator runs fully locally in your browser.
        </div>
      </div>
    `;

        container.appendChild(root);

        // Load QR generator script (global QRCode function)
        await loadScript(`${import.meta.env.BASE_URL}vendor/qrcode.min.js`);
        if (typeof window.QRCode !== "function") {
            throw new Error("QRCode() not found. Check /public/vendor/qrcode.min.js");
        }

        initQrApp(root);
    }

    function destroy() {
        if (root) root.innerHTML = "";
        root = null;
    }

    return {
        id: "qr",
        label: "QR Code",
        init: render,
        destroy
    };
}

function initQrApp(root) {
    const box = root.querySelector("#box");
    const txt = root.querySelector("#msg");

    const in1 = root.querySelector("#in1");
    const in2 = root.querySelector("#in2");
    const in4 = root.querySelector("#in4");
    const in5 = root.querySelector("#in5");
    const in6 = root.querySelector("#in6");
    const in7 = root.querySelector("#in7");
    const in8 = root.querySelector("#in8");
    const in9 = root.querySelector("#in9");

    const dlSvgBtn = root.querySelector("#dl-svg");
    const dlPngBtn = root.querySelector("#dl-png");
    const status = root.querySelector("#status");

    function setStatus(msg) {
        status.textContent = msg || "";
    }

    function clear(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    function filenameBase() {
        return `qrcode-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    }

    function getCurrentSvgMarkup() {
        // download "what was rendered"
        return box.innerHTML;
    }

    function downloadSvg(svgMarkup) {
        const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
        downloadBlob(blob, `${filenameBase()}.svg`);
    }

    async function downloadPngFromSvg(svgMarkup, pxSize) {
        // Render SVG to PNG via canvas.
        // We draw at pxSize x pxSize. If the SVG has explicit dimensions, use them if sensible.
        const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml" });
        const url = URL.createObjectURL(svgBlob);

        try {
            const img = new Image();
            img.decoding = "async";
            img.src = url;

            await new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("Failed to render SVG as image."));
            });

            const size = Math.max(128, Math.min(4096, Number(pxSize) || 512));
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;

            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas not supported.");

            // White background by default for PNG if background opaque is selected.
            // If not opaque, keep transparent.
            if (in8.checked) {
                ctx.fillStyle = in7.value || "#ffffff";
                ctx.fillRect(0, 0, size, size);
            } else {
                ctx.clearRect(0, 0, size, size);
            }

            ctx.drawImage(img, 0, 0, size, size);

            const pngBlob = await new Promise((resolve) => {
                canvas.toBlob((b) => resolve(b), "image/png");
            });

            if (!pngBlob) throw new Error("Failed to encode PNG.");
            downloadBlob(pngBlob, `${filenameBase()}.png`);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function update() {
        clear(box);

        const data = {
            msg: txt.value,
            dim: in1.value | 0,
            pad: in2.value | 0,
            ecl: in4.value,
            ecb: in5.checked | 0,
            pal: [in6.value, (in8.checked | 0) && in7.value],
            vrb: in9.checked ? 0 : 1
        };

        const svg = window.QRCode(data);
        box.appendChild(svg);

        svg.style.maxWidth = "100%";
        svg.style.maxHeight = "100%";

        // Keep as optional shortcut, but no longer required UX
        svg.style.cursor = "pointer";
        svg.onclick = () => downloadSvg(getCurrentSvgMarkup());
    }

    dlSvgBtn.addEventListener("click", () => {
        try {
            setStatus("");
            downloadSvg(getCurrentSvgMarkup());
        } catch (e) {
            console.error(e);
            setStatus(`Error: ${e?.message || e}`);
        }
    });

    dlPngBtn.addEventListener("click", async () => {
        try {
            setStatus("Rendering PNG…");
            const svgMarkup = getCurrentSvgMarkup();
            await downloadPngFromSvg(svgMarkup, in1.value);
            setStatus("");
        } catch (e) {
            console.error(e);
            setStatus(`Error: ${e?.message || e}`);
        }
    });

    txt.value = "Your message here";
    [in1, in2, in4, in5, in6, in7, in8, in9].forEach(el => {
        el.addEventListener("change", update);
        el.addEventListener("input", update);
    });
    txt.addEventListener("input", update);

    update();
}
