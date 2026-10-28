// src/js/header-loader.js
async function loadHeader() {
    const placeholder = document.getElementById('header-placeholder');
    if (!placeholder) return;

    try {
        const response = await fetch('./header.html');
        const html = await response.text();
        placeholder.innerHTML = html;
        fillAccountMenu();   // every page gets a populated Account menu
        window.dispatchEvent(new Event('headerLoaded'));
        console.log("[+] Header loaded successfully");
    } catch (error) {
        console.error("[-] Error loading header:", error);
    }
}

// Populate the Account dropdown from the stored session. Pages may render
// their own menu afterwards (same markup) — this guarantees the dropdown is
// never empty on pages that don't (was the "empty popup" bug).
function fillAccountMenu() {
    const menu = document.getElementById('author-menu-drd');
    if (!menu || menu.dataset.filled === "1") return;
    menu.dataset.filled = "1";

    let user = null;
    try { user = JSON.parse(localStorage.getItem('lipidportal_user')); } catch (_) {}

    if (user && user.id) {
        menu.innerHTML = `
            <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${escapeHtml(user.email || '')}</li>
            <li><a class="dropdown-item py-2" href="./projectID.html?uid=${user.id}"><i class="fa-solid fa-folder-open me-2"></i>My Projects</a></li>
            <li><hr class="dropdown-divider"></li>
            <li><button id="hdr-logout-btn" class="dropdown-item text-danger py-2"><i class="fa-solid fa-right-from-bracket me-2"></i>Sign Out</button></li>
        `;
        const btn = document.getElementById('hdr-logout-btn');
        if (btn) btn.onclick = () => {
            localStorage.removeItem('lipidportal_token');
            localStorage.removeItem('lipidportal_user');
            localStorage.removeItem('userSession');
            window.location.href = './index.html';
        };
    } else {
        menu.innerHTML = `
            <li><a class="dropdown-item py-2" href="./login.html"><i class="fa-solid fa-sign-in me-2"></i>Sign In</a></li>
            <li><a class="dropdown-item py-2" href="./register.html"><i class="fa-solid fa-user-plus me-2"></i>Sign Up</a></li>
        `;
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Chạy ngay khi file được load
loadHeader();
