let activeTool = null;
let activationToken = 0;

export function initShell({ tabsContainer, mainContainer, tools }) {
    tabsContainer.innerHTML = "";
    mainContainer.innerHTML = "";

    tools.forEach((tool, index) => {
        const btn = document.createElement("button");
        btn.textContent = tool.label;
        btn.dataset.toolId = tool.id;
        btn.className = "tool-tab";

        btn.addEventListener("click", () => {
            activateTool(tool, btn, tabsContainer, mainContainer);
        });

        tabsContainer.appendChild(btn);

        if (index === 0) {
            activateTool(tool, btn, tabsContainer, mainContainer);
        }
    });
}

async function activateTool(tool, btn, tabsContainer, mainContainer) {
    const myToken = ++activationToken;

    // teardown previous
    if (activeTool?.destroy) {
        try { activeTool.destroy(); } catch (e) { console.error(e); }
    }

    [...tabsContainer.children].forEach(b =>
        b.classList.toggle("active", b === btn)
    );

    mainContainer.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "muted";
    loading.textContent = "Loading…";
    mainContainer.appendChild(loading);

    try {
        const maybePromise = tool.init(mainContainer);

        // If init is async, wait for it.
        if (maybePromise && typeof maybePromise.then === "function") {
            await maybePromise;
        }

        // If the user switched tools while we were loading, abort any final UI changes.
        if (myToken !== activationToken) return;

        // Tool likely rendered into container; remove loading if still present.
        if (loading.parentNode === mainContainer) {
            mainContainer.removeChild(loading);
        }

        activeTool = tool;
    } catch (e) {
        console.error(e);
        mainContainer.innerHTML = "";
        const err = document.createElement("div");
        err.className = "panel";
        err.innerHTML = `<b>Error:</b> ${escapeHtml(e?.message || String(e))}`;
        mainContainer.appendChild(err);
        activeTool = tool;
    }
}

function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
