import { initShell } from "./tools/shell/shell.js";
import { tools } from "./tools/index.js";
import "./style.css";

document.addEventListener("DOMContentLoaded", () => {
    initShell({
        tabsContainer: document.getElementById("tool-tabs"),
        mainContainer: document.getElementById("app-main"),
        tools
    });
});