import "./auth-gate.js";
import { db, auth } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { doc, getDoc } from "./firebase-config.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');

onAuthStateChanged(auth, async (user) => {
    if (user && projectId) {
        // --- LOGIC RENDER MENU TÀI KHOẢN ---
        if (document.getElementById("author-menu-drd")) {
            renderUserMenu(user);
        } else {
            window.addEventListener('headerLoaded', () => renderUserMenu(user));
        }

        await injectSidebar(user.uid);
        await initDashboard(user.uid);
        document.body.classList.add('loaded');
    }
});

function renderUserMenu(user) {
    const menu = document.getElementById("author-menu-drd");
    if (!menu) return;
    menu.innerHTML = `
        <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${user.email}</li>
        <li><button id="logout-btn" class="dropdown-item text-danger py-2">
            <i class="fa-solid fa-right-from-bracket me-2"></i> Logout
        </button></li>
    `;
    document.getElementById("logout-btn").onclick = async () => {
        await signOut(auth);
        window.location.href = "./index.html";
    };
}

async function injectSidebar(uid) {
    try {
        const resp = await fetch('sidebar.html');
        const html = await resp.text();
        document.getElementById('sidebar-placeholder').innerHTML = html;
        document.getElementById('sidebar-placeholder').querySelectorAll('script').forEach(old => { const s = document.createElement('script'); s.textContent = old.textContent; document.head.appendChild(s); });

        const btnBack = document.getElementById('btn-back-projects');
        if(btnBack) btnBack.href = `projectID.html?uid=${uid}`;

        document.querySelectorAll('#analysis-nav a').forEach(link => {
            const href = link.getAttribute('href');
            if (href && href !== '#') {
                link.href = `${href}?id=${projectId}&uid=${uid}`;
            }
        });

        const terminalHost = document.getElementById('sidebar-terminal-slot');
        if (terminalHost) {
            await mountTerminalWidget({ host: terminalHost });
        }
    } catch (e) { console.error("Sidebar load failed", e); }
}

async function initDashboard(uid) {
    const docSnap = await getDoc(doc(db, "projects", projectId));
    if (!docSnap.exists()) return;
    
    const data = docSnap.data();
    if (window.renderNormSummary) window.renderNormSummary(data.norm_settings, data.normality_stat);

    // ✅ Gợi ý phương pháp phân tích dựa trên Metadata (T-test vs ANOVA)
    if (data && data.meta_metadata) {
        const cat = data.meta_metadata.find(m => m.type === 'Categorical');
        if (cat) {
            const groups = [...new Set(cat.groups.filter(g => g && String(g).toLowerCase() !== 'nan'))];
            if (groups.length === 2) applyTag('link-ttest', 'Recommended');
            else if (groups.length > 2) applyTag('link-anova', 'Recommended');
        }
    }

    // ✅ Đồng bộ hóa toàn bộ Link trong Dashboard
    document.querySelectorAll('.ana-links a, .run-btn').forEach(link => {
        const href = link.getAttribute('href');
        if (href) link.href = `${href}?id=${projectId}&uid=${uid}`;
    });
}

function applyTag(id, msg) {
    const el = document.getElementById(id);
    if (el) {
        const span = document.createElement('span');
        span.className = 'recommend-tag shadow-sm';
        span.innerHTML = `<i class="fa-solid fa-star me-1 small"></i>${msg}`;
        el.appendChild(span);
    }
}