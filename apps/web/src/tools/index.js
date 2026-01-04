import { createPdfCombineTool } from "./pdf-combine/tool.js";
import { createPdfSplitTool } from "./pdf-split/tool.js";
import { createImageToPdfTool } from "./image-to-pdf/tool.js";
import { createPdfCompressAdvancedTool } from "./pdf-compress-advanced/tool.js";
import {createQrTool} from "./qr/tool.js";

export const tools = [
    createPdfCombineTool(),
    createPdfSplitTool(),
    createImageToPdfTool(),
    createPdfCompressAdvancedTool(),
    createQrTool()
];
