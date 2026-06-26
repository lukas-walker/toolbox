import { createPdfCombineTool } from "./pdf-combine/tool.js";
import { createPdfSplitTool } from "./pdf-split/tool.js";
import { createImageToPdfTool } from "./image-to-pdf/tool.js";
import { createPdfCompressAdvancedTool } from "./pdf-compress-advanced/tool.js";
import {createQrTool} from "./qr/tool.js";
import { createDocScannerTool } from "./doc-scanner/tool.js";

// Presentation metadata for the navigation shell (sidebar + launcher home).
// Each tool's own logic and labels live in its tool.js; here we only attach a
// category, an icon, and a short description. Descriptions reuse each tool's
// existing intro copy so no new wording is introduced.
const ICONS = {
    split:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/></svg>',
    combine:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="12" height="12" rx="2"/><path d="M9 21h10a2 2 0 0 0 2-2V9"/></svg>',
    image:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>',
    compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 15v4a1 1 0 0 1-1 1h-4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M9 9l6 6M15 9l-6 6"/></svg>',
    scan:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/></svg>',
    qr:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v0M17 21h4v-4M21 21v0"/></svg>',
};

const META = {
    "pdf-split":              { group: "PDF",        icon: ICONS.split,    desc: "Extract a page range from a PDF and download it as a new file." },
    "pdf-combine":            { group: "PDF",        icon: ICONS.combine,  desc: "Select multiple PDF files. They will be merged in the selected order." },
    "image-to-pdf":           { group: "PDF",        icon: ICONS.image,    desc: "Add images, PDFs, or take a photo. Everything stays on your device." },
    "pdf-compress-advanced":  { group: "PDF",        icon: ICONS.compress, desc: "Coming soon: stronger PDF compression using a WASM engine, locally in your browser." },
    "doc-scanner":            { group: "Capture",    icon: ICONS.scan,     desc: "Scan documents with your camera and export a PDF — 100% on your device." },
    "qr":                     { group: "Generators", icon: ICONS.qr,       desc: "Generate an SVG QR code locally. Download as SVG or PNG." },
};

// Order categories appear in the sidebar and on the launcher home.
export const groupOrder = ["PDF", "Capture", "Generators"];

const baseTools = [
    createPdfCombineTool(),
    createPdfSplitTool(),
    createImageToPdfTool(),
    createPdfCompressAdvancedTool(),
    createQrTool(),
    createDocScannerTool()
];

export const tools = baseTools.map((tool) => Object.assign(tool, META[tool.id]));
