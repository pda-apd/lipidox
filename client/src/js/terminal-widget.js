import { DEFAULT_LOG_URL } from "./auth-gate.js";

let terminalTemplateCache = null;

async function loadTerminalTemplate() {
    if (terminalTemplateCache) return terminalTemplateCache;
    const response = await fetch("./terminal-widget.html");
    if (!response.ok) throw new Error(`Unable to load terminal widget template (HTTP ${response.status}).`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const style = doc.getElementById("terminal-widget-style");
    if (style && !document.getElementById("terminal-widget-style")) {
        document.head.appendChild(style.cloneNode(true));
    }
    const template = doc.getElementById("terminal-widget-template");
    if (!template) throw new Error("Terminal widget template is missing.");
    terminalTemplateCache = template;
    return terminalTemplateCache;
}

export async function mountTerminalWidget(options = {}) {
    const host = options.host;
    if (!host) throw new Error("Terminal widget host is required.");

    const template = await loadTerminalTemplate();
    // Dedupe: remove any terminal widget left over from a previous mount so we
    // never end up with two floating "Server Log" buttons on the page.
    const previous = document.body.querySelector(".sidebar-terminal-widget");
    if (previous) previous.remove();
    host.innerHTML = "";
    host.appendChild(template.content.cloneNode(true));

    const root = host.querySelector("[data-terminal-root]");
    const toggle = host.querySelector("[data-terminal-toggle]");
    const panel = host.querySelector("[data-terminal-panel]");
    const closeBtn = host.querySelector("[data-terminal-close]");
    const body = host.querySelector("[data-terminal-body]");
    const logUrl = options.logUrl || DEFAULT_LOG_URL;
    const headers = { "ngrok-skip-browser-warning": "true", ...(options.headers || {}) };

    // Re-parent the widget to <body> and force the floating-left layout so the
    // Server Log box lives on the topmost layer (position: fixed relative to the
    // viewport) and is never clipped or repositioned by a transformed ancestor
    // (e.g. the sidebar panel). This keeps it above all other UI regardless of
    // which host element the page used to mount it.
    root?.classList.add("is-floating-left");
    if (root && root.parentElement !== document.body) {
        document.body.appendChild(root);
    }

    let abortController = null;
    let reconnectTimer = null;

    const cleanupConnection = () => {
        if (reconnectTimer) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    };

    const appendLine = (message) => {
        if (!body) return;
        if (body.querySelector(".sidebar-terminal-placeholder")) {
            body.innerHTML = "";
        }
        const line = document.createElement("div");
        line.className = "sidebar-terminal-line";
        line.textContent = message;
        body.appendChild(line);
        while (body.children.length > 300) {
            body.removeChild(body.firstChild);
        }
        body.scrollTop = body.scrollHeight;
    };

    const scheduleReconnect = () => {
        if (!root?.classList.contains("open")) return;
        if (reconnectTimer) return;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectLogStream();
        }, 2500);
    };

    async function connectLogStream() {
        cleanupConnection();
        abortController = new AbortController();
        try {
            const response = await fetch(logUrl, {
                headers,
                signal: abortController.signal,
                cache: "no-store",
            });
            if (!response.ok || !response.body) {
                throw new Error(`HTTP ${response.status}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const message = line.slice(6);
                    if (!message || message === "[keepalive]") continue;
                    appendLine(message);
                }
            }
        } catch (error) {
            if (error?.name === "AbortError") return;
            appendLine(`[log-stream error] ${error?.message || error}`);
            scheduleReconnect();
        }
    }

    const closePanel = () => {
        root.classList.remove("open");
        cleanupConnection();
    };

    const openPanel = () => {
        root.classList.add("open");
        if (!abortController) connectLogStream();
    };

    toggle?.addEventListener("click", () => {
        if (root.classList.contains("open")) closePanel();
        else openPanel();
    });
    closeBtn?.addEventListener("click", closePanel);

    document.addEventListener("click", (event) => {
        if (!root.contains(event.target)) {
            closePanel();
        }
    });

    return {
        open: openPanel,
        close: closePanel,
        destroy: () => {
            cleanupConnection();
            host.innerHTML = "";
        },
        appendLine,
        elements: { root, toggle, panel, body },
    };
}
