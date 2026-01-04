import { PDFDocument } from "pdf-lib";
import { getImageBytesForPdf } from "../../shared/image.js";

/**
 * Build a PDF from a mixed list of inputs:
 * - Images (jpeg/png/etc.) -> new pages (optionally compressed)
 * - PDFs -> appended pages as-is
 *
 * @param {File[]} files
 * @param {{ compressImages: boolean, jpegQuality: number, maxDim: number }} opts
 * @returns {Promise<Blob>}
 */
export async function buildPdfFromFiles(files, opts) {
    const { compressImages, jpegQuality, maxDim } = opts;

    if (!files?.length) throw new Error("No files provided.");

    const out = await PDFDocument.create();

    for (const file of files) {
        const name = (file.name || "").toLowerCase();
        const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");

        if (isPdf) {
            const srcBytes = await file.arrayBuffer();
            const src = await PDFDocument.load(srcBytes);
            const pages = await out.copyPages(src, src.getPageIndices());
            pages.forEach(p => out.addPage(p));
            continue;
        }

        // Treat everything else as image; we will fail gracefully if decode fails.
        const bytes = await getImageBytesForPdf(file, {
            compress: !!compressImages,
            quality: jpegQuality,
            maxDim
        });

        // If we compressed, it's JPEG bytes. If not, might be PNG/JPEG/etc.
        // pdf-lib supports embedJpg and embedPng; for other formats we rely on
        // the compress path (JPEG) or the file being PNG/JPEG.
        let img;
        if (compressImages || file.type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            img = await out.embedJpg(bytes);
        } else if (file.type === "image/png" || name.endsWith(".png")) {
            img = await out.embedPng(bytes);
        } else {
            // Fallback: if not JPEG/PNG, force JPEG encode via compression settings
            const forced = await getImageBytesForPdf(file, {
                compress: true,
                quality: jpegQuality,
                maxDim
            });
            img = await out.embedJpg(forced);
        }

        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const outBytes = await out.save();
    return new Blob([outBytes], { type: "application/pdf" });
}
