import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { MULTIVAR_PALETTE_MAP, createMultivarFeatureIn, getCurrentPlotRanges, buildMultivarScatterLayout, getMultivarPlotOptions, bindLassoSelection } from "./multivar-common.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { fetchJsonWithTimeout, formatTaskId, getTaskStatusBadge, normalizeTaskStatus, nowIso, prepareAnalysisTask } from "./task-utils.js";
import { sortMetadataLabels, normalizeMetaLabel } from "./meta-label-utils.js";
import { safeString } from "./analysis-shared.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { openAppendMetaModal } from "./append-meta-modal.js";
import { openMetadataManagerModal } from "./metadata-manager-modal.js";
import { withInteractionLock } from "./ui-busy-lock.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { ref, getDownloadURL } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const plotConfig = { ...PLOT_CONFIG_DEFAULTS, imgWidth: 1400, ellipseOpacity: 0.15 };

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");

// ── STATE ──────────────────────────────────────────────────────────────
const state = {
    projectData: null,
    pcaRuns: [],          // PCA runs from pca_history for input selection
    runs: [],             // som run history
    currentRunId: null,
    hiddenLabels: new Set(),
    highlightedLabels: new Set(),
    selectedSampleIds: new Set(),
    colorBy: "__som_cluster__",
    palette: "vivid",
    showEllipse: false,
    user: null,
    metaValueMap: new Map(),   // metaCol → [labels]
    metaCountMap: new Map(),   // metaCol → (label → count)
    selectedLabels: new Set(),
    clusterNameMap: {},        // original cluster label → renamed label
    customLabelColors: {},     // label → hex color (user overrides)
    runCooldownUntil: 0,
    runCooldownTimer: null,
    _metaOpBusy: false,
};

// ── PALETTES ───────────────────────────────────────────────────────────
const paletteMap = MULTIVAR_PALETTE_MAP;

// ── DOM REFS ───────────────────────────────────────────────────────────
const dom = {
    somNameInput:    document.getElementById("somNameInput"),
    somNamePreview:  document.getElementById("somNamePreview"),
    somInputSelect:  document.getElementById("somInputSelect"),
    somXDimInput:    document.getElementById("somXDimInput"),
    somYDimInput:    document.getElementById("somYDimInput"),
    somInitSelect:   document.getElementById("somInitSelect"),
    somNeighborhoodSelect: document.getElementById("somNeighborhoodSelect"),
    somLayoutSelect: document.getElementById("somLayoutSelect"),
    somMetaColSelect:document.getElementById("somMetaColSelect"),
    somLabelList:    document.getElementById("somLabelList"),
    runSomBtn:       document.getElementById("runSomBtn"),
    somStatus:       document.getElementById("somStatus"),
    historyToggle:      document.getElementById("historyToggle"),
    historyPopup:       document.getElementById("historyPopup"),
    somResultPanel: document.getElementById("somResultPanel"),
    colorBySelect:      document.getElementById("colorBySelect"),
    btnMetadataManager: document.getElementById("btnMetadataManager"),
    paletteSelect:      document.getElementById("paletteSelect"),
    ellipseToggle:      document.getElementById("ellipseToggle"),
    legendList:         document.getElementById("legendList"),
    btnAppendMetadata:  document.getElementById("btnAppendMetadata"),
    pcVarianceInfo:     document.getElementById("pcVarianceInfo"),
    clusterColName:     document.getElementById("clusterColName"),
    clusterRenameList:  document.getElementById("clusterRenameList"),
    saveToMetaBtn:      document.getElementById("saveToMetaBtn"),
    saveStatus:         document.getElementById("saveStatus"),
    featureSearchInput: document.getElementById("featureSearchInput"),
    featureSearchResults: document.getElementById("featureSearchResults"),
    featureScaleMode: document.getElementById("featureScaleMode"),
    featureSearchStatus: document.getElementById("featureSearchStatus"),
    featureCurrentSummary: document.getElementById("featureCurrentSummary"),
    featureSelectedList: document.getElementById("featureSelectedList"),
    featureClearAllBtn: document.getElementById("featureClearAllBtn"),
    featureDistributionPlot: document.getElementById("featureDistributionPlot"),
    featureOverlayLegend: document.getElementById("featureOverlayLegend"),
    plotWrap:           document.getElementById("plotWrap"),
    vizEmpty:           document.getElementById("vizEmpty"),
    vizContent:         document.getElementById("vizContent"),
    sidebarPlaceholder: document.getElementById("sidebar-placeholder"),
    runNewPcaCheckbox: document.getElementById("runNewPcaCheckbox"),
};

const featureIn = createMultivarFeatureIn({
    dom,
    onSelectionChange: () => renderPlot(),
    paletteMap,
});

// ── HELPERS ────────────────────────────────────────────────────────────
function sanitize(v) {
    return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isLabelHighlighted(label) {
    return state.highlightedLabels.has(label);
}

function hasHighlightSelection() {
    return state.highlightedLabels.size > 0;
}

function toggleHighlightedLabel(label, event) {
    const isMulti = Boolean(event?.ctrlKey || event?.metaKey);
    if (isMulti) {
        if (state.highlightedLabels.has(label)) state.highlightedLabels.delete(label);
        else state.highlightedLabels.add(label);
        return;
    }
    if (state.highlightedLabels.size === 1 && state.highlightedLabels.has(label)) {
        state.highlightedLabels.clear();
        return;
    }
    state.highlightedLabels.clear();
    state.highlightedLabels.add(label);
}

function setStatus(el, msg, isError = false) {
    el.textContent = msg || "";
    el.classList.toggle("error", Boolean(isError));
}

function isRunCoolingDown() {
    return state.runCooldownUntil > Date.now();
}

function getRunCooldownSecondsRemaining() {
    return Math.max(1, Math.ceil((state.runCooldownUntil - Date.now()) / 1000));
}

function validateRunSomButton() {
    if (!dom.runSomBtn) return;
    if (isRunCoolingDown()) {
        dom.runSomBtn.disabled = true;
        dom.runSomBtn.innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${getRunCooldownSecondsRemaining()}s`;
        return;
    }
    dom.runSomBtn.disabled = false;
    dom.runSomBtn.innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN';
}

function startRunCooldown(durationMs = RUN_SUBMIT_COOLDOWN_MS) {
    state.runCooldownUntil = Date.now() + durationMs;
    if (state.runCooldownTimer) {
        window.clearInterval(state.runCooldownTimer);
    }
    validateRunSomButton();
    state.runCooldownTimer = window.setInterval(() => {
        if (!isRunCoolingDown()) {
            window.clearInterval(state.runCooldownTimer);
            state.runCooldownTimer = null;
            validateRunSomButton();
            return;
        }
        validateRunSomButton();
    }, 200);
}

function stopRunCooldown() {
    state.runCooldownUntil = 0;
    if (state.runCooldownTimer) {
        window.clearInterval(state.runCooldownTimer);
        state.runCooldownTimer = null;
    }
    validateRunSomButton();
}

function buildRunName() {
    const suffix = (dom.somNameInput.value || "").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "") || `run_${Date.now()}`;
    const xDim = dom.somXDimInput.value || "8";
    const yDim = dom.somYDimInput.value || "8";
    const src = dom.somInputSelect.selectedOptions[0]?.textContent?.slice(0, 20).replace(/\s+/g, "_") || "data";
    return `SOM_${xDim}x${yDim}_${src}_${suffix}`;
}

function normalizeSomLayout(value) {
    return String(value || "overlay").trim().toLowerCase();
}

function describeSpaceMethod(method) {
    if (method === "auto_pca") return "Auto PCA";
    if (method === "pca_overlay") return "PCA 2D";
    if (method === "som_grid") return "SOM grid";
    return String(method || "unknown");
}

function getCurrentRun() {
    return state.runs.find((r) => r.run_id === state.currentRunId) || null;
}

function isFromPca() {
    const v = dom.somInputSelect.value;
    return !!v;
}

// ── META VALUE MAP ─────────────────────────────────────────────────────
function buildMetaValueMap(sourceMetadata) {
    state.metaValueMap.clear();
    state.metaCountMap.clear();
    const projectMeta = state.projectData?.meta_metadata || [];

    // Use provided source, or fall back to current som run, or any loaded PCA run
    let meta = sourceMetadata
        || getCurrentRun()?.data?.metadata;

    // If still empty, try to scavenge from any loaded PCA run (normalize mode fallback)
    if (!meta || !meta.length) {
        for (const pcaRun of state.pcaRuns) {
            if (pcaRun.data?.metadata?.length) { meta = pcaRun.data.metadata; break; }
        }
    }

    if (meta && meta.length && projectMeta.length) {
        projectMeta.forEach((m) => {
            const col = m.name;
            const vals = sortMetadataLabels([...new Set(meta.map((row) => safeString(row[col])).filter((v) => v !== ""))]);
            if (vals.length) {
                state.metaValueMap.set(col, vals);
                const counts = new Map();
                vals.forEach((v) => counts.set(v, 0));
                meta.forEach((row) => { const v = safeString(row[col]); if (counts.has(v)) counts.set(v, counts.get(v) + 1); });
                state.metaCountMap.set(col, counts);
            }
        });
    }
}

// ── LABEL LIST ─────────────────────────────────────────────────────────
function renderLabelList() {
    const col = dom.somMetaColSelect.value;
    const labels = state.metaValueMap.get(col) || [];
    const fromPca = isFromPca();

    if (!labels.length) {
        state.selectedLabels.clear();
        dom.somLabelList.innerHTML = '<div class="text-muted" style="font-size:0.7rem;">No labels for this column.</div>';
        return;
    }

    if (!state.selectedLabels.size) labels.forEach((l) => state.selectedLabels.add(l));

    // Determine color from the loaded PCA run's metadata (works before som is run too)
    const pcaColorMap = new Map();
    if (fromPca) {
        const pcaRunId = dom.somInputSelect.value;
        const pcaRun = state.pcaRuns.find((r) => r.run_id === pcaRunId);
        const srcMeta = pcaRun?.data?.metadata || getCurrentRun()?.data?.metadata || [];
        const palette = paletteMap[state.palette] || paletteMap.vivid;
        const labelsForCol = [...new Set(srcMeta.map((row) => safeString(row[col])).filter((v) => v !== ""))];
        labelsForCol.forEach((lbl, i) => {
            pcaColorMap.set(lbl, lbl === "NaN" ? "#ccc" : palette[i % palette.length]);
        });
    }

    const countMap = state.metaCountMap.get(col);
    dom.somLabelList.innerHTML = labels.map((label, idx) => {
        const color = label === "NaN" ? "#ccc" : pcaColorMap.get(label);
        const colorChip = fromPca && color
            ? `<span class="label-chip" style="background:${color}"></span>`
            : "";
        const count = countMap?.get(label);
        const countBadge = count !== undefined ? ` <span class="text-muted" style="font-size:0.68rem;">(${count})</span>` : "";
        return `
            <div class="form-check d-flex align-items-center gap-1" style="font-size:0.72rem;">
                <input class="form-check-input label-check mt-0" id="klbl-${idx}" type="checkbox" value="${sanitize(label)}" ${state.selectedLabels.has(label) ? "checked" : ""}>
                <label for="klbl-${idx}" class="form-check-label mb-0">${colorChip}${sanitize(label)}${countBadge}</label>
            </div>
        `;
    }).join("");

    dom.somLabelList.querySelectorAll(".label-check").forEach((cb) => {
        cb.addEventListener("change", () => {
            if (cb.checked) state.selectedLabels.add(cb.value);
            else state.selectedLabels.delete(cb.value);
            if (isFromPca()) {
                const pcaRun = state.pcaRuns.find((r) => r.run_id === dom.somInputSelect.value);
                if (pcaRun?.data) renderPcaPreview(pcaRun);
            }
        });
    });
}

// ── META COLUMN SELECTOR ───────────────────────────────────────────────
function populateMetaSelector() {
    const cols = (state.projectData?.meta_metadata || []).map((m) => String(m.name));
    dom.somMetaColSelect.innerHTML = cols.length
        ? cols.map((c) => `<option value="${sanitize(c)}">${sanitize(c)}</option>`).join("")
        : '<option value="">-- No metadata --</option>';
    buildMetaValueMap();
    state.selectedLabels.clear();
    renderLabelList();
}

// ── PCA RUNS INTO SELECTOR ─────────────────────────────────────────────
function refreshInputSelector() {
    const prev = dom.somInputSelect.value;
    dom.somInputSelect.innerHTML = '<option value="">--Select--</option>';
    state.pcaRuns.forEach((run) => {
        const opt = document.createElement("option");
        opt.value = run.run_id;
        opt.textContent = `PCA: ${run.name}`;
        dom.somInputSelect.appendChild(opt);
    });
    if (prev && [...dom.somInputSelect.options].some((o) => o.value === prev)) {
        dom.somInputSelect.value = prev;
    } else {
        dom.somInputSelect.value = "";
    }
}

// ── LOAD PCA RUN (show on right panel) ────────────────────────────────
async function loadPcaPreview(pcaRunId) {
    const run = state.pcaRuns.find((r) => r.run_id === pcaRunId);
    if (!run) return;
    if (!run.data?.plot_points) {
        if (!run.data_path) return;
        try {
            let url = run.data_path;
            if (!url.startsWith("http")) url = await getDownloadURL(ref(storage, url));
            const resp = await fetch(url);
            run.data = await resp.json();
        } catch (e) {
            console.warn("Failed to load PCA data for preview", e);
            return;
        }
    }
    // Show PCA scatter temporarily with current colorBy option
    showVizLoading("PCA preview loaded. Configure and Run SOM.");
    toggleViz(true);
    renderPcaPreview(run);
}

function renderPcaPreview(pcaRun) {
    // Always colour by the currently selected metadata column (independent of state.colorBy which belongs to the result canvas)
    const colorBy = dom.somMetaColSelect.value || null;
    const metaById = new Map((pcaRun.data?.metadata || []).map((row) => [String(row.sample_id), row]));
    const grouped = new Map();
    (pcaRun.data?.plot_points || []).forEach((pt) => {
        const meta = metaById.get(String(pt.sample_id)) || {};
        const label = safeString(meta[colorBy]);
        if (!grouped.has(label)) grouped.set(label, []);
        grouped.get(label).push(pt);
    });
    const palette = paletteMap[state.palette] || paletteMap.vivid;
    const colorMap = new Map();
    let ci = 0;
    grouped.forEach((_, lbl) => { colorMap.set(lbl, lbl === "NaN" ? "#ccc" : palette[ci++ % palette.length]); });

    const hasFilter = state.selectedLabels.size > 0;
    const traces = [];
    grouped.forEach((pts, lbl) => {
        const isSelected = !hasFilter || state.selectedLabels.has(lbl);
        traces.push({
            type: "scattergl", mode: "markers",
            x: pts.map((p) => p.x), y: pts.map((p) => p.y),
            text: pts.map((p) => p.sample_id),
            hovertemplate: "<b>%{text}</b><br>x=%{x:.3f}<br>y=%{y:.3f}<extra>" + sanitize(lbl) + "</extra>",
            marker: { size: 8, color: colorMap.get(lbl), opacity: isSelected ? 0.62 : 0.12 },
            showlegend: false,
        });
    });

    const ev = pcaRun.data?.explained_variance_ratio || [];
    const xTitle = ev[0] ? `PC1 (${(ev[0]*100).toFixed(2)}%)` : "PC1";
    const yTitle = ev[1] ? `PC2 (${(ev[1]*100).toFixed(2)}%)` : "PC2";

    dom.plotWrap.innerHTML = "";
    Plotly.newPlot(dom.plotWrap, traces, {
        margin: { t: 20, r: 20, b: 50, l: 60 },
        paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
        xaxis: { title: xTitle, zeroline: false, gridcolor: "#edf1f5" },
        yaxis: { title: yTitle, zeroline: false, gridcolor: "#edf1f5" },
        showlegend: false,
    }, { responsive: true, displayModeBar: "hover", scrollZoom: true, displaylogo: false, toImageButtonOptions: { format: 'svg', width: 1400, height: 900, scale: 6 } });

    if (dom.pcVarianceInfo) {
        dom.pcVarianceInfo.textContent = ev.length >= 2
            ? `PC1: ${(ev[0]*100).toFixed(2)}% | PC2: ${(ev[1]*100).toFixed(2)}%`
            : "";
    }
}

// ── CLUSTER RENAME UI ──────────────────────────────────────────────────
function renderClusterRenameList(run) {
    const clusterLabels = run.data?.cluster_labels || [];
    const palette = paletteMap[state.palette] || paletteMap.vivid;
    dom.clusterRenameList.innerHTML = clusterLabels.map((lbl, i) => {
        const color = palette[i % palette.length];
        const currentName = state.clusterNameMap[lbl] || lbl;
        return `
            <div class="cluster-rename-row">
                <span class="cluster-swatch" style="background:${color}"></span>
                <input class="form-control form-control-sm cluster-rename-input" data-original="${sanitize(lbl)}" value="${sanitize(currentName)}" style="font-size:0.72rem;">
            </div>
        `;
    }).join("");

    dom.clusterRenameList.querySelectorAll(".cluster-rename-input").forEach((input) => {
        input.addEventListener("input", () => {
            const orig = input.dataset.original;
            state.clusterNameMap[orig] = input.value || orig;
            renderPlot();
        });
    });
}

// ── COLOR OPTION (by cluster or by metadata) ──────────────────────────
function refreshColorOptions() {
    const run = getCurrentRun();
    dom.colorBySelect.innerHTML = '<option value="__som_cluster__">SOM Cluster</option>';
    if (!run) return;
    const runColumns = run?.data?.metadata_columns || [];
    const projectColumns = (state.projectData?.meta_metadata || []).map((m) => m?.name).filter(Boolean);
    const columns = sortMetadataLabels([...new Set([...(runColumns || []), ...(projectColumns || [])])]);
    columns.forEach((col) => {
        const opt = document.createElement("option");
        opt.value = col;
        opt.textContent = col;
        dom.colorBySelect.appendChild(opt);
    });
    if (!dom.colorBySelect.querySelector(`option[value="${sanitize(state.colorBy)}"]`)) {
        state.colorBy = "__som_cluster__";
    }
    dom.colorBySelect.value = state.colorBy;
    updateAppendButtonState();
}

function updateAppendButtonState() {
    if (!dom.btnAppendMetadata) return;
    const run = getCurrentRun();
    const hasLassoSelection = state.selectedSampleIds instanceof Set && state.selectedSampleIds.size > 0;
    dom.btnAppendMetadata.disabled = !(run && (hasHighlightSelection() || hasLassoSelection));
}

async function reloadAllRunMetadata() {
    state.runs.forEach((item) => {
        if (item.data_path) item.data = null;
    });
    const active = getCurrentRun();
    if (active) await ensureRunData(active);
}

async function appendHighlightedLabelsToMetadata() {
    const run = getCurrentRun();
    if (!run?.data?.metadata?.length) return;

    const selectedSampleIds = (state.selectedSampleIds instanceof Set)
        ? new Set([...state.selectedSampleIds].map((id) => String(id)))
        : new Set();
    if (!selectedSampleIds.size) {
        const grouped = groupPoints(run);
        state.highlightedLabels.forEach((label) => {
            (grouped.get(label) || []).forEach((point) => selectedSampleIds.add(String(point.sample_id)));
        });
    }
    if (!selectedSampleIds.size) return;

    const metadataColumns = sortMetadataLabels((state.projectData?.meta_metadata || []).map((m) => m?.name).filter(Boolean));
    const defaultColumn = metadataColumns.includes(state.colorBy) ? state.colorBy : (metadataColumns[0] || "");
    const modalResult = await openAppendMetaModal({
        metadataColumns,
        defaultColumn,
        selectedCount: selectedSampleIds.size,
    });
    if (!modalResult) return;

    const columnName = modalResult.column;
    const labelValue = String(modalResult.label);
    const metadataRows = run.data.metadata || [];
    const clusterAssignments = {};

    metadataRows.forEach((row) => {
        const sampleId = String(row.sample_id);
        const isSelected = selectedSampleIds.has(sampleId);
        if (modalResult.mode === "create") {
            clusterAssignments[sampleId] = isSelected ? labelValue : "nan";
        } else {
            const existing = row[columnName];
            clusterAssignments[sampleId] = isSelected ? labelValue : (existing != null ? String(existing) : "nan");
        }
    });

    const metaPath = state.projectData?.metaCheckedPath;
    if (!metaPath) {
        setStatus(dom.somStatus, "No metadata path found.", true);
        return;
    }

    state._metaOpBusy = true;
    await withInteractionLock(async () => {
        setStatus(dom.somStatus, "Updating metadata...");
        const resp = await fetch(`${vpsUrl}/som/save-clusters`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                meta_path: metaPath,
                cluster_col_name: columnName,
                cluster_assignments: clusterAssignments,
            }),
        });
        const payload = await resp.json();
        if (!resp.ok) throw new Error(payload.detail || "Append metadata failed");
    });

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    await reloadAllRunMetadata();
    state._metaOpBusy = false;

    state.colorBy = columnName;
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds = new Set();
    refreshColorOptions();
    await syncFeatureInContext();
    renderPlot();
    setStatus(dom.somStatus, `Appended to metadata column "${columnName}".`);
}

async function applyMetadataColumnEdits(modalResult) {
    const run = getCurrentRun();
    if (!run?.data?.metadata?.length) return;

    const sourceColumn = modalResult?.sourceColumn || state.colorBy;
    if (!sourceColumn || sourceColumn === "__som_cluster__") return;
    if (!modalResult) return;

    const targetColumn = modalResult.targetColumn;
    const metadataRows = (run.data.metadata || []).map((row) => ({ ...row }));
    const clusterAssignments = {};

    metadataRows.forEach((row) => {
        const sampleId = String(row.sample_id);
        const currentLabel = safeString(row[sourceColumn]);
        const renamedLabel = modalResult.renameMap[currentLabel] ?? currentLabel;
        if (targetColumn !== sourceColumn) {
            row[targetColumn] = renamedLabel;
            delete row[sourceColumn];
        } else {
            row[sourceColumn] = renamedLabel;
        }
        clusterAssignments[sampleId] = renamedLabel;
    });

    const metaPath = state.projectData?.metaCheckedPath;
    if (!metaPath) {
        setStatus(dom.somStatus, "No metadata path found.", true);
        return;
    }

    state._metaOpBusy = true;
    await withInteractionLock(async () => {
        setStatus(dom.somStatus, "Updating metadata...");
        const resp = await fetch(`${vpsUrl}/som/save-clusters`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                meta_path: metaPath,
                cluster_col_name: targetColumn,
                source_col_name: sourceColumn,
                remove_source_when_renamed: targetColumn !== sourceColumn,
                cluster_assignments: clusterAssignments,
                rename_map: modalResult.renameMap,
            }),
        });
        const payload = await resp.json();
        if (!resp.ok) throw new Error(payload.detail || "Edit metadata failed");
    });

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    await reloadAllRunMetadata();
    state._metaOpBusy = false;

    if (state.colorBy === sourceColumn) state.colorBy = targetColumn;
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds = new Set();
    refreshColorOptions();
    await syncFeatureInContext();
    renderPlot();
    setStatus(dom.somStatus, `Updated metadata column "${targetColumn}".`);
}

async function createNewMetadataColumn(modalResult) {
    const run = getCurrentRun();
    if (!run?.data?.metadata?.length) return;
    if (!modalResult) return;

    const metaPath = state.projectData?.metaCheckedPath;
    if (!metaPath) {
        setStatus(dom.somStatus, "No metadata path found.", true);
        return;
    }

    state._metaOpBusy = true;
    await withInteractionLock(async () => {
        setStatus(dom.somStatus, "Updating metadata...");
        const resp = await fetch(`${vpsUrl}/metadata/create-column`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                meta_path: metaPath,
                new_column_name: modalResult.newMetaName,
                mode: modalResult.mode,
                source_columns: modalResult.sourceColumns,
            }),
        });
        const payload = await resp.json();
        if (!resp.ok) throw new Error(payload.detail || "Create metadata failed");
    });

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    await reloadAllRunMetadata();
    state._metaOpBusy = false;

    refreshColorOptions();
    await syncFeatureInContext();
    renderPlot();
    setStatus(dom.somStatus, `Created metadata column "${modalResult.newMetaName}".`);
}

async function deleteMetadataColumns(modalResult) {
    const run = getCurrentRun();
    if (!run?.data?.metadata?.length) return;
    if (!modalResult) return;

    const metaPath = state.projectData?.metaCheckedPath;
    if (!metaPath) {
        setStatus(dom.somStatus, "No metadata path found.", true);
        return;
    }

    state._metaOpBusy = true;
    await withInteractionLock(async () => {
        setStatus(dom.somStatus, "Updating metadata...");
        const resp = await fetch(`${vpsUrl}/metadata/delete-columns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                meta_path: metaPath,
                column_names: modalResult.columnsToDelete,
            }),
        });
        const payload = await resp.json();
        if (!resp.ok) throw new Error(payload.detail || "Delete metadata failed");
    });

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    await reloadAllRunMetadata();
    state._metaOpBusy = false;

    const deletedSet = new Set(modalResult.columnsToDelete);
    if (state.colorBy && deletedSet.has(state.colorBy)) state.colorBy = "__som_cluster__";

    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds = new Set();
    refreshColorOptions();
    await syncFeatureInContext();
    renderPlot();
    setStatus(dom.somStatus, `Deleted ${modalResult.columnsToDelete.length} metadata column(s).`);
}

async function openUnifiedMetadataManager() {
    const run = getCurrentRun();
    if (!run?.data?.metadata?.length) return;

    const grouped = groupPoints(run);
    const labels = sortMetadataLabels([...grouped.keys()]);
    const metadataColumns = sortMetadataLabels((state.projectData?.meta_metadata || []).map((m) => m?.name).filter(Boolean));
    const activeColumn = metadataColumns.includes(state.colorBy) ? state.colorBy : (metadataColumns[0] || "");

    const modalResult = await openMetadataManagerModal({
        metadataColumns,
        metadataRows: run.data.metadata || [],
        activeColumn,
        colorMap: buildColorMap(labels),
    });
    if (!modalResult) return;

    if (modalResult.action === "edit") {
        await applyMetadataColumnEdits(modalResult);
        return;
    }
    if (modalResult.action === "create") {
        await createNewMetadataColumn(modalResult);
    }
}

// ── GROUPING FOR PLOT ──────────────────────────────────────────────────
function groupPoints(run) {
    const metaById = new Map((run.data?.metadata || []).map((row) => [String(row.sample_id), row]));
    const grouped = new Map();
    (run.data?.plot_points || []).forEach((pt) => {
        if (pt?.x == null || pt?.y == null) return;
        let label;
        if (state.colorBy === "__som_cluster__") {
            const raw = pt.cluster || "NaN";
            label = state.clusterNameMap[raw] || raw;
        } else {
            const meta = metaById.get(String(pt.sample_id)) || {};
            label = safeString(meta[state.colorBy]);
        }
        if (!grouped.has(label)) grouped.set(label, []);
        grouped.get(label).push(pt);
    });
    return grouped;
}

function buildColorMap(labels) {
    const palette = paletteMap[state.palette] || paletteMap.vivid;
    const result = new Map();
    let i = 0;
    labels.forEach((l) => {
        if (l === "NaN") { result.set(l, "#ccc"); }
        else {
            const defaultColor = palette[i % palette.length];
            i += 1;
            if (state.customLabelColors[l]) result.set(l, state.customLabelColors[l]);
            else result.set(l, defaultColor);
        }
    });
    return result;
}

function getFeatureOverlay() {
    return featureIn.getActiveOverlay();
}

async function syncFeatureInContext() {
    await featureIn.setContext({
        projectData: state.projectData,
        run: getCurrentRun(),
        colorBy: state.colorBy,
        palette: state.palette,
    });
}

function buildSomGridHeatmapTrace(run) {
    const grid = run.data?.grid || {};
    const xDim = Math.max(1, Number(grid.x) || 1);
    const yDim = Math.max(1, Number(grid.y) || 1);
    const umatrix = run.data?.umatrix;
    if (!Array.isArray(umatrix) || !umatrix.length) return null;

    const z = Array.from({ length: yDim }, (_, y) =>
        Array.from({ length: xDim }, (_, x) => Number(umatrix?.[x]?.[y]) || 0)
    );

    return {
        type: "heatmap",
        x: Array.from({ length: xDim }, (_, i) => i),
        y: Array.from({ length: yDim }, (_, i) => i),
        z,
        colorscale: "YlOrBr",
        reversescale: false,
        opacity: 0.62,
        showscale: true,
        hovertemplate: "Node (%{x}, %{y})<br>U-Matrix=%{z:.3f}<extra></extra>",
    };
}

function markerSizesForPoints(run, points, visualizationMethod, baseSize = 7) {
    if (visualizationMethod !== "som_grid") {
        return points.map(() => baseSize);
    }

    const nodeCounts = run.data?.node_counts || {};
    const scale = baseSize / 7;
    return points.map((point) => {
        const nodeKey = `${Math.round(point.x)}_${Math.round(point.y)}`;
        const count = Number(nodeCounts[nodeKey]) || 1;
        return Math.max(baseSize, Math.min(baseSize + 12, Math.round((6 + Math.sqrt(count) * 3) * scale)));
    });
}

// ── ELLIPSE ────────────────────────────────────────────────────────────
function ellipseTraceForGroup(label, points, color, fillOpacity = 0.15) {
    if (points.length < 3) return null;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) {
        const dx = xs[i]-mx, dy = ys[i]-my;
        sxx += dx*dx; sxy += dx*dy; syy += dy*dy;
    }
    sxx /= (xs.length-1); sxy /= (xs.length-1); syy /= (xs.length-1);
    const tr = sxx+syy, det = sxx*syy-sxy*sxy;
    const root = Math.sqrt(Math.max(tr*tr/4-det, 0));
    const l1 = tr/2+root, l2 = tr/2-root;
    if (!isFinite(l1)||!isFinite(l2)||l1<=0||l2<=0) return null;
    const angle = 0.5*Math.atan2(2*sxy, sxx-syy);
    const aA = Math.sqrt(l1*5.991), aB = Math.sqrt(l2*5.991);
    const ex=[], ey=[];
    for (let i=0; i<=90; i++) {
        const theta = (2*Math.PI*i)/90;
        const c=Math.cos(theta), s=Math.sin(theta);
        ex.push(mx + aA*c*Math.cos(angle) - aB*s*Math.sin(angle));
        ey.push(my + aA*c*Math.sin(angle) + aB*s*Math.cos(angle));
    }
    return { type:"scatter", mode:"lines", x:ex, y:ey,
        line:{color:"transparent", width:0},
        fill: "toself",
        fillcolor: (() => { const a = Math.round(Math.max(0, Math.min(1, fillOpacity)) * 255).toString(16).padStart(2, "0"); return `${color}${a}`; })(),
        hoverinfo:"skip", showlegend:false };
}

// ── LEGEND COLOR PICKER ──────────────────────────────────────────────
function rgbStringToHex(color) {
    const matches = String(color || "").match(/\d+/g);
    if (!matches || matches.length < 3) return "#ff000d";
    return `#${matches.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}

function openLegendColorPicker(label, swatchEl) {
    const currentColor = state.customLabelColors[label]
        || rgbStringToHex(getComputedStyle(swatchEl).backgroundColor);
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = currentColor;
    colorInput.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;";
    colorInput.addEventListener("change", () => {
        state.customLabelColors[label] = colorInput.value;
        swatchEl.style.backgroundColor = colorInput.value;
        renderPlot();
    }, { once: true });
    document.body.appendChild(colorInput);
    if (typeof colorInput.showPicker === "function") colorInput.showPicker();
    else colorInput.click();
}

// ── LEGEND ────────────────────────────────────────────────────────────
function renderLegend(grouped, colorMap) {
    dom.legendList.innerHTML = "";
    sortMetadataLabels([...grouped.keys()]).forEach((lbl) => {
        const pts = grouped.get(lbl) || [];
        const row = document.createElement("div");
        row.className = "legend-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "form-check-input mt-0";
        cb.checked = !state.hiddenLabels.has(lbl);
        cb.addEventListener("change", () => {
            if (cb.checked) state.hiddenLabels.delete(lbl);
            else state.hiddenLabels.add(lbl);
            renderPlot();
        });

        const swatch = document.createElement("span");
        swatch.className = "legend-swatch";
        swatch.style.backgroundColor = colorMap.get(lbl);
        swatch.style.cursor = "pointer";
        swatch.title = "Click to change label color";
        swatch.addEventListener("click", (event) => {
            event.stopPropagation();
            openLegendColorPicker(lbl, swatch);
        });

        const label = document.createElement("span");
        label.className = `legend-label ${isLabelHighlighted(lbl) ? "active" : ""}`;
        label.textContent = `${lbl} (${pts.length})`;
        label.addEventListener("click", (event) => {
            toggleHighlightedLabel(lbl, event);
            renderPlot();
        });

        row.appendChild(cb);
        row.appendChild(swatch);
        row.appendChild(label);
        dom.legendList.appendChild(row);
    });
    updateAppendButtonState();
}

// ── PLOT ───────────────────────────────────────────────────────────────
function renderPlot() {
    const run = getCurrentRun();
    const savedRanges = getCurrentPlotRanges(dom.plotWrap);
    if (!run?.data?.plot_points) return;

    const grouped = groupPoints(run);
    const labels = sortMetadataLabels([...grouped.keys()]);
    const colorMap = buildColorMap(labels);
    const activeFeatureOverlay = getFeatureOverlay();
    renderLegend(grouped, colorMap);

    const traces = [];
    const ev = run.data?.visualization_explained_variance_ratio || run.data?.explained_variance_ratio || [];
    const inputType = run.data?.input_type || "normalize";
    const somLayout = normalizeSomLayout(run.data?.som_params?.layout);
    const clusteringSpace = run.data?.clustering_space || {};
    const visualization = run.data?.visualization || {};
    const visualizationMethod = visualization.method || (somLayout === "separate" ? "som_grid" : "pca_overlay");
    const axisLabels = run.data?.visualization_axis_labels || ["PC1", "PC2"];

    if (visualizationMethod === "som_grid") {
        const heatmapTrace = buildSomGridHeatmapTrace(run);
        if (heatmapTrace) traces.push(heatmapTrace);
    }

    if (activeFeatureOverlay) {
        let showsColorBar = true;
        grouped.forEach((pts, lbl) => {
            if (state.hiddenLabels.has(lbl)) return;
            const isHL = isLabelHighlighted(lbl);
            const isDim = hasHighlightSelection() && !isHL;
            const baseSizes = markerSizesForPoints(run, pts, visualizationMethod, plotConfig.markerSize);
            const finitePoints = [];
            const missingPoints = [];

            pts.forEach((point, index) => {
                const sampleId = String(point.sample_id);
                const expression = activeFeatureOverlay.valuesBySample.get(sampleId);
                const enriched = { ...point, sample_id: sampleId, expression, groupLabel: lbl, markerSize: baseSizes[index] };
                if (Number.isFinite(expression)) finitePoints.push(enriched);
                else missingPoints.push(enriched);
            });

            if (finitePoints.length) {
                traces.push({
                    type: "scattergl",
                    mode: "markers",
                    x: finitePoints.map((point) => point.x),
                    y: finitePoints.map((point) => point.y),
                    text: finitePoints.map((point) => point.sample_id),
                    customdata: finitePoints.map((point) => [point.groupLabel, point.expression]),
                    hovertemplate: `<b>%{text}</b><br>${activeFeatureOverlay.feature}: %{customdata[1]:.4f}<br>${state.colorBy || "Group"}: %{customdata[0]}<br>x=%{x:.3f}<br>y=%{y:.3f}<extra></extra>`,
                    marker: {
                        size: finitePoints.map((point) => isHL ? Math.max(point.markerSize, 12) : point.markerSize),
                        color: finitePoints.map((point) => point.expression),
                        colorscale: [
                            [0, "#d1d5db"],
                            [0.35, "#f3d2cf"],
                            [0.7, "#d96a62"],
                            [1, "#b81d13"],
                        ],
                        cmin: activeFeatureOverlay.stats.min,
                        cmax: activeFeatureOverlay.stats.max,
                        colorbar: showsColorBar ? {
                            title: activeFeatureOverlay.modeLabel,
                            thickness: 12,
                            len: 0.65,
                            y: 0.5,
                            x: 1.02,
                            outlinewidth: 0,
                        } : undefined,
                        opacity: isDim ? 0.15 : isHL ? 1 : 0.88,
                        line: { width: 0 },
                    },
                    showlegend: false,
                });
                showsColorBar = false;
            }

            if (missingPoints.length) {
                traces.push({
                    type: "scattergl",
                    mode: "markers",
                    x: missingPoints.map((point) => point.x),
                    y: missingPoints.map((point) => point.y),
                    text: missingPoints.map((point) => point.sample_id),
                    customdata: missingPoints.map((point) => [point.groupLabel]),
                    hovertemplate: `<b>%{text}</b><br>${activeFeatureOverlay.feature}: missing<br>${state.colorBy || "Group"}: %{customdata[0]}<br>x=%{x:.3f}<br>y=%{y:.3f}<extra></extra>`,
                    marker: {
                        size: missingPoints.map((point) => isHL ? Math.max(point.markerSize, 10) : point.markerSize),
                        color: "#cbd5e1",
                        opacity: isDim ? 0.12 : isHL ? 0.95 : 0.75,
                        line: { width: 0 },
                    },
                    showlegend: false,
                });
            }

            if (state.showEllipse) {
                const el = ellipseTraceForGroup(lbl, pts, colorMap.get(lbl));
                if (el) traces.push(el);
            }
        });
    } else {
        grouped.forEach((pts, lbl) => {
            if (state.hiddenLabels.has(lbl)) return;
            const isHL = isLabelHighlighted(lbl);
            const isDim = hasHighlightSelection() && !isHL;
            traces.push({
                type: "scattergl", mode: "markers",
                x: pts.map((p) => p.x), y: pts.map((p) => p.y),
                text: pts.map((p) => p.sample_id),
                hovertemplate: "<b>%{text}</b><br>x=%{x:.3f}<br>y=%{y:.3f}<extra>" + sanitize(lbl) + "</extra>",
                marker: {
                    size: markerSizesForPoints(run, pts, visualizationMethod, plotConfig.markerSize).map((size) => isHL ? Math.max(size, plotConfig.markerSize + 4) : size),
                    color: colorMap.get(lbl),
                    opacity: isDim ? 0.14 : isHL ? 1 : plotConfig.markerOpacity,
                    line: { width: 0 },
                },
                name: lbl,
                showlegend: true,
            });
            if (state.showEllipse) {
                const el = ellipseTraceForGroup(lbl, pts, colorMap.get(lbl), plotConfig.ellipseOpacity);
                if (el) traces.push(el);
            }
        });
    }

    let xAxis, yAxis;
    if (visualizationMethod === "som_grid") {
        const grid = run.data?.grid || {};
        xAxis = `SOM Grid X (0-${(grid.x || 1) - 1})`;
        yAxis = `SOM Grid Y (0-${(grid.y || 1) - 1})`;
    } else {
        xAxis = ev[0] ? `${axisLabels[0] || "Dim 1"} (${(ev[0]*100).toFixed(2)}%)` : (axisLabels[0] || "Dim 1");
        yAxis = ev[1] ? `${axisLabels[1] || "Dim 2"} (${(ev[1]*100).toFixed(2)}%)` : (axisLabels[1] || "Dim 2");
    }

    if (dom.pcVarianceInfo) {
        const clusterText = clusteringSpace.method
            ? `Clustered in ${describeSpaceMethod(clusteringSpace.method)} (${clusteringSpace.dimensions || "?"}D)`
            : "";
        const vizText = visualizationMethod === "som_grid"
            ? `Visualized on SOM Grid ${run.data?.grid?.x || "?"}x${run.data?.grid?.y || "?"}`
            : `Visualized in ${describeSpaceMethod(visualizationMethod)}`;
        const detailText = visualizationMethod === "som_grid"
            ? "Samples in the same node are spread within each cell"
            : ev.length >= 2
                ? `${axisLabels[0] || "Dim 1"}: ${(ev[0]*100).toFixed(2)}% | ${axisLabels[1] || "Dim 2"}: ${(ev[1]*100).toFixed(2)}%`
                : inputType === "pca" ? "PCA embedding used" : "";
        dom.pcVarianceInfo.textContent = [clusterText, vizText, detailText].filter(Boolean).join(" | ");
    }

    dom.plotWrap.innerHTML = "";
    const layout = buildMultivarScatterLayout({
        xTitle: xAxis,
        yTitle: yAxis,
        plotConfig,
        savedRanges,
        activeFeatureOverlay,
        showLegend: !activeFeatureOverlay,
        xExtra: visualizationMethod === "som_grid" ? { dtick: 1, tick0: 0 } : {},
        yExtra: visualizationMethod === "som_grid" ? { dtick: 1, tick0: 0, scaleanchor: "x", scaleratio: 1 } : {},
    });
    Plotly.newPlot(dom.plotWrap, traces, layout, getMultivarPlotOptions(plotConfig));
    bindLassoSelection({ plotWrap: dom.plotWrap, state, onSelectionChange: updateAppendButtonState });
}

function showVizLoading(msg = "Loading...") {
    toggleViz(true);
    dom.plotWrap.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;color:#6c757d;font-size:0.9rem;">
            <span class="spinner-border spinner-border-sm text-secondary me-2"></span>${msg}
        </div>`;
}

function toggleViz(show) {
    dom.vizEmpty.style.display = show ? "none" : "flex";
    dom.vizContent.classList.toggle("active", show);
}

// ── HISTORY ────────────────────────────────────────────────────────────
function renderHistory() {
    dom.historyPopup.innerHTML = "";
    if (!state.runs.length) {
        dom.historyPopup.innerHTML = '<div class="history-meta" style="font-size:0.72rem;padding:0.3rem;">No runs yet.</div>';
        return;
    }
    state.runs.forEach((run) => {
        const item = document.createElement("div");
        item.className = `history-item d-flex align-items-start gap-2 ${state.currentRunId === run.run_id ? "active" : ""}`;
        if (run.config) {
            const cfg = run.config;
            const tipLines = [
                `Grid: ${cfg.x_dim || "?"}x${cfg.y_dim || "?"}`,
                `Init: ${cfg.initialization || "-"}`,
                `Neighbourhood: ${cfg.neighborhood || "-"}`,
                `Layout: ${cfg.layout || "-"}`,
                `Input: ${cfg.input_type}`,
                `Metadata: ${cfg.meta_col || "-"}`,
            ];
            if (cfg.selected_labels?.length) {
                const extra = (cfg.selected_count || cfg.selected_labels.length) > cfg.selected_labels.length
                    ? ` (+${cfg.selected_count - cfg.selected_labels.length} more)` : "";
                tipLines.push(`Labels: ${cfg.selected_labels.join(", ")}${extra}`);
            }
            item.title = tipLines.join("\n");
        }

        const info = document.createElement("div");
        info.style.cssText = "flex:1;min-width:0;cursor:pointer;";
        let configHtml = "";
        if (run.config) {
            const cfg = run.config;
            const grid = `${cfg.x_dim || "?"}x${cfg.y_dim || "?"}`;
            configHtml += `<div class="history-meta" style="margin-top:1px;">grid=${grid} | ${cfg.input_type} | col: ${sanitize(cfg.meta_col || "-")}</div>`;
            if (cfg.selected_labels?.length) {
                const shown = cfg.selected_labels.map(sanitize).join(", ");
                const extra = (cfg.selected_count || cfg.selected_labels.length) > cfg.selected_labels.length
                    ? ` +${cfg.selected_count - cfg.selected_labels.length} more` : "";
                configHtml += `<div class="history-meta" style="font-size:0.64rem;color:#999;">${shown}${extra}</div>`;
            }
        }
        info.innerHTML = `<div class="history-title">${sanitize(run.name)}</div><div class="history-meta">${new Date(run.date).toLocaleString()}</div><div class="history-meta mt-1">${getTaskStatusBadge(run.status)} <span class="ms-1">${formatTaskId(run)}</span></div><div class="history-meta mt-1">${sanitize(run.message || "")}</div>${configHtml}`;
        info.addEventListener("click", () => {
            if (isBusyRun(run)) return;
            applyRunSelection(run, true);
        });

        const del = document.createElement("button");
        del.className = "btn btn-outline-danger btn-sm py-0 px-1";
        del.style.fontSize = "0.65rem";
        del.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        del.title = "Delete";
        del.disabled = isBusyRun(run);
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteRun(run); });

        item.appendChild(info);
        item.appendChild(del);
        dom.historyPopup.appendChild(item);
    });
}

async function deleteRun(run) {
    if (!confirm(`Delete "${run.name}"?`)) return;

    if (run.data_path) {
        await deleteStorageArtifacts([run.data_path]);
    }

    state.runs = state.runs.filter((r) => r.run_id !== run.run_id);
    if (state.currentRunId === run.run_id) {
        state.currentRunId = null;
        toggleViz(false);
        dom.somResultPanel.style.display = "none";
    }
    renderHistory();
    await syncFeatureInContext();
    await persistRuns();
}

function normalizeRunRecord(r) {
    return {
        run_id: r.run_id,
        task_id: r.task_id || null,
        name: r.name,
        data: r.data || {},
        data_path: r.data_path || null,
        date: r.date || new Date().toISOString(),
        config: r.config || null,
        status: normalizeTaskStatus(r.status),
        message: r.message || "",
        started_at: r.started_at || r.date || null,
        updated_at: r.updated_at || r.date || null,
        completed_at: r.completed_at || null,
    };
}

function dedupeRuns(runs) {
    const seen = new Set();
    return runs.filter((r) => { if (!r.run_id || seen.has(r.run_id)) return false; seen.add(r.run_id); return true; });
}

function buildRunRecords(runs) {
    return runs.map((r) => ({
        run_id: r.run_id,
        task_id: r.task_id || null,
        name: r.name,
        data_path: r.data_path || null,
        date: r.date,
        config: r.config || null,
        status: normalizeTaskStatus(r.status),
        message: r.message || "",
        started_at: r.started_at || r.date || null,
        updated_at: r.updated_at || r.date || null,
        completed_at: r.completed_at || null,
    }));
}

function isBusyRun(run) {
    return ["pending", "running"].includes(normalizeTaskStatus(run?.status));
}

function upsertRun(run) {
    state.runs = dedupeRuns([
        normalizeRunRecord(run),
        ...state.runs.filter((item) => item.run_id !== run.run_id),
    ]);
}

async function persistRuns() {
    if (!projectId) return;
    await updateDoc(doc(db, "projects", projectId), { som_history: buildRunRecords(state.runs) });
}

async function deleteStorageArtifacts(urls) {
    const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
    if (!uniqueUrls.length) return;

    try {
        await fetch(`${vpsUrl}/storage/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: uniqueUrls }),
        });
    } catch (error) {
        console.warn("Failed to delete storage artifacts:", error);
    }
}

async function ensureRunData(run) {
    if (run.data?.plot_points) return true;
    if (!run.data_path) return false;
    try {
        let url = run.data_path;
        if (!url.startsWith("http")) url = await getDownloadURL(ref(storage, url));
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Failed to load run data");
        run.data = await resp.json();
        const s = state.runs.find((r) => r.run_id === run.run_id);
        if (s && s !== run) s.data = run.data;
        return true;
    } catch (e) {
        setStatus(dom.somStatus, e.message, true);
        return false;
    }
}

async function applyRunSelection(run, fromHistory = false) {
    state.currentRunId = run.run_id;
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds.clear();
    renderHistory();
    showVizLoading("Loading...");
    const loaded = await ensureRunData(run);
    if (!loaded) { toggleViz(false); return; }

    // Restore clusterNameMap from saved data
    state.clusterNameMap = { ...(run.data.cluster_name_map || {}) };

    toggleViz(true);
    refreshColorOptions();
    buildMetaValueMap();
    await syncFeatureInContext();
    renderPlot();
    dom.somResultPanel.style.display = "block";
    renderClusterRenameList(run);

    // Pre-fill column name
    if (!dom.clusterColName.value) {
        dom.clusterColName.value = run.data.meta_col ? `som_${run.data.meta_col}` : "som_cluster";
    }

    if (fromHistory) dom.historyPopup.classList.remove("open");
}

// ── RUN SOM ─────────────────────────────────────────────────────────
async function runSom() {
    if (isRunCoolingDown()) return;
    const matrixPath = state.projectData?.matrixNormPath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setStatus(dom.somStatus, "No normalized data found. Run Normalize first.", true);
        return;
    }


    const xDim = parseInt(dom.somXDimInput.value, 10) || 8;
    const yDim = parseInt(dom.somYDimInput.value, 10) || 8;
    const initialization = dom.somInitSelect.value || "sample";
    const neighborhood = dom.somNeighborhoodSelect.value || "gaussian";
    const layout = normalizeSomLayout(dom.somLayoutSelect.value);
    const inputVal = dom.somInputSelect.value;
    const runNewPca = !!dom.runNewPcaCheckbox?.checked;
    if (!inputVal) {
        setStatus(dom.somStatus, "Please select an input source.", true);
        return;
    }
    const isPca = inputVal !== "normalize";
    const metaCol = dom.somMetaColSelect.value || "";
    const selectedLabels = [...state.selectedLabels];

    let pcaRunDataPath = null;
    if (isPca) {
        const pcaRun = state.pcaRuns.find((r) => r.run_id === inputVal);
        if (!pcaRun) { setStatus(dom.somStatus, "Selected PCA run not found.", true); return; }
        if (!pcaRun.data_path) { setStatus(dom.somStatus, "PCA run has no data path.", true); return; }
        pcaRunDataPath = pcaRun.data_path;
    }

    setStatus(dom.somStatus, "Running SOM...");
    dom.runSomBtn.disabled = true;
    showVizLoading("Running SOM...");

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, "som");
        const config = {
            x_dim: xDim,
            y_dim: yDim,
            initialization,
            neighborhood,
            layout,
            meta_col: metaCol,
            input_type: isPca ? "pca" : "normalize",
            selected_count: selectedLabels.length,
            selected_labels: selectedLabels.slice(0, 8),
        };
        const pendingRun = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            name: buildRunName(),
            config,
            date: nowIso(),
            started_at: identity.started_at,
            updated_at: identity.started_at,
            status: "pending",
            message: "Queued for processing.",
        };
        upsertRun(pendingRun);
        await persistRuns();
        renderHistory();
        dom.historyPopup.classList.add("open");

        upsertRun({ ...pendingRun, status: "running", message: "SOM is running..." });
        await persistRuns();

        const requestPromise = fetchJsonWithTimeout(`${vpsUrl}/som/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                name: pendingRun.name,
                input_type: isPca ? "pca" : "normalize",
                matrix_path: matrixPath,
                meta_path: metaPath,
                selected_labels: selectedLabels,
                meta_col: metaCol,
                x_dim: xDim,
                y_dim: yDim,
                initialization,
                neighborhood,
                layout,
                pca_run_data_path: pcaRunDataPath,
                run_new_pcas: runNewPca,
                run_id: identity.run_id,
                task_id: identity.task_id,
            }),
        });

        startRunCooldown();

        void (async () => {
            try {
                const { response: resp, data: result } = await requestPromise;
                if (!resp.ok) throw new Error(result.detail || "SOM failed");

                state.clusterNameMap = { ...(result.data?.cluster_name_map || {}) };
                const run = normalizeRunRecord({
                    ...pendingRun,
                    ...result,
                    config,
                    date: pendingRun.date,
                    started_at: pendingRun.started_at,
                    updated_at: nowIso(),
                    completed_at: nowIso(),
                    status: "done",
                    message: `Done: ${pendingRun.name}`,
                });
                upsertRun(run);
                await persistRuns();
                stopRunCooldown();
                setStatus(dom.somStatus, `Done: ${run.name}`);
                applyRunSelection(run);
            } catch (e) {
                const failedRun = state.runs.find((run) => run.run_id === identity.run_id);
                if (failedRun) {
                    upsertRun({
                        ...failedRun,
                        status: "error",
                        message: e.message || String(e),
                        updated_at: nowIso(),
                        completed_at: nowIso(),
                    });
                    await persistRuns();
                }
                stopRunCooldown();
                setStatus(dom.somStatus, e.message || String(e), true);
                toggleViz(false);
            }
        })();
        return;
    } catch (e) {
        const latestRun = state.runs.find((run) => isBusyRun(run));
        if (latestRun) {
            upsertRun({
                ...latestRun,
                status: "error",
                message: e.message || String(e),
                updated_at: nowIso(),
                completed_at: nowIso(),
            });
            await persistRuns();
        }
        stopRunCooldown();
        setStatus(dom.somStatus, e.message || String(e), true);
        toggleViz(false);
    } finally {
        if (!isRunCoolingDown()) {
            validateRunSomButton();
        }
    }
}

// ── SAVE TO METADATA ───────────────────────────────────────────────────
async function saveToMeta() {
    const run = getCurrentRun();
    if (!run?.data?.cluster_assignments) { setStatus(dom.saveStatus, "No cluster result to save.", true); return; }

    const colName = dom.clusterColName.value.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!colName) { setStatus(dom.saveStatus, "Please enter a column name.", true); return; }

    const metaPath = state.projectData?.metaCheckedPath;
    if (!metaPath) { setStatus(dom.saveStatus, "No metadata path found.", true); return; }

    // Apply rename map to assignments before saving
    const renamedAssignments = {};
    Object.entries(run.data.cluster_assignments).forEach(([sid, orig]) => {
        renamedAssignments[sid] = orig == null ? null : (state.clusterNameMap[orig] || orig);
    });

    setStatus(dom.saveStatus, "Saving...");
    dom.saveToMetaBtn.disabled = true;

    state._metaOpBusy = true;
    try {
        const resp = await fetch(`${vpsUrl}/som/save-clusters`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                meta_path: metaPath,
                cluster_col_name: colName,
                cluster_assignments: renamedAssignments,
                run_id: run.run_id,
                run_name: run.name,
                run_data: run.data,
            }),
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.detail || "Save failed");

        // Persist rename map into the run data
        run.data.cluster_name_map = { ...state.clusterNameMap };

                // Update in-memory metadata so the new cluster column is queryable right away
                run.data.metadata = (run.data.metadata || []).map((row) => ({
                    ...row,
                    [colName]: renamedAssignments[String(row.sample_id)] ?? null,
                }));
                if (!(run.data.metadata_columns || []).includes(colName)) {
                    run.data.metadata_columns = [...(run.data.metadata_columns || []), colName];
                }
                // Pre-emptively add to state.projectData.meta_metadata so selector updates before onSnapshot fires
                if (state.projectData && !(state.projectData.meta_metadata || []).find((m) => m.name === colName)) {
                    state.projectData.meta_metadata = [
                        ...(state.projectData.meta_metadata || []),
                        { name: colName, type: "Categorical" },
                    ];
                }
                buildMetaValueMap();

        await persistRuns();

        setStatus(dom.saveStatus, `Saved as column "${colName}"!`);

    } catch (e) {
        setStatus(dom.saveStatus, e.message || String(e), true);
    } finally {
        state._metaOpBusy = false;
        dom.saveToMetaBtn.disabled = false;
    }
}

// ── SIDEBAR ────────────────────────────────────────────────────────────
async function injectSidebar(userId) {
    const resp = await fetch("./sidebar.html");
    const html = await resp.text();
    dom.sidebarPlaceholder.innerHTML = html;
    dom.sidebarPlaceholder.querySelectorAll("script").forEach(old => { const s = document.createElement("script"); s.textContent = old.textContent; document.head.appendChild(s); });
    dom.sidebarPlaceholder.querySelectorAll("#analysis-nav a").forEach((a) => {
        const href = a.getAttribute("href");
        if (href && href !== "#") a.href = `${href}?id=${projectId}&uid=${userId}`;
    });
    const active = dom.sidebarPlaceholder.querySelector('a[href^="som.html"]');
    if (active) {
        dom.sidebarPlaceholder.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
        active.classList.add("active");
    }
    const exitBtn = document.getElementById("btn-back-projects");
    if (exitBtn) exitBtn.href = `projectID.html?uid=${encodeURIComponent(userId)}`;

    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

// ── INPUT CHANGE ───────────────────────────────────────────────────────
async function onInputChange() {
    // Always clear SOM result when input source changes
    state.currentRunId = null;
    dom.somResultPanel.style.display = "none";
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    await syncFeatureInContext();

    const val = dom.somInputSelect.value;
    dom.somNamePreview.textContent = buildRunName();
    if (!val) {
        toggleViz(false);
        state.selectedLabels.clear();
        dom.somLabelList.innerHTML = '<div class="text-muted" style="font-size:0.7rem;">Please select an input source.</div>';
        return;
    }

    if (val === "normalize") {
        // Clear right panel
        toggleViz(false);
        // For normalize mode: build from project meta (no per-value info available here)
        buildMetaValueMap();
        state.selectedLabels.clear();
        renderLabelList();
    } else {
        // Load PCA run for preview and interactive colors
        showVizLoading("Loading PCA preview...");
        await loadPcaPreview(val);
        // Build label map from PCA run's metadata (available after loadPcaPreview)
        const pcaRun = state.pcaRuns.find((r) => r.run_id === val);
        buildMetaValueMap(pcaRun?.data?.metadata || []);
        // Rebuild label list with colors from PCA
        state.selectedLabels.clear();
        renderLabelList();
    }
}

// ── EVENTS ─────────────────────────────────────────────────────────────
function bindEvents() {
    dom.somNameInput.addEventListener("input", () => { dom.somNamePreview.textContent = buildRunName(); });
    dom.somXDimInput.addEventListener("input", () => { dom.somNamePreview.textContent = buildRunName(); });
    dom.somYDimInput.addEventListener("input", () => { dom.somNamePreview.textContent = buildRunName(); });
    dom.somInitSelect.addEventListener("change", () => { dom.somNamePreview.textContent = buildRunName(); });
    dom.somNeighborhoodSelect.addEventListener("change", () => { dom.somNamePreview.textContent = buildRunName(); });
    dom.somLayoutSelect.addEventListener("change", () => { dom.somNamePreview.textContent = buildRunName(); });

    dom.somInputSelect.addEventListener("change", onInputChange);

    dom.somMetaColSelect.addEventListener("change", () => {
        state.selectedLabels.clear();
        renderLabelList();
        if (isFromPca()) {
            const pcaRun = state.pcaRuns.find((r) => r.run_id === dom.somInputSelect.value);
            if (pcaRun?.data) renderPcaPreview(pcaRun);
        }
    });

    dom.runSomBtn.addEventListener("click", runSom);

    dom.historyToggle.addEventListener("click", () => { dom.historyPopup.classList.toggle("open"); });
    document.addEventListener("click", (e) => {
        if (!dom.historyPopup.contains(e.target) && !dom.historyToggle.contains(e.target))
            dom.historyPopup.classList.remove("open");
    });

    dom.colorBySelect.addEventListener("change", () => {
        state.colorBy = dom.colorBySelect.value;
        state.hiddenLabels.clear();
        state.highlightedLabels.clear();
        state.selectedSampleIds.clear();
        syncFeatureInContext().then(() => renderPlot());
    });

    if (dom.btnAppendMetadata) {
        dom.btnAppendMetadata.addEventListener("click", () => {
            appendHighlightedLabelsToMetadata().catch((error) => {
                setStatus(dom.somStatus, error.message || String(error), true);
            });
        });
    }

    if (dom.btnMetadataManager) {
        dom.btnMetadataManager.addEventListener("click", () => {
            openUnifiedMetadataManager().catch((error) => {
                setStatus(dom.somStatus, error.message || String(error), true);
            });
        });
    }

    dom.paletteSelect.addEventListener("change", () => {
        state.palette = dom.paletteSelect.value;
        state.customLabelColors = {};
        syncFeatureInContext().then(() => {
            renderPlot();
            const run = getCurrentRun();
            if (run) renderClusterRenameList(run);
        });
    });

    dom.ellipseToggle.addEventListener("change", () => {
        state.showEllipse = dom.ellipseToggle.checked;
        renderPlot();
    });

    dom.saveToMetaBtn.addEventListener("click", saveToMeta);

    window.addEventListener("resize", () => { if (getCurrentRun()) renderPlot(); });
}

// ── INIT ───────────────────────────────────────────────────────────────
async function initProject(user) {
    state.user = user;
    await injectSidebar(user.uid);

    if (!projectId) {
        document.body.classList.add("loaded");
        return;
    }

    const snap = await getDoc(doc(db, "projects", projectId));
    state.projectData = snap.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(state.projectData.norm_settings, state.projectData.normality_stat);

    // Load PCA runs from pca_history
    state.pcaRuns = dedupeRuns((state.projectData.pca_history || []).filter((r) => r.type === "PCA").map((r) => ({ ...r, data: null })));
    refreshInputSelector();

    // Load som history
    state.runs = dedupeRuns((state.projectData.som_history || []).map(normalizeRunRecord));
    renderHistory();

    // Populate meta
    populateMetaSelector();

    toggleViz(false);
    dom.somResultPanel.style.display = "none";
    await syncFeatureInContext();

    // Live sync
    onSnapshot(doc(db, "projects", projectId), (s) => {
        const data = s.data() || {};
        const prevMetaSignature = JSON.stringify(state.projectData?.meta_metadata || []);
        state.projectData = { ...(state.projectData || {}), ...data };
        const nextMetaSignature = JSON.stringify(state.projectData?.meta_metadata || []);
        const metaChanged = prevMetaSignature !== nextMetaSignature;
        const effectiveMetaChanged = metaChanged && !state._metaOpBusy;

        // Update PCA runs list
        const newPcaRuns = (data.pca_history || []).filter((r) => r.type === "PCA");
        state.pcaRuns = dedupeRuns(newPcaRuns.map((r) => {
            const existing = state.pcaRuns.find((p) => p.run_id === r.run_id);
            if (existing && !effectiveMetaChanged) return existing;
            return { ...r, data: null };
        }));
        refreshInputSelector();

        // Update som history
        if (data.som_history) {
            const incoming = dedupeRuns(data.som_history.map(normalizeRunRecord));
            state.runs = incoming.map((inc) => {
                const ex = state.runs.find((r) => r.run_id === inc.run_id);
                if (ex?.data?.plot_points) return { ...inc, data: ex.data };
                return inc;
            });
            renderHistory();
        }

        populateMetaSelector();
    });
}

bindEvents();
dom.somNamePreview.textContent = buildRunName();
dom.paletteSelect.value = state.palette;
toggleViz(false);

onAuthStateChanged(auth, async (user) => {
    if (user && projectId) {
        await initProject(user);
        document.body.classList.add("loaded");
    } else if (!projectId) {
        document.body.classList.add("loaded");
    }
});

mountPlotConfigPanel({
    anchor: document.getElementById("plot-config-anchor"),
    defaults: plotConfig,
    options: { showLabelSize: false, showEllipseOpacity: true },
    onUpdate: (_key, _val, allCfg) => { Object.assign(plotConfig, allCfg); renderPlot(); },
    onDownload: (cfg) => {
        if (!dom.plotWrap?.layout) return;
        Plotly.downloadImage(dom.plotWrap, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "som_plot" });
    },
});

