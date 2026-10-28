import "./auth-gate.js";
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { doc, onSnapshot, getDoc } from "./firebase-config.js";
import { getReviewArtifacts, openProjectFileActions } from "./project-files.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { vpsUrl } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');
const userUid = urlParams.get('uid');

let currentMetadata = [];
let metaCheckRequested = false;
let currentProjectData = null;

initializeTerminalWidget();

if (!projectId) window.location.href = "projectID.html";

document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            if (document.getElementById("author-menu-drd")) {
                renderUserMenu();
            } else {
                window.addEventListener('headerLoaded', renderUserMenu);
            }
        }
    });

    const reportContent = document.getElementById('report-content');
    const loadingSection = document.getElementById('loading-section');
    const resultSection = document.getElementById('result-section');
const resultActionsBar = document.getElementById('result-actions-bar');
    const errorBox = document.getElementById('error-box');
    const errorList = document.getElementById('error-list');
    const metaSummaryReport = document.getElementById('meta-summary-report');
    const metaTableBody = document.getElementById('meta-table-body');
    const btnProceedFinal = document.getElementById('btn-proceed-final');
    const btnReupload = document.getElementById('btn-reupload');
    const btnOpenReviewFiles = document.getElementById('btn-open-review-files');
    const preprocessDiagnostics = document.getElementById('preprocess-diagnostics');

    btnProceedFinal.onclick = proceedToFiltering;
    btnOpenReviewFiles.onclick = () => {
        if (!currentProjectData) return;
        openProjectFileActions('Review Current Files', getReviewArtifacts(currentProjectData));
    };

    onSnapshot(doc(db, "projects", projectId), async (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();
        currentProjectData = data;

        // Statuses that come AFTER integrity + meta-check succeeded.
        // When the user navigates back to this page after filtering/normalization,
        // the project status is one of these — treat it as integrity-succeeded so
        // the page shows results + the proceed button instead of hanging forever.
        const downstreamReady = ["meta_check_ready", "matrix_check_ready", "norm_ready", "anova_success", "univariate_success"];
        const integritySucceeded = data.status === "integrity_success" || downstreamReady.includes(data.status);
        if (integritySucceeded) {
            loadingSection.classList.add('d-none');
            resultSection.classList.remove('d-none');
if (resultActionsBar) resultActionsBar.classList.remove('d-none');

            const reportLines = Array.isArray(data.integrity_report) ? data.integrity_report : [];
            reportContent.innerHTML = reportLines.map((line) =>
                `<div class="report-line"><span class="text-info">&gt;</span> ${line}</div>`
            ).join('') + `<div class="mt-3 text-warning fw-bold">&gt; Dataset structure is valid</div>`;

            errorBox.classList.add('d-none');
            btnReupload.classList.add('d-none');
            btnOpenReviewFiles.classList.remove('d-none');
            renderPreprocessingDiagnostics(data, preprocessDiagnostics);

            if (data.status === "integrity_success" && !metaCheckRequested) {
                metaCheckRequested = true;
                const finalUid = userUid || (auth.currentUser ? auth.currentUser.uid : "");
                if (finalUid && data.metaPath) {
                    try {
                        await triggerMetaCheck(finalUid, data.metaPath);
                    } catch (error) {
                        console.error("Failed to start metadata check", error);
                        metaSummaryReport.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-danger me-2"></i>Unable to start metadata review.';
                    }
                }
            }
        }

        if (downstreamReady.includes(data.status) || data.status === "meta_check_ready") {
            currentMetadata = Array.isArray(data.meta_metadata) ? data.meta_metadata : [];
            metaTableBody.innerHTML = renderMetaRows(currentMetadata);
            metaSummaryReport.innerHTML = `<i class="fa-solid fa-check-circle text-success me-2"></i>Detected <b>${currentMetadata.length}</b> metadata factors.`;
            btnProceedFinal.classList.remove('d-none');
        } else if (integritySucceeded) {
            metaSummaryReport.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>Scanning metadata structure...';
            metaTableBody.innerHTML = '';
            btnProceedFinal.classList.add('d-none');
        }

        if (data.status === "integrity_error") {
            loadingSection.classList.add('d-none');
            resultSection.classList.remove('d-none');
if (resultActionsBar) resultActionsBar.classList.remove('d-none');
            reportContent.innerHTML = `<div class="text-danger fw-bold">&gt; Data integrity check failed.</div>`;
            errorBox.classList.remove('d-none');
            btnReupload.classList.remove('d-none');
            btnOpenReviewFiles.classList.remove('d-none');
            metaSummaryReport.innerHTML = '<i class="fa-solid fa-ban text-danger me-2"></i>Metadata review is unavailable until the upload issues are fixed.';
            metaTableBody.innerHTML = '';
            btnProceedFinal.classList.add('d-none');
            if (data.details) {
                errorList.innerHTML = data.details.map(err => `<li>${err}</li>`).join('');
            }
            renderPreprocessingDiagnostics(data, preprocessDiagnostics);
        }
    });
});

function renderPreprocessingDiagnostics(projectData, target) {
    if (projectData.uploadMode !== 'preprocess_portal') {
        target.classList.add('d-none');
        target.innerHTML = '';
        return;
    }

    const diagnostics = projectData.preprocessingDiagnostics || {};
    const items = [
        ['Missing IS compounds', diagnostics.missing_is_compounds],
        ['Missing IS standards', diagnostics.missing_is_standards],
        ['Missing NIST samples in matrix', diagnostics.missing_nist_samples_in_matrix],
        ['Missing paired NIST samples in matrix', diagnostics.missing_nist_references_in_matrix],
        ['Missing NIST samples in metadata', diagnostics.missing_nist_samples_in_meta],
    ].filter(([, values]) => Array.isArray(values) && values.length > 0);

    target.classList.remove('d-none');
    if (!items.length) {
        target.className = 'alert alert-success shadow-sm mb-0';
        target.innerHTML = '<i class="fa-solid fa-circle-check me-2"></i>IS and NIST checks completed with no missing compounds or samples.';
        return;
    }

    target.className = 'alert alert-warning shadow-sm mb-0';
    target.innerHTML = `
        <div class="fw-bold mb-2"><i class="fa-solid fa-triangle-exclamation me-2"></i>Preprocessing checks found missing mappings</div>
        <ul class="small diagnostic-list">
            ${items.map(([label, values]) => `<li><strong>${label}:</strong> ${values.join(', ')}</li>`).join('')}
        </ul>
    `;
}

function renderMetaRows(metaMetadata) {
    return metaMetadata.map((meta) => `
        <tr>
            <td class="fw-semibold">${meta.name}</td>
            <td><span class="badge badge-status ${meta.status === 'OK' ? 'bg-success' : 'bg-warning text-dark'}">${meta.status}</span></td>
            <td><span class="type-chip">${meta.type}</span></td>
        </tr>
    `).join('');
}

async function triggerMetaCheck(uid, metaPath) {
    await fetch(`${vpsUrl}/meta-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            project_id: projectId,
            uid,
            meta_path: metaPath,
        }),
    });
}

async function proceedToFiltering() {
    const user = auth.currentUser;
    if (!user) {
        alert("Session expired.");
        return;
    }

    const btn = document.getElementById('btn-proceed-final');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving metadata...';

    try {
        const projectSnap = await getDoc(doc(db, "projects", projectId));
        const metaPath = projectSnap.data()?.metaPath;

        await fetch(`${vpsUrl}/save-checked-meta`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                uid: user.uid,
                meta_path: metaPath,
                changes: { types: {}, orders: {} },
            }),
        });

        window.location.href = `matrixcheck.html?id=${projectId}&uid=${user.uid}`;
    } catch (error) {
        console.error(error);
        alert("Unable to save metadata review.");
        btn.disabled = false;
        btn.innerHTML = 'Continue to Data Filtering <i class="fa-solid fa-chevron-right ms-1"></i>';
    }
}

function renderUserMenu() {
    const menu = document.getElementById("author-menu-drd");
    const user = auth.currentUser;
    if (!user || !menu) return;
    menu.innerHTML = `
        <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${user.email}</li>
        <li><button id="logout-btn" class="dropdown-item text-danger py-2">
            <i class="fa-solid fa-right-from-bracket me-2"></i> Sign Out
        </button></li>
    `;
    document.getElementById("logout-btn").onclick = async () => {
        await signOut(auth);
        localStorage.removeItem("userSession");
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
