import "./auth-gate.js";
import { db, auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { doc, onSnapshot, getDoc } from "./firebase-config.js";
import { getNormalizationArtifacts, openProjectFileActions } from "./project-files.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { vpsUrl } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');
const pageUid = urlParams.get('uid');

let projectData = null;
let batchModal = null;

// Deterministic back navigation: always return to the matrix-check page
// (with project context) instead of relying on browser history.
const _backBtn = document.getElementById('btn-back');
if (_backBtn) {
    _backBtn.onclick = () => {
        const uid = pageUid || (auth.currentUser ? auth.currentUser.uid : '');
        window.location.href = `matrixcheck.html?id=${projectId}&uid=${uid}`;
    };
}

initializeTerminalWidget();

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) {
        console.error("Missing user or project ID");
        return;
    }

    if (document.getElementById("author-menu-drd")) {
        renderUserMenu(user);
    } else {
        window.addEventListener('headerLoaded', () => renderUserMenu(user));
    }

    document.body.classList.add('loaded');

    setTimeout(() => {
        const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
        tooltipTriggerList.map(el => new bootstrap.Tooltip(el));
        
        const modalEl = document.getElementById('modalBatchView');
        if (modalEl) batchModal = new bootstrap.Modal(modalEl);
    }, 600);

    try {
        const projectSnap = await getDoc(doc(db, "projects", projectId));
        if (projectSnap.exists()) {
            projectData = projectSnap.data();
            populateBatchDropdown();
            setupEventListeners(user.uid);
        } else {
            alert("Project data was not found.");
        }
    } catch (error) {
        console.error("Failed to load project data:", error);
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

function populateBatchDropdown() {
    const batchSelect = document.getElementById('batch-column');
    if (!batchSelect || !projectData.meta_metadata) return;

    const eligibleCols = projectData.meta_metadata.filter((meta) => meta?.name);

    if (eligibleCols.length > 0) {
        batchSelect.innerHTML = eligibleCols.map((meta) => 
            `<option value="${meta.name}">${meta.name} (${meta.type || 'Unknown'})</option>`
        ).join('');
    } else {
        batchSelect.innerHTML = `<option value="">No metadata columns found</option>`;
    }
}

function setupEventListeners(uid) {
    const batchRadios = document.getElementsByName('batchCorr');
    batchRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const box = document.getElementById('combat-select-box');
            if (box) {
                e.target.value === 'ComBat' ? box.classList.remove('d-none') : box.classList.add('d-none');
            }
        });
    });

    const viewBtn = document.getElementById('btn-view-batch-details');
    if (viewBtn) {
        viewBtn.onclick = () => {
            const colName = document.getElementById('batch-column').value;
            if (!colName) return alert("Please choose a metadata column.");

            const metaInfo = projectData.meta_metadata.find(m => m.name === colName);
            const listContainer = document.getElementById('batch-info-list');

            if (metaInfo && listContainer && batchModal) {
                const stats = metaInfo.group_counts || {};
                const groupList = Array.isArray(metaInfo.groups) ? metaInfo.groups : [];

                let html = `<div class="p-3 fw-bold text-primary border-bottom bg-light">Column: ${colName}</div>`;
                html += `<div class="px-3 py-2 extra-small text-muted border-bottom">Type: ${metaInfo.type || 'Unknown'}</div>`;

                if (Object.keys(stats).length > 0) {
                    html += Object.entries(stats).map(([label, count]) => `
                        <div class="list-group-item d-flex justify-content-between align-items-center py-2 px-3">
                            <span><i class="fa-solid fa-tag me-2 text-warning small"></i>${label}</span>
                            <span class="badge bg-primary rounded-pill">${count} samples</span>
                        </div>
                    `).join('');
                } else if (groupList.length > 0) {
                    html += groupList.map(label => `
                        <div class="list-group-item d-flex justify-content-between align-items-center py-2 px-3">
                            <span><i class="fa-solid fa-tag me-2 text-warning small"></i>${label}</span>
                            <span class="text-muted extra-small">Listed in metadata</span>
                        </div>
                    `).join('');
                } else {
                    html += `
                        <div class="list-group-item py-3 px-3 text-muted extra-small">
                            No precomputed group summary is available for this column. Numeric batch labels such as 1, 2, 3, 4 are still accepted by ComBat.
                        </div>
                    `;
                }

                listContainer.innerHTML = html;
                batchModal.show();
            }
        };
    }

    const runBtn = document.getElementById('btn-run-norm');
    if (runBtn) runBtn.onclick = () => runNormalize(uid);

    const fileButton = document.getElementById('btn-open-normalized-files');
    if (fileButton) {
        fileButton.onclick = () => {
            if (!projectData) return;
            openProjectFileActions('Normalized Output Files', getNormalizationArtifacts(projectData));
        };
    }
}

async function runNormalize(uid) {
    const btn = document.getElementById('btn-run-norm');
    const settings = {
        sample_norm: document.querySelector('input[name="sampleNorm"]:checked').value,
        data_trans: document.querySelector('input[name="dataTrans"]:checked').value,
        batch_corr: document.querySelector('input[name="batchCorr"]:checked').value,
        batch_col: document.getElementById('batch-column').value,
        data_scaling: document.querySelector('input[name="dataScale"]:checked').value,
        zero: parseInt(document.querySelector('input[name="zeroHandling"]:checked').value)
    };

    if (settings.batch_corr === 'ComBat' && !settings.batch_col) {
        alert("Please choose a batch column for ComBat.");
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>Processing...';
    // Hide previous run's results while the new run is in progress.
    document.getElementById('report-section').classList.add('d-none');
    document.getElementById('btn-go-ana').classList.add('d-none');
    document.getElementById('btn-open-normalized-files').classList.add('d-none');

    try {
        // Capture the doc's last-update timestamp BEFORE submitting, so the
        // onSnapshot listener can ignore the stale immediate-fire (old results
        // from a previous run) and only react to a genuine new backend write.
        const baselineUpdatedAt = projectData?.updated_at || "";

        const response = await fetch(`${vpsUrl}/normalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                uid: uid,
                matrix_path: projectData.matrixCheckedPath,
                meta_path: projectData.metaCheckedPath,
                settings: settings
            })
        });

        if (!response.ok) throw new Error("VPS Error");

        const unsubscribe = onSnapshot(doc(db, "projects", projectId), (snap) => {
            const d = snap.data();
            projectData = d;
            // Ignore the stale immediate-fire (doc not yet updated by the new run).
            if ((d.updated_at || "") === baselineUpdatedAt) return;

            if (d.status === "norm_ready") {
                unsubscribe();
                // Re-enable the button so the user can tweak params and re-run
                // on the same page (no need to navigate back).
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-rotate-right me-1"></i> Re-normalize';
                btn.className = "btn btn-outline-primary btn-sm px-5 fw-bold shadow";

                const zeroVal = d.norm_settings?.zero;
                const zeroLabel = zeroVal === -1 ? 'None' : zeroVal === 0 ? '1/5 Minimum' : 'QRILC';
                document.getElementById('report-section').classList.remove('d-none');
                document.getElementById('report-content').innerHTML = `
                    <div class="d-flex align-items-center">
                        <div class="me-3"><i class="fa-solid fa-circle-check text-success fa-2x"></i></div>
                        <div>
                            <div class="fw-bold text-success">Processing completed successfully.</div>
                            <div class="extra-small text-muted">Result: <b>${d.normality_stat.normal_features}/${d.normality_stat.total_features}</b> features passed the normality check (${d.normality_stat.percentage}%).</div>
                            <div class="extra-small text-muted mt-1">Zero handling: <b>${zeroLabel}</b></div>
                        </div>
                    </div>
                `;
                
                const goBtn = document.getElementById('btn-go-ana');
                document.getElementById('btn-open-normalized-files').classList.remove('d-none');
                goBtn.classList.remove('d-none');
                goBtn.onclick = () => window.location.href = `pca.html?id=${projectId}&uid=${uid}&auto_default_pca=1`;
            } else if (d.status === "error") {
                unsubscribe();
                btn.disabled = false;
                btn.innerHTML = "Normalize Data";
                alert(d.message || "Normalization failed. Please try again.");
            }
        });
    } catch (e) {
        console.error(e);
        alert("VPS connection error.");
        btn.disabled = false;
        btn.innerHTML = "Normalize Data";
    }
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