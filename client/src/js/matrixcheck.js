import "./auth-gate.js";
import { db, auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { doc, onSnapshot, getDoc } from "./firebase-config.js";
import { getFilteringArtifacts, openProjectFileActions } from "./project-files.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { vpsUrl } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');
const pageUid = urlParams.get('uid');
let projectData = null;

// Deterministic back navigation: always return to the integrity-check page
// (with project context) instead of relying on browser history.
const _backBtn = document.getElementById('btn-back');
if (_backBtn) {
    _backBtn.onclick = () => {
        const uid = pageUid || (auth.currentUser ? auth.currentUser.uid : '');
        window.location.href = `dataintegritycheck.html?id=${projectId}&uid=${uid}`;
    };
}

initializeTerminalWidget();

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (document.getElementById("author-menu-drd")) {
            renderUserMenu(user);
        } else {
            window.addEventListener('headerLoaded', () => renderUserMenu(user));
        }
    }
});

function renderUserMenu(user) {
    const menu = document.getElementById("author-menu-drd");
    if (!menu) return;
    menu.innerHTML = `
        <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${user.email}</li>
        <li><button id="logout-btn" class="dropdown-item text-danger py-2">
            <i class="fa-solid fa-right-from-bracket me-2"></i> Sign Out
        </button></li>
    `;
    document.getElementById("logout-btn").onclick = async () => {
        await signOut(auth);
        window.location.href = "./index.html";
    };
}

function initializeTerminalWidget() {
    const host = document.getElementById('shared-terminal-host');
    if (!host || host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';
    mountTerminalWidget({
        host,
        logUrl: `${vpsUrl}/log-stream`,
        variant: 'floating-left'
    }).catch((error) => {
        console.error('Failed to mount terminal widget.', error);
        delete host.dataset.mounted;
    });
}

document.getElementById('btn-run-filter').onclick = async () => {
    if (!projectId) return alert("Missing Project ID");

    const btn = document.getElementById('btn-run-filter');
    const previewButton = document.getElementById('btn-open-filter-files');

    const getValue = (id) => {
        let el = document.getElementById(id);
        let val = parseFloat(el.value) || 0;
        if (val > 100) val = 100;
        if (val < 0) val = 0;
        el.value = val;
        return val;
    };

    const settings = {
        mv_threshold: getValue('mv-threshold'),
        rsd_threshold: getValue('rsd-threshold'),
        var_method: document.getElementById('var-method').value,
        var_percent: getValue('var-percent'),
        abun_method: document.getElementById('abun-method').value,
        abun_percent: getValue('abun-percent'),
    };

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Processing...';
    // Hide previous run's results while the new run is in progress.
    document.getElementById('report-section').classList.add('d-none');
    document.getElementById('btn-go-ana').classList.add('d-none');
    previewButton.classList.add('d-none');

    try {
        const user = auth.currentUser;
        if (!user) return alert("Please login.");

        const projectSnap = await getDoc(doc(db, "projects", projectId));
        projectData = projectSnap.data();

        // Capture the doc's last-update timestamp BEFORE submitting, so the
        // onSnapshot listener can distinguish the stale immediate-fire (old
        // results from a previous run) from a genuine new write by the backend.
        const baselineUpdatedAt = projectData?.updated_at || "";

        await fetch(`${vpsUrl}/matrix-filter`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                uid: user.uid,
                matrix_path: projectData.matrixPreprocessedPath || projectData.matrixPath,
                meta_path: projectData.metaCheckedPath || projectData.metaPath,
                settings: settings
            })
        });

        const unsubscribe = onSnapshot(doc(db, "projects", projectId), (docSnap) => {
            const data = docSnap.data();
            projectData = data;
            // Ignore the stale immediate-fire (doc not yet updated by the new run).
            if ((data.updated_at || "") === baselineUpdatedAt) return;

            if (data.status === "matrix_check_ready") {
                unsubscribe();
                // Re-enable the button so the user can tweak params and re-run
                // on the same page (no need to navigate back).
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-rotate-right me-1"></i> Re-run Filter';
                document.getElementById('report-section').classList.remove('d-none');
                document.getElementById('report-content').innerHTML = data.filtering_report.map(line => `<div>> ${line}</div>`).join('') +
                    `<div class="text-warning mt-2 fw-bold">> Total features remaining: ${data.final_feature_count}</div>`;

                previewButton.classList.remove('d-none');
                document.getElementById('btn-go-ana').classList.remove('d-none');

                document.getElementById('btn-go-ana').onclick = () => {
                    window.location.href = `normalize.html?id=${projectId}&uid=${user.uid}`;
                };
            } else if (data.status === "error") {
                unsubscribe();
                btn.disabled = false;
                btn.innerHTML = 'Submit & Filter';
                alert(data.message || "Filtering failed. Please try again.");
            }
        });
    } catch (err) {
        console.error(err);
        alert("VPS connection error!");
        btn.disabled = false;
        btn.innerHTML = 'Submit & Filter';
    }
};

document.getElementById('btn-open-filter-files').onclick = () => {
    if (!projectData) return;
    openProjectFileActions('Filtering Input Files', getFilteringArtifacts(projectData));
};

document.getElementById('btn-go-ana').onclick = () => {
    const user = auth.currentUser;
    const finalUid = user ? user.uid : new URLSearchParams(window.location.search).get('uid');
    window.location.href = `normalize.html?id=${projectId}&uid=${finalUid}`;
};