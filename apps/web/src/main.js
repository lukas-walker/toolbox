import { initShell } from "./tools/shell/shell.js";
import { tools, groupOrder } from "./tools/index.js";
import "./style.css";

document.addEventListener("DOMContentLoaded", () => {
    initShell({ tools, groups: groupOrder });
});
