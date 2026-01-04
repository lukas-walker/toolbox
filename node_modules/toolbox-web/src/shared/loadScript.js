const loaded = new Map();

/**
 * Dynamically load a script exactly once.
 * @param {string} src
 * @returns {Promise<void>}
 */
export function loadScript(src) {
    if (loaded.has(src)) return loaded.get(src);

    const p = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(el);
    });

    loaded.set(src, p);
    return p;
}
