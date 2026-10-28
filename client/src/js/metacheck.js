import "./auth-gate.js";
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { doc, onSnapshot, getDoc } from "./firebase-config.js";
import { vpsUrl } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');

let currentMetadata = [];
let activeFactor = "";
let bootstrapModals = {};

let metaChanges = {
    types: {},
    orders: {}
};

// --- QUẢN LÝ KHỞI TẠO VÀ AUTH ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (document.getElementById("author-menu-drd")) {
            initPage(user);
        } else {
            window.addEventListener('headerLoaded', () => initPage(user));
        }
    }
});

async function initPage(user) {
    if (!projectId) {
        window.location.href = "projectID.html";
        return;
    }

    renderUserMenu(user);
    bootstrapModals.order = new bootstrap.Modal(document.getElementById('modalOrder'));

    // Lắng nghe dữ liệu dự án
    onSnapshot(doc(db, "projects", projectId), async (docSnap) => {
        const data = docSnap.data();
        if (!data) return;

        if (data.status === "integrity_success") {
            triggerMetaCheck(user.uid, data.metaPath);
        }

        if (data.status === "meta_check_ready") {
            currentMetadata = data.meta_metadata;
            renderMetaTable(currentMetadata);
            document.getElementById('meta-summary-report').innerHTML =
                `<i class="fa-solid fa-check-circle text-success me-2"></i>Identified <b>${currentMetadata.length}</b> metadata factors.`;
        }
    });

    document.getElementById('btn-proceed-final').onclick = proceedToFinal;
}

// --- MENU TÀI KHOẢN ---
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

// --- VPS COMM ---
async function triggerMetaCheck(uid, metaPath) {
    try {
        await fetch(`${vpsUrl}/meta-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                project_id: projectId, 
                uid: uid, // Truyền thêm uid để backend tạo path local
                meta_path: metaPath 
            })
        });
    } catch (e) { console.error("VPS Offline:", e); }
}

// --- RENDER TABLE ---
function renderMetaTable(metaMetadata) {
    const tbody = document.getElementById('meta-table-body');
    tbody.innerHTML = metaMetadata.map(meta => `
        <tr>
            <td><input type="text" class="form-control form-control-sm fw-bold border-0 bg-transparent" value="${meta.name}" readonly></td>
            <td><span class="badge badge-status ${meta.status === 'OK' ? 'bg-success' : 'bg-warning'}">${meta.status}</span></td>
            <td>
                <select class="form-select form-select-sm" onchange="metaChanges.types['${meta.name}'] = this.value">
                    <option value="Categorical" ${meta.type === 'Categorical' ? 'selected' : ''}>Categorical</option>
                    <option value="Continuous" ${meta.type === 'Continuous' ? 'selected' : ''}>Continuous</option>
                </select>
            </td>
            <td class="text-center">
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-info" onclick="openOrderEdit('${meta.name}')"><i class="fa-solid fa-sort me-1"></i>Order</button>
                </div>
            </td>
            <td><button class="btn btn-sm text-danger"><i class="fa-solid fa-trash-can"></i></button></td>
        </tr>
    `).join('');
}

// --- MODAL ORDER LOGIC ---
window.openOrderEdit = (factor) => {
    activeFactor = factor;
    const meta = currentMetadata.find(m => m.name === factor);
    const groups = metaChanges.orders[factor] || meta.groups;
    renderOrderList(groups);
    bootstrapModals.order.show();
};

function renderOrderList(groups) {
    const list = document.getElementById('order-list');
    list.innerHTML = groups.map((g, i) => `
        <li class="list-group-item d-flex justify-content-between align-items-center mb-1 border shadow-sm rounded p-2">
            <span class="small"><b class="text-primary me-2">${i + 1}.</b> ${g}</span>
            <div class="btn-group">
                <button class="btn btn-xs btn-light border" onclick="moveOrder(${i}, -1)"><i class="fa-solid fa-chevron-up"></i></button>
                <button class="btn btn-xs btn-light border" onclick="moveOrder(${i}, 1)"><i class="fa-solid fa-chevron-down"></i></button>
            </div>
        </li>
    `).join('');
}

window.moveOrder = (index, direction) => {
    const meta = currentMetadata.find(m => m.name === activeFactor);
    let groups = [...(metaChanges.orders[activeFactor] || meta.groups)];
    let newIndex = index + direction;
    if (newIndex >= 0 && newIndex < groups.length) {
        [groups[index], groups[newIndex]] = [groups[newIndex], groups[index]];
        metaChanges.orders[activeFactor] = groups;
        renderOrderList(groups);
    }
};

window.confirmOrder = () => bootstrapModals.order.hide();

// --- PROCEED ---
async function proceedToFinal() {
    const user = auth.currentUser;
    if (!user) return alert("Session expired.");

    const btn = document.getElementById('btn-proceed-final');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Processing Meta...';

    const projectSnap = await getDoc(doc(db, "projects", projectId));
    const metaPath = projectSnap.data().metaPath;

    try {
        await fetch(`${vpsUrl}/save-checked-meta`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                uid: user.uid,
                meta_path: metaPath,
                changes: metaChanges
            })
        });

        window.location.href = `matrixcheck.html?id=${projectId}&uid=${user.uid}`;

    } catch (e) {
        alert("VPS Connection Error.");
        btn.disabled = false;
        btn.innerHTML = 'Proceed to Analysis';
    }
}