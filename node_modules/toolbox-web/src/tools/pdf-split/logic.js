import { PDFDocument } from "pdf-lib";

/**
 * Extract a page range (1-based, inclusive) from a PDF file.
 * @param {File} file
 * @param {number} fromPage 1-based
 * @param {number} toPage 1-based
 * @returns {Promise<Blob>}
 */
export async function splitPdfRange(file, fromPage, toPage) {
    if (!file) throw new Error("No PDF file provided.");

    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);

    const total = src.getPageCount();
    const from = Number(fromPage);
    const to = Number(toPage);

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Invalid page numbers.");
    }
    if (from < 1 || to < 1 || from > total || to > total) {
        throw new Error(`Page range must be within 1 and ${total}.`);
    }
    if (from > to) {
        throw new Error("From page must be less than or equal to To page.");
    }

    const out = await PDFDocument.create();
    const indices = [];
    for (let i = from - 1; i <= to - 1; i++) indices.push(i);

    const pages = await out.copyPages(src, indices);
    pages.forEach(p => out.addPage(p));

    const outBytes = await out.save();
    return new Blob([outBytes], { type: "application/pdf" });
}

/**
 * Quick page count helper so UI can set defaults/limits.
 * @param {File} file
 * @returns {Promise<number>}
 */
export async function getPdfPageCount(file) {
    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    return src.getPageCount();
}
