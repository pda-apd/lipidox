import "./auth-gate.js";
import { db, auth, storage } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { buildDatasetFromCsvTexts, computeTopFeaturesPerLabel, parseTopFeatureCount } from "./heatmap-feature-ranking.js";
import { fetchJsonWithTimeout, formatTaskId, getTaskStatusBadge, normalizeTaskStatus, nowIso, prepareAnalysisTask, TASK_TIMEOUT_MS } from "./task-utils.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, updateDoc, onSnapshot } from "./firebase-config.js";
import { getDownloadURL, ref } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');

let projectData = null;
let analysisHistory = [];
let selectedHistoryRunId = null;
let runCooldownUntil = 0;
let runCooldownTimer = null;
let currentZoom = 1;
let isDragging = false;
let startX = 0, startY = 0, translateX = 0, translateY = 0;
let datasetCache = null;
let featureViewNoteRequestId = 0;

const imgContainer = document.getElementById('img-container');
const heatmapImg = document.getElementById('heatmap-img');

function getFeatureViewMode() {
    return String(document.getElementById('feature-view-mode')?.value || 'all').trim().toLowerCase();
}

function isAutoFeatureViewEnabled() {
    return Number.isFinite(parseTopFeatureCount(getFeatureViewMode()));
}

function getFeatureViewNoteEl() {
    return document.getElementById('feature-view-note');
}

async function fetchTextFromStoragePath(path) {
    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot load storage file: HTTP ${response.status}`);
    return response.text();
}

async function ensureDatasetLoaded() {
    if (datasetCache) return datasetCache;
    if (!projectData?.matrixNormPath || !projectData?.metaCheckedPath) {
        throw new Error('Missing normalized matrix or checked metadata for feature ranking.');
    }
    const [matrixText, metaText] = await Promise.all([
        fetchTextFromStoragePath(projectData.matrixNormPath),
        fetchTextFromStoragePath(projectData.metaCheckedPath),
    ]);
    datasetCache = buildDatasetFromCsvTexts(matrixText, metaText);
    return datasetCache;
}

async function computeFeatureSelectionForRequest() {
    if (!isAutoFeatureViewEnabled()) {
        return { orderedFeatures: [], labelSections: [], summary: '', error: '' };
    }
    const dataset = await ensureDatasetLoaded();
    const metaCol = document.getElementById('meta-col-select').value;
    const labelOrder = dataset.metaValueMap.get(metaCol) || [];
    return computeTopFeaturesPerLabel({
        sampleIds: dataset.sampleIds,
        features: dataset.features,
        featureToValues: dataset.featureToValues,
        metaBySample: dataset.metaBySample,
        metaCol,
        selectedLabels: labelOrder,
        labelOrder,
        topN: parseTopFeatureCount(getFeatureViewMode()),
        scaleMode: document.getElementById('heatmap-scale-mode').value,
    });
}

async function refreshFeatureViewNote() {
    const noteEl = getFeatureViewNoteEl();
    if (!noteEl) return;
    if (!isAutoFeatureViewEnabled()) {
        noteEl.textContent = 'All features from the normalized matrix will be included.';
        return;
    }
    const requestId = ++featureViewNoteRequestId;
    noteEl.textContent = 'Ranking top features per label...';
    try {
        const selection = await computeFeatureSelectionForRequest();
        if (requestId !== featureViewNoteRequestId) return;
        noteEl.textContent = selection.error || selection.summary || 'Top-feature ranking is ready.';
    } catch (error) {
        if (requestId !== featureViewNoteRequestId) return;
        noteEl.textContent = error?.message || String(error);
    }
}

onAuthStateChanged(auth, async (user) => {
    if (user && projectId) {
        await injectSidebar(user.uid);
        await initHeatmapSetup();
        setupHistoryPopup();
        setupZoomPan();
        document.body.classList.add('loaded');
    }
});

async function initHeatmapSetup() {
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data();
    if (window.renderNormSummary) window.renderNormSummary(projectData?.norm_settings, projectData?.normality_stat);

    analysisHistory = normalizeHistory(projectData.heatmap_history || []);
    renderAnalysisHistory();

    // Load metadata columns
    if (projectData.meta_metadata) {
        const select = document.getElementById('meta-col-select');
        const catCols = projectData.meta_metadata.filter(m => m.type === 'Categorical');
        select.innerHTML = catCols.length > 0
            ? catCols.map(m => `<option value="${m.name}">${m.name}</option>`).join('')
            : '<option value="">No categorical columns</option>';
    }
    refreshFeatureViewNote();

    onSnapshot(doc(db, "projects", projectId), async (snapshot) => {
        const data = snapshot.data() || {};
        projectData = { ...(projectData || {}), ...data };
        analysisHistory = normalizeHistory(data.heatmap_history || analysisHistory || []);

        renderAnalysisHistory();
    });
}

// ==================== HISTORY ====================

function deduplicateHistory(history) {
    const seen = new Set();
    return history.filter(item => {
        const key = item.run_id || `${item.name}_${item.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeHistory(history) {
    return deduplicateHistory((history || []).map((item) => ({
        ...item,
        status: normalizeTaskStatus(item?.status),
    })));
}

function isHistoryBusy(item) {
    return ["pending", "running"].includes(normalizeTaskStatus(item?.status));
}

async function persistHistory() {
    analysisHistory = normalizeHistory(analysisHistory);
    await updateDoc(doc(db, "projects", projectId), { heatmap_history: analysisHistory });
}

async function saveHistoryEntry(entry) {
    analysisHistory = normalizeHistory([
        entry,
        ...analysisHistory.filter((item) => item.run_id !== entry.run_id),
    ]);
    await persistHistory();
    renderAnalysisHistory();
}

function isRunCoolingDown() {
    return runCooldownUntil > Date.now();
}

function refreshRunCooldownUi() {
    const btn = document.getElementById('btn-generate-heatmap');
    if (!btn) return;
    if (isRunCoolingDown()) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-clock me-2"></i>Queued...';
        return;
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles me-2"></i>Generate Heatmap';
}

function startRunCooldown(durationMs = RUN_SUBMIT_COOLDOWN_MS) {
    runCooldownUntil = Date.now() + durationMs;
    if (runCooldownTimer) {
        window.clearInterval(runCooldownTimer);
    }
    refreshRunCooldownUi();
    runCooldownTimer = window.setInterval(() => {
        if (!isRunCoolingDown()) {
            window.clearInterval(runCooldownTimer);
            runCooldownTimer = null;
            refreshRunCooldownUi();
            return;
        }
        refreshRunCooldownUi();
    }, 200);
}

function waitForHeatmapRun(runId, timeoutMs = TASK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            window.clearTimeout(timer);
            callback(value);
        };

        const unsubscribe = onSnapshot(doc(db, 'projects', projectId), (snapshot) => {
            const data = snapshot.data() || {};
            projectData = { ...(projectData || {}), ...data };
            analysisHistory = normalizeHistory(data.heatmap_history || analysisHistory || []);
            renderAnalysisHistory();

            const entry = analysisHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            const status = normalizeTaskStatus(entry.status);
            if (status === 'done' && entry.heatmap_url) {
                finish(resolve, entry);
                return;
            }
            if (status === 'error') {
                finish(reject, new Error(entry.message || 'Heatmap task failed.'));
            }
        });

        const timer = window.setTimeout(() => {
            finish(reject, new Error('Task timed out after 180 minutes.'));
        }, timeoutMs);
    });
}

function setRunUiBusy() {
    const btn = document.getElementById('btn-generate-heatmap');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>Processing...';
}

function setRunUiIdle() {
    refreshRunCooldownUi();
}

function buildHistoryConfigText(item) {
    const featureViewText = item.feature_view_mode && item.feature_view_mode !== 'all'
        ? `; View: top ${item.top_feature_count || '?'} per label`
        : '';
    return `Mode: ${item.mode || '?'}; Scale: ${item.scale_mode || 'row_zscore'}; Group: ${item.meta_col || '?'}${featureViewText}; Palette: ${item.palette || '?'}; ${item.width}x${item.height}`;
}

function renderAnalysisHistory() {
    analysisHistory = normalizeHistory(analysisHistory);
    const popup = document.getElementById('history-popup');
    if (!popup) return;

    popup.innerHTML = analysisHistory.length ? `
        ${analysisHistory.map((item, index) => `
        <div class="history-item ${selectedHistoryRunId && item.run_id === selectedHistoryRunId ? 'active' : ''}" data-index="${index}" data-run-id="${item.run_id || ''}">
            <div class="d-flex justify-content-between align-items-start">
                <div class="fw-bold">${item.name}</div>
                <small class="text-muted">${new Date(item.date).toLocaleDateString()}</small>
            </div>
            <div class="d-flex align-items-center gap-2 mt-1 mb-1">
                ${getTaskStatusBadge(item.status)}
                <span class="extra-small text-muted">${formatTaskId(item)}</span>
            </div>
            <div class="history-config">${buildHistoryConfigText(item)}</div>
            <div class="history-config">${item.message || ''}</div>
            <div class="d-flex justify-content-end mt-2">
                <button class="btn btn-outline-danger btn-sm py-0 px-2 history-delete" data-index="${index}" title="Delete this run" ${isHistoryBusy(item) ? 'disabled' : ''}>
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
        `).join('')}
        <button id="btn-history-delete-all" class="btn btn-danger btn-sm w-100 mt-2">Delete All</button>
    ` : `<div class="text-muted text-center py-2 extra-small">No history yet.</div>`;

    popup.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.history-delete')) return;
            const index = parseInt(item.dataset.index);
            if (isHistoryBusy(analysisHistory[index])) return;
            selectedHistoryRunId = item.dataset.runId || null;
            highlightHistoryItem(item);
            loadAnalysisResult(analysisHistory[index]);
            popup.classList.remove('open');
        });
    });

    popup.querySelectorAll('.history-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            const removed = analysisHistory[index];
            if (isHistoryBusy(removed)) return;
            analysisHistory.splice(index, 1);
            if (removed?.run_id && selectedHistoryRunId === removed.run_id) selectedHistoryRunId = null;
            await updateDoc(doc(db, "projects", projectId), { heatmap_history: analysisHistory, heatmap_url: null });
            clearResultsPanel();
            renderAnalysisHistory();
        });
    });

    const btnDeleteAll = document.getElementById('btn-history-delete-all');
    if (btnDeleteAll) {
        btnDeleteAll.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('Delete all heatmap history?')) {
                analysisHistory = [];
                await updateDoc(doc(db, "projects", projectId), { heatmap_history: null, heatmap_url: null });
                clearResultsPanel();
                renderAnalysisHistory();
            }
        });
    }
}

function highlightHistoryItem(activeItem) {
    document.querySelectorAll('#history-popup .history-item').forEach(h => {
        h.classList.remove('active');
    });
    activeItem.classList.add('active');
}

function loadAnalysisResult(analysis) {
    selectedHistoryRunId = analysis?.run_id || null;
    // Fill config fields immediately
    document.getElementById('analysis-name').value = analysis.name;
    if (analysis.mode) document.getElementById('heatmap-mode').value = analysis.mode;
    if (analysis.scale_mode) document.getElementById('heatmap-scale-mode').value = analysis.scale_mode;
    if (analysis.meta_col) document.getElementById('meta-col-select').value = analysis.meta_col;
    if (analysis.feature_view_mode) document.getElementById('feature-view-mode').value = analysis.feature_view_mode;
    if (analysis.palette) document.getElementById('color-palette').value = analysis.palette;
    if (analysis.width) document.getElementById('fig-width').value = analysis.width;
    if (analysis.height) document.getElementById('fig-height').value = analysis.height;
    refreshFeatureViewNote();

    // Show loading state, then load image
    if (analysis.heatmap_url) {
        showLoadingState();
        showHeatmapImage(analysis.heatmap_url);
    }
}

function showLoadingState() {
    const img = document.getElementById('heatmap-img');
    const placeholder = document.getElementById('heatmap-placeholder');
    const zoomBar = document.getElementById('zoom-bar');
    img.classList.add('d-none');
    zoomBar.classList.add('d-none');
    placeholder.innerHTML = '<div class="text-center"><div class="spinner-border text-secondary mb-3" role="status"></div><p class="text-muted">Loading heatmap...</p></div>';
    placeholder.classList.remove('d-none');
}

function showHeatmapImage(url) {
    const img = document.getElementById('heatmap-img');
    const placeholder = document.getElementById('heatmap-placeholder');
    const zoomBar = document.getElementById('zoom-bar');
    img.src = `${url}?t=${Date.now()}`;
    img.onload = () => {
        img.classList.remove('d-none');
        placeholder.classList.add('d-none');
        zoomBar.classList.remove('d-none');
        resetZoomAndPan();
    };
    img.onerror = () => {
        placeholder.innerHTML = '<div class="text-center py-5"><i class="fa-solid fa-triangle-exclamation fa-3x mb-3 text-warning"></i><p class="text-muted">Failed to load image</p></div>';
    };
}

function clearResultsPanel() {
    document.getElementById('heatmap-img').classList.add('d-none');
    document.getElementById('heatmap-placeholder').innerHTML = '<div class="text-center py-5"><i class="fa-solid fa-chart-area fa-4x mb-3 opacity-25"></i><p class="text-muted">Generate heatmap to display result</p></div>';
    document.getElementById('heatmap-placeholder').classList.remove('d-none');
    document.getElementById('zoom-bar').classList.add('d-none');
}

function lockHistory() {
    return undefined;
}

function unlockHistory() {
    return undefined;
}

function setupHistoryPopup() {
    const toggle = document.getElementById('history-toggle');
    const popup = document.getElementById('history-popup');
    if (!toggle || !popup) return;

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!popup.contains(e.target) && e.target !== toggle) {
            popup.classList.remove('open');
        }
    });
}

// ==================== GENERATE ====================

document.getElementById('btn-generate-heatmap').onclick = async () => {
    let queuedRunId = null;
    try {
        if (isRunCoolingDown()) return;
        const identity = await prepareAnalysisTask(vpsUrl, projectId, 'heatmap-expression', { 'ngrok-skip-browser-warning': 'true' });
        queuedRunId = identity.run_id;

        await updateDoc(doc(db, "projects", projectId), { heatmap_url: null });
        showLoadingState();
        setRunUiBusy();

        const featureSelection = await computeFeatureSelectionForRequest();
        if (featureSelection.error) {
            throw new Error(featureSelection.error);
        }

        const settings = {
            mode: document.getElementById('heatmap-mode').value,
            scale_mode: document.getElementById('heatmap-scale-mode').value,
            meta_col: document.getElementById('meta-col-select').value,
            feature_view_mode: getFeatureViewMode(),
            top_feature_count: parseTopFeatureCount(getFeatureViewMode()),
            selected_features: featureSelection.orderedFeatures,
            feature_sections: featureSelection.labelSections,
            preserve_feature_order: isAutoFeatureViewEnabled(),
            palette: document.getElementById('color-palette').value,
            width: document.getElementById('fig-width').value || 12,
            height: document.getElementById('fig-height').value || 10
        };

        const analysisName = document.getElementById('analysis-name').value || `Heatmap ${new Date().toLocaleString()}`;
        const baseEntry = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            name: analysisName,
            date: nowIso(),
            started_at: identity.started_at,
            updated_at: identity.started_at,
            mode: settings.mode,
            scale_mode: settings.scale_mode,
            meta_col: settings.meta_col,
            feature_view_mode: settings.feature_view_mode,
            top_feature_count: settings.top_feature_count,
            palette: settings.palette,
            width: settings.width,
            height: settings.height,
            status: 'pending',
            message: featureSelection.summary || 'Queued for processing.'
        };

        await saveHistoryEntry(baseEntry);
        selectedHistoryRunId = identity.run_id;
        document.getElementById('history-popup')?.classList.add('open');

        await saveHistoryEntry({ ...baseEntry, status: 'running', message: 'Heatmap is running...' });
        const { response, data } = await fetchJsonWithTimeout(`${vpsUrl}/generate-heatmap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                run_id: identity.run_id,
                task_id: identity.task_id,
                matrix_path: projectData.matrixNormPath,
                meta_path: projectData.metaCheckedPath,
                settings: settings
            })
        });

        if (!response.ok) {
            throw new Error(data.detail || 'Heatmap request failed.');
        }

        startRunCooldown();
        setRunUiIdle();

        void (async () => {
            try {
                const doneEntry = await waitForHeatmapRun(identity.run_id);
                selectedHistoryRunId = identity.run_id;
                showHeatmapImage(doneEntry.heatmap_url);
            } catch (error) {
                const existingEntry = analysisHistory.find((item) => item.run_id === identity.run_id);
                if (existingEntry && normalizeTaskStatus(existingEntry.status) !== 'error') {
                    await saveHistoryEntry({
                        ...existingEntry,
                        status: 'error',
                        message: error.message || 'Heatmap request failed.',
                        completed_at: nowIso(),
                        updated_at: nowIso(),
                    });
                }
                if (selectedHistoryRunId === identity.run_id) {
                    showLoadingState();
                }
            }
        })();

        renderAnalysisHistory();
    } catch (error) {
        if (queuedRunId) {
            const existingEntry = analysisHistory.find((item) => item.run_id === queuedRunId);
            if (existingEntry) {
                await saveHistoryEntry({
                    ...existingEntry,
                    status: 'error',
                    message: error.message || 'Heatmap request failed.',
                    completed_at: nowIso(),
                    updated_at: nowIso(),
                });
            }
        }
        setRunUiIdle();
    }
};

// ==================== ZOOM & PAN ====================

function setupZoomPan() {
    imgContainer.onwheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.02 : 0.02;
        const newZoom = currentZoom + delta;
        if (newZoom > 0.1 && newZoom < 10) { currentZoom = newZoom; updateTransform(); }
    };

    imgContainer.onmousedown = (e) => {
        if (currentZoom <= 1) return;
        e.preventDefault();
        isDragging = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
    };

    window.onmousemove = (e) => {
        if (!isDragging) return;
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
    };

    window.onmouseup = () => { isDragging = false; };

    document.getElementById('btn-zoom-in').onclick = () => { currentZoom += 0.2; updateTransform(); };
    document.getElementById('btn-zoom-out').onclick = () => { if (currentZoom > 0.2) { currentZoom -= 0.2; updateTransform(); } };
    document.getElementById('btn-zoom-reset').onclick = resetZoomAndPan;
}

function updateTransform() {
    heatmapImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentZoom})`;
    heatmapImg.style.width = currentZoom > 1 ? 'auto' : '100%';
    document.getElementById('zoom-level').innerText = `${Math.round(currentZoom * 100)}%`;
}

function resetZoomAndPan() {
    currentZoom = 1; translateX = 0; translateY = 0;
    updateTransform();
}

// ==================== DOWNLOAD ====================

document.getElementById('btn-download-jpg').onclick = async () => {
    const imgUrl = document.getElementById('heatmap-img').src;
    try {
        const resp = await fetch(imgUrl); const blob = await resp.blob();
        const link = document.createElement('a'); link.href = window.URL.createObjectURL(blob); link.download = `Heatmap_${projectId}.jpg`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
    } catch (e) { window.open(imgUrl, '_blank'); }
};

document.getElementById('meta-col-select')?.addEventListener('change', () => {
    refreshFeatureViewNote();
});

document.getElementById('heatmap-scale-mode')?.addEventListener('change', () => {
    refreshFeatureViewNote();
});

document.getElementById('feature-view-mode')?.addEventListener('change', () => {
    refreshFeatureViewNote();
});

// ==================== SIDEBAR ====================

async function injectSidebar(uid) {
    const resp = await fetch('sidebar.html');
    const html = await resp.text();
    document.getElementById('sidebar-placeholder').innerHTML = html;
    document.getElementById('sidebar-placeholder').querySelectorAll('script').forEach(old => { const s = document.createElement('script'); s.textContent = old.textContent; document.head.appendChild(s); });
    document.querySelectorAll('#analysis-nav a').forEach(l => {
        const h = l.getAttribute('href');
        if (h && h !== '#') l.href = `${h}?id=${projectId}&uid=${uid}`;
    });
    const activeLink = document.querySelector('#analysis-nav a[href^="heatmapexpression.html"]');
    if (activeLink) {
        document.querySelectorAll('#analysis-nav .nav-link').forEach(l => l.classList.remove('active'));
        activeLink.classList.add('active');
    }

    const terminalHost = document.getElementById('sidebar-terminal-slot');
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}
