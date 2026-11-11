// src/js/devtools-guard.js
// Deterrent only — the API is the trust boundary, not the browser.
// Blocks the usual devtools key bindings and the right-click menu.
(() => {
    const isDevtoolsShortcut = (e) => {
        const k = (e.key || "").toUpperCase();
        if (k === "F12") return true;
        if (e.ctrlKey && e.shiftKey && ["I", "J", "C", "K"].includes(k)) return true;
        if (e.metaKey && e.altKey && ["I", "J", "C"].includes(k)) return true;
        if (e.ctrlKey && !e.shiftKey && k === "U") return true; // view-source
        return false;
    };

    document.addEventListener("keydown", (e) => {
        if (isDevtoolsShortcut(e)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener("contextmenu", (e) => e.preventDefault());
})();
