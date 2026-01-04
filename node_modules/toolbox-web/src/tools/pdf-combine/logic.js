import { PDFDocument } from "pdf-lib";

/**
 * Merge multiple PDFs (in given order) into a single PDF blob.
 * @param {File[]} files
 * @returns {Promise<Blob>}
 */
export async function mergePdfFiles(files) {
    if (!files?.length) {
        throw new Error("No PDF files provided.");
    }

    const out = await PDFDocument.create();

    for (const file of files) {
        const bytes = await file.arrayBuffer();
        const src = await PDFDocument.load(bytes);

        const indices = src.getPageIndices();
        const pages = await out.copyPages(src, indices);
        for (const p of pages) out.addPage(p);
    }

    const outBytes = await out.save();
    return new Blob([outBytes], { type: "application/pdf" });
}