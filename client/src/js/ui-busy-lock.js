let lockCount = 0;

function ensureOverlay() {
    let overlay = document.getElementById("globalUiBusyOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "globalUiBusyOverlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(255, 255, 255, 0.55)";
    overlay.style.backdropFilter = "blur(1px)";
    overlay.style.zIndex = "9999";
    overlay.style.display = "none";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.pointerEvents = "all";
    overlay.innerHTML = '<div style="background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e5e7eb;font-size:12px;color:#374151;">Updating metadata...</div>';
    document.body.appendChild(overlay);
    return overlay;
}

function setBusy(locked) {
    const overlay = ensureOverlay();
    overlay.style.display = locked ? "flex" : "none";
}

export async function withInteractionLock(task) {
    lockCount += 1;
    setBusy(true);
    try {
        return await task();
    } finally {
        lockCount = Math.max(0, lockCount - 1);
        if (lockCount === 0) setBusy(false);
    }
}
