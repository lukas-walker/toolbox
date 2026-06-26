const HOME_ID = "__home";
const HOME_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

let activeTool = null;
let activationToken = 0;
let allTools = [];
let orderedTools = [];
let els = null;

export function initShell({ tools, groups }) {
    allTools = tools;
    orderedTools = orderToolsByGroup(tools, groups);

    els = {
        nav: document.getElementById("tool-nav"),
        main: document.getElementById("app-main"),
        crumb: document.getElementById("crumb"),
        search: document.getElementById("tool-search"),
        toggle: document.getElementById("nav-toggle"),
        scrim: document.getElementById("nav-scrim"),
        shell: document.querySelector(".app-shell"),
    };

    renderNav(groups);
    wireChrome();
    showHome();
}

function orderToolsByGroup(tools, groups) {
    const ordered = [];
    for (const group of groups) {
        for (const tool of tools) {
            if (tool.group === group) ordered.push(tool);
        }
    }
    // Append any tools whose group wasn't listed, so nothing silently disappears.
    for (const tool of tools) {
        if (!ordered.includes(tool)) ordered.push(tool);
    }
    return ordered;
}

/* ---------- Sidebar ---------- */

function renderNav(groups) {
    els.nav.innerHTML = "";
    els.nav.appendChild(navItem({ id: HOME_ID, label: "Home", icon: HOME_ICON }, showHome));

    for (const group of groups) {
        const groupTools = orderedTools.filter((t) => t.group === group);
        if (!groupTools.length) continue;

        const label = document.createElement("div");
        label.className = "nav-group-label";
        label.dataset.group = group;
        label.textContent = group;
        els.nav.appendChild(label);

        for (const tool of groupTools) {
            const item = navItem(tool, () => activateTool(tool));
            item.dataset.group = group;
            els.nav.appendChild(item);
        }
    }
}

function navItem(tool, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item";
    btn.dataset.toolId = tool.id;
    btn.innerHTML = `${tool.icon || ""}<span>${escapeHtml(tool.label)}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
}

function setActiveNav(id) {
    els.nav.querySelectorAll(".nav-item").forEach((b) =>
        b.classList.toggle("active", b.dataset.toolId === id)
    );
}

/* ---------- Views ---------- */

function showHome() {
    // Tear down any active tool and invalidate in-flight activations.
    if (activeTool?.destroy) {
        try { activeTool.destroy(); } catch (e) { console.error(e); }
    }
    activeTool = null;
    activationToken++;

    setActiveNav(HOME_ID);
    els.crumb.innerHTML = "<b>All tools</b>";

    els.main.innerHTML = "";
    els.main.appendChild(renderHome());

    closeNav();
    window.scrollTo(0, 0);
}

function renderHome() {
    const wrap = document.createElement("div");
    wrap.className = "home";

    const head = document.createElement("div");
    head.className = "home-head";
    head.innerHTML =
        "<h1>Toolbox</h1><p>Pick a tool. Everything runs locally in your browser — no uploads.</p>";
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "card-grid";
    for (const tool of orderedTools) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "tool-card";
        card.innerHTML =
            `<div class="chip">${tool.icon || ""}</div>` +
            `<div class="t-title">${escapeHtml(tool.label)}</div>` +
            `<div class="t-desc">${escapeHtml(tool.desc || "")}</div>`;
        card.addEventListener("click", () => activateTool(tool));
        grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
}

async function activateTool(tool) {
    const myToken = ++activationToken;

    // teardown previous
    if (activeTool?.destroy) {
        try { activeTool.destroy(); } catch (e) { console.error(e); }
    }

    setActiveNav(tool.id);
    renderCrumb(tool);

    els.main.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "muted";
    loading.textContent = "Loading…";
    els.main.appendChild(loading);

    closeNav();
    window.scrollTo(0, 0);

    try {
        const maybePromise = tool.init(els.main);

        // If init is async, wait for it.
        if (maybePromise && typeof maybePromise.then === "function") {
            await maybePromise;
        }

        // If the user switched views while we were loading, abort final UI changes.
        if (myToken !== activationToken) return;

        // Tool likely rendered into container; remove loading if still present.
        if (loading.parentNode === els.main) {
            els.main.removeChild(loading);
        }

        activeTool = tool;
    } catch (e) {
        console.error(e);
        if (myToken !== activationToken) return;
        els.main.innerHTML = "";
        const err = document.createElement("div");
        err.className = "panel";
        err.innerHTML = `<b>Error:</b> ${escapeHtml(e?.message || String(e))}`;
        els.main.appendChild(err);
        activeTool = tool;
    }
}

function renderCrumb(tool) {
    els.crumb.innerHTML = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "back-link";
    back.textContent = "← All tools";
    back.addEventListener("click", showHome);

    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";

    const current = document.createElement("b");
    current.textContent = tool.label;

    els.crumb.append(back, sep, current);
}

/* ---------- Chrome: search + mobile drawer ---------- */

function wireChrome() {
    els.toggle?.addEventListener("click", () => toggleNav());
    els.scrim?.addEventListener("click", closeNav);
    els.search?.addEventListener("input", () => filterNav(els.search.value));
}

function filterNav(query) {
    const term = query.trim().toLowerCase();
    const groupsVisible = {};

    els.nav.querySelectorAll(".nav-item").forEach((b) => {
        if (b.dataset.toolId === HOME_ID) {
            b.style.display = term ? "none" : "";
            return;
        }
        const match = b.textContent.toLowerCase().includes(term);
        b.style.display = match ? "" : "none";
        if (match) groupsVisible[b.dataset.group] = true;
    });

    els.nav.querySelectorAll(".nav-group-label").forEach((l) => {
        l.style.display = !term || groupsVisible[l.dataset.group] ? "" : "none";
    });
}

function toggleNav(force) {
    const open =
        force === undefined ? !els.shell.classList.contains("nav-open") : force;
    els.shell.classList.toggle("nav-open", open);
}

function closeNav() {
    els.shell.classList.remove("nav-open");
}

function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
