/**
 * Load an image File into an HTMLImageElement via object URL.
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
export async function loadImageElement(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.decoding = "async";
        img.loading = "eager";
        img.src = url;

        await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = (e) => reject(new Error("Failed to load image."));
        });

        return img;
    } finally {
        // We cannot revoke immediately before the image fully decodes in some browsers,
        // but after onload it is safe.
        URL.revokeObjectURL(url);
    }
}

/**
 * Re-encode an image file using canvas.
 * - If compress=false, returns original bytes.
 * - If compress=true, returns JPEG bytes at given quality (and optional max dimension).
 *
 * @param {File} file
 * @param {{ compress: boolean, quality: number, maxDim?: number }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function getImageBytesForPdf(file, opts) {
    const { compress, quality, maxDim } = opts;

    if (!compress) {
        return new Uint8Array(await file.arrayBuffer());
    }

    const img = await loadImageElement(file);

    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;

    if (maxDim && Number.isFinite(maxDim) && maxDim > 0) {
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas not supported.");

    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) => {
        canvas.toBlob(
            (b) => resolve(b),
            "image/jpeg",
            Math.min(1, Math.max(0.1, quality))
        );
    });

    if (!blob) throw new Error("Failed to encode image.");

    return new Uint8Array(await blob.arrayBuffer());
}
