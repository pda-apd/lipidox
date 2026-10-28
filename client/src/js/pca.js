import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { MULTIVAR_PALETTE_MAP, createMultivarFeatureIn, getCurrentPlotRanges, buildMultivarScatterLayout, getMultivarPlotOptions, renderEmptyMultivarPlot, bindLassoSelection } from "./multivar-common.js";
import { fetchJsonWithTimeout, formatTaskId, getTaskStatusBadge, normalizeTaskStatus, nowIso, prepareAnalysisTask } from "./task-utils.js";
import { sortMetadataLabels, normalizeMetaLabel } from "./meta-label-utils.js";
import { createAnalysisCore } from "./analysis-shared.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { ref, getDownloadURL, deleteObject } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const plotConfig = { ...PLOT_CONFIG_DEFAULTS, ellipseOpacity: 0.15 };

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");
const autoDefaultPca = urlParams.get("auto_default_pca") === "1";

const state = {
    projectData: null,
    runs: [],
    currentRunId: null,
    pendingRunId: null,
    selectedPcaRunId: null,
    hiddenLabels: new Set(),
    highlightedLabels: new Set(),
    selectedSampleIds: new Set(),
    colorBy: null,
    palette: "vivid",
    showEllipse: false,
    user: null,
    customLabelColors: {},
    _metaOpBusy: false,
};

const paletteMap = MULTIVAR_PALETTE_MAP;

const dom = {
    pcaDimRadios: () => document.querySelectorAll('input[name="pcaDim"]'),
    pcaNameInput: document.getElementById("pcaNameInput"),
    pcaNamePreview: document.getElementById("pcaNamePreview"),
    normSummaryCard: null,
    normSummaryBody: null,
    runPcaBtn: document.getElementById("runPcaBtn"),
    pcaStatus: document.getElementById("pcaStatus"),
    pcaSourceSelect: document.getElementById("pcaSourceSelect"),
    embeddingMethod: document.getElementById("embeddingMethod"),
    embeddingNameInput: document.getElementById("embeddingNameInput"),
    embeddingNamePreview: document.getElementById("embeddingNamePreview"),
    runEmbeddingBtn: document.getElementById("runEmbeddingBtn"),
    embeddingStatus: document.getElementById("embeddingStatus"),
    umapParams: document.getElementById("umapParams"),
    tsneParams: document.getElementById("tsneParams"),
    umapNeighbors: document.getElementById("umapNeighbors"),
    umapMinDist: document.getElementById("umapMinDist"),
    umapMetric: document.getElementById("umapMetric"),
    tsnePerplexity: document.getElementById("tsnePerplexity"),
    tsneLearningRate: document.getElementById("tsneLearningRate"),
    tsneMaxIter: document.getElementById("tsneMaxIter"),
    historyToggle: document.getElementById("historyToggle"),
    historyPopup: document.getElementById("historyPopup"),
    colorBySelect: document.getElementById("colorBySelect"),
    btnMetadataManager: document.getElementById("btnMetadataManager"),
    paletteSelect: document.getElementById("paletteSelect"),
    ellipseToggle: document.getElementById("ellipseToggle"),
    legendList: document.getElementById("legendList"),
    btnAppendMetadata: document.getElementById("btnAppendMetadata"),
    plotWrap: document.getElementById("plotWrap"),
    vizEmpty: document.getElementById("vizEmpty"),
    vizContent: document.getElementById("vizContent"),
    vizSettingsLeft: document.getElementById("vizSettingsLeft"),
    pcVarianceInfo: document.getElementById("pcVarianceInfo"),
    sidebarPlaceholder: document.getElementById("sidebar-placeholder"),
    featureSearchInput: document.getElementById("featureSearchInput"),
    featureSearchResults: document.getElementById("featureSearchResults"),
    featureScaleMode: document.getElementById("featureScaleMode"),
    featureSearchStatus: document.getElementById("featureSearchStatus"),
    featureCurrentSummary: document.getElementById("featureCurrentSummary"),
    featureSelectedList: document.getElementById("featureSelectedList"),
    featureClearAllBtn: document.getElementById("featureClearAllBtn"),
    featureDistributionPlot: document.getElementById("featureDistributionPlot"),
    featureOverlayLegend: document.getElementById("featureOverlayLegend"),
    pcaBatchCorrCheck: document.getElementById("pcaBatchCorrCheck"),
    pcaBatchColWrap: document.getElementById("pcaBatchColWrap"),
    pcaBatchColSelect: document.getElementById("pcaBatchColSelect"),
};

const featureIn = createMultivarFeatureIn({
    dom,
    onSelectionChange: () => renderPlot(),
    paletteMap,
});

const {
    safeString, sanitizeSuffix, sanitizeHtml, labelOrNone, isBusyRun, dedupeRuns, setStatus,
    isLabelHighlighted, hasHighlightSelection, toggleHighlightedLabel,
    getCurrentRun, normalizeRunRecord, upsertRun, buildRunRecords, persistRuns,
    ensureRunData,
    getNormalizationConfig, renderNormalizationSummary,
    toggleViz, getFeatureOverlay, syncFeatureInContext,
    buildColorMap, groupPoints, ellipseTraceForGroup,
    updateAppendButtonState, refreshColorOptions, renderLegend,
    reloadAllRunMetadata,
    appendHighlightedLabelsToMetadata, applyMetadataColumnEdits,
    createNewMetadataColumn, deleteMetadataColumns, openUnifiedMetadataManager,
    injectSidebar,
    bindCommonVizEvents,
} = createAnalysisCore({
    state, dom, db, storage, projectId, vpsUrl, featureIn, paletteMap,
    historyKey: "pca_history",
    activePageFile: "pca.html",
    runLabel: "PCA",
    statusEl: () => dom.pcaStatus,
    applyRunSelection,
    extraRunFields: (r) => ({ type: r.type, parent_pca_run_id: r.parent_pca_run_id || null, config: r.config || {} }),
    extraRunFields: (r) => ({ type: r.type, parent_pca_run_id: r.parent_pca_run_id || null, config: r.config || {} }),
    renderPlot,
});

const cooldownTimers = new Map();
const cooldownUntil = new Map();

function isCoolingDown(key) {
    return (cooldownUntil.get(key) || 0) > Date.now();
}

function getCooldownSecondsRemaining(key) {
    return Math.max(1, Math.ceil(((cooldownUntil.get(key) || 0) - Date.now()) / 1000));
}

function refreshButtonCooldown(key, button, idleHtml, restoreDisabled) {
    if (!button) return;
    if (isCoolingDown(key)) {
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${getCooldownSecondsRemaining(key)}s`;
        return;
    }
    cooldownUntil.set(key, 0);
    button.disabled = Boolean(restoreDisabled());
    button.innerHTML = idleHtml;
}

function startButtonCooldown(key, button, idleHtml, restoreDisabled) {
    cooldownUntil.set(key, Date.now() + RUN_SUBMIT_COOLDOWN_MS);
    if (cooldownTimers.get(key)) clearInterval(cooldownTimers.get(key));
    refreshButtonCooldown(key, button, idleHtml, restoreDisabled);
    cooldownTimers.set(key, setInterval(() => {
        if (!isCoolingDown(key)) {
            clearInterval(cooldownTimers.get(key));
            cooldownTimers.delete(key);
        }
        refreshButtonCooldown(key, button, idleHtml, restoreDisabled);
    }, 250));
}

function getPcaDim() {
    const checked = [...dom.pcaDimRadios()].find((radio) => radio.checked);
    return checked ? Number(checked.value) : 20;
}

function setPcaDim(dim) {
    [...dom.pcaDimRadios()].forEach((radio) => {
        radio.checked = Number(radio.value) === Number(dim);
    });
}

function buildPcaName() {
    const suffix = sanitizeSuffix(dom.pcaNameInput.value) || `run_${Date.now()}`;
    const dim = getPcaDim();
    return `PCA_${dim === 0 ? "Auto" : dim + "dm"}_${suffix}`;
}

function buildEmbeddingName() {
    const suffix = sanitizeSuffix(dom.embeddingNameInput.value) || `run_${Date.now()}`;
    const method = dom.embeddingMethod.value;
    // PCA source label
    const pcaSrc = dom.pcaSourceSelect.selectedOptions[0]?.textContent || "PCA";
    const pcaLabel = pcaSrc.replace(/^PCA:\s*/, "").replace(/\s+/g, "_");
    // Params in the name
    let paramStr = "";
    if (method === "UMAP") {
        const nn = dom.umapNeighbors.value;
        const md = dom.umapMinDist.value;
        const mt = dom.umapMetric.value;
        paramStr = `nn${nn}_md${md}_${mt}`;
    } else {
        const pp = dom.tsnePerplexity.value;
        const lr = dom.tsneLearningRate.value;
        const mi = dom.tsneMaxIter.value;
        paramStr = `pp${pp}_lr${lr}_it${mi}`;
    }
    return `${method}_${pcaLabel}_${paramStr}_${suffix}`;
}

function showVizLoading(message = "Loading...") {
    toggleViz(true);
    if (dom.legendList) dom.legendList.innerHTML = "";
    if (dom.pcVarianceInfo) dom.pcVarianceInfo.textContent = message;
    dom.plotWrap.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;color:#6c757d;font-size:0.9rem;">
            <span class="spinner-border spinner-border-sm text-secondary me-2" role="status" aria-hidden="true"></span>${message}
        </div>
    `;
}

function getSelectedPcaRun() {
    const selectedId = dom.pcaSourceSelect.value;
    if (selectedId) {
        return state.runs.find((run) => run.run_id === selectedId && run.type === "PCA") || null;
    }
    return state.runs.find((run) => run.run_id === state.selectedPcaRunId && run.type === "PCA") || null;
}

function refreshPcaSourceList() {
    const pcaRuns = state.runs.filter((r) => r.type === "PCA");
    const prevValue = dom.pcaSourceSelect.value;
    dom.pcaSourceSelect.innerHTML = "";
    if (pcaRuns.length === 0) {
        dom.pcaSourceSelect.innerHTML = '<option value="" disabled selected>-- Run PCA first --</option>';
        dom.runEmbeddingBtn.disabled = true;
        return;
    }
    pcaRuns.forEach((run) => {
        const opt = document.createElement("option");
        opt.value = run.run_id;
        opt.textContent = `PCA: ${run.name}`;
        dom.pcaSourceSelect.appendChild(opt);
    });
    // Restore previous selection or select first
    if (prevValue && pcaRuns.some((r) => r.run_id === prevValue)) {
        dom.pcaSourceSelect.value = prevValue;
    } else if (state.selectedPcaRunId && pcaRuns.some((r) => r.run_id === state.selectedPcaRunId)) {
        dom.pcaSourceSelect.value = state.selectedPcaRunId;
    } else {
        dom.pcaSourceSelect.value = pcaRuns[0].run_id;
    }
    dom.runEmbeddingBtn.disabled = false;
}

function getDefaultRunId() {
    return state.projectData?.default_multivar_run_id || state.projectData?.default_pca_run_id || null;
}

async function setDefaultRun(runId) {
    const run = state.runs.find((item) => item.run_id === runId);
    if (!run) return;

    // Persist the currently displayed "Color By Metadata" column together with
    // the default run, so reloading the project restores both the view and the
    // color grouping.
    const payload = { default_multivar_run_id: runId, default_color_by: state.colorBy || null };
    if (run.type === "PCA") payload.default_pca_run_id = runId;

    try {
        await updateDoc(doc(db, "projects", projectId), payload);
        state.projectData = { ...(state.projectData || {}), ...payload };
        renderHistory();
        setStatus(dom.pcaStatus, `Default view set: ${run.type} - ${run.name}`);
    } catch (error) {
        setStatus(dom.pcaStatus, error.message || String(error), true);
    }
}

async function syncRunViewAfterSnapshot() {
    const pendingRun = state.pendingRunId
        ? state.runs.find((run) => run.run_id === state.pendingRunId) || null
        : null;

    if (pendingRun) {
        await applyRunSelection(pendingRun);
        state.pendingRunId = null;
        return;
    }

    const activeRun = getCurrentRun();
    if (!activeRun || !dom.vizContent.classList.contains("active")) {
        return;
    }

    const loaded = await ensureRunData(activeRun);
    if (!loaded) {
        return;
    }

    refreshColorOptions();
    updateEllipseAvailability();
    renderHistory();
    await syncFeatureInContext();
    renderPlot({ preserveRanges: false });
}

async function applyRunSelection(run, fromHistory = false) {
    state.currentRunId = run.run_id;
    if (run.type === "PCA") {
        state.selectedPcaRunId = run.run_id;
    } else if (run.parent_pca_run_id) {
        state.selectedPcaRunId = run.parent_pca_run_id;
    }

    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds.clear();

    renderHistory();
    showVizLoading("Loading...");

    setStatus(dom.pcaStatus, "Loading data...");
    const loaded = await ensureRunData(run);
    if (!loaded) {
        toggleViz(false);
        return;
    }
    setStatus(dom.pcaStatus, "");

    refreshColorOptions();
    toggleViz(true);
    updateEllipseAvailability();
    renderHistory();
    await syncFeatureInContext();
    renderPlot({ preserveRanges: false });

    if (fromHistory) {
        dom.historyPopup.classList.remove("open");
    }
}

function refreshBatchColOptions() {
    if (!dom.pcaBatchColSelect) return;
    const projectColumns = (state.projectData?.meta_metadata || []).map((m) => m?.name).filter(Boolean);
    const columns = sortMetadataLabels(projectColumns);
    const prev = dom.pcaBatchColSelect.value;
    dom.pcaBatchColSelect.innerHTML = '<option value="" disabled>-- Select meta column --</option>';
    columns.forEach((col) => {
        const opt = document.createElement("option");
        opt.value = col;
        opt.textContent = col;
        dom.pcaBatchColSelect.appendChild(opt);
    });
    if (prev && columns.includes(prev)) dom.pcaBatchColSelect.value = prev;
    else if (columns.length > 0) dom.pcaBatchColSelect.value = columns[0];
}

function updatePcVarianceInfo(run) {
    if (run.type === "PCA" && run.data.explained_variance_ratio?.length >= 2) {
        dom.pcVarianceInfo.textContent = `PC1 variance: ${(run.data.explained_variance_ratio[0] * 100).toFixed(2)}% | PC2 variance: ${(run.data.explained_variance_ratio[1] * 100).toFixed(2)}%`;
        return;
    }
    const linkedPca = state.runs.find((item) => item.run_id === run.parent_pca_run_id && item.type === "PCA");
    if (linkedPca?.data?.explained_variance_ratio?.length >= 2) {
        dom.pcVarianceInfo.textContent = `PC1 variance: ${(linkedPca.data.explained_variance_ratio[0] * 100).toFixed(2)}% | PC2 variance: ${(linkedPca.data.explained_variance_ratio[1] * 100).toFixed(2)}%`;
        return;
    }
    dom.pcVarianceInfo.textContent = "";
}

function renderPlot({ preserveRanges = true } = {}) {
    const run = getCurrentRun();
    if (!run) {
        dom.plotWrap.innerHTML = "";
        renderEmptyMultivarPlot(dom.plotWrap);
        return;
    }
    const savedRanges = preserveRanges ? getCurrentPlotRanges(dom.plotWrap) : null;

    updatePcVarianceInfo(run);

    const grouped = groupPoints(run);
    const labels = sortMetadataLabels([...grouped.keys()]);
    const colorMap = buildColorMap(labels);
    const activeFeatureOverlay = getFeatureOverlay();
    renderLegend(grouped, colorMap);

    const traces = [];
    if (activeFeatureOverlay) {
        const metaById = new Map((run.data.metadata || []).map((item) => [String(item.sample_id), item]));
        let showsColorBar = true;

        grouped.forEach((points, label) => {
            if (state.hiddenLabels.has(label)) return;
            const isHighlighted = isLabelHighlighted(label);
            const isDimmed = hasHighlightSelection() && !isHighlighted;
            const finitePoints = [];
            const missingPoints = [];

            points.forEach((point) => {
                const sampleId = String(point.sample_id);
                const expression = activeFeatureOverlay.valuesBySample.get(sampleId);
                const meta = metaById.get(sampleId) || {};
                const groupLabel = safeString(meta[state.colorBy]);
                const enriched = { ...point, sample_id: sampleId, expression, groupLabel };
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
                        size: isHighlighted ? 12 : 9,
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
                        opacity: isDimmed ? 0.15 : isHighlighted ? 1 : 0.88,
                        line: { width: isHighlighted ? 1 : 0.5, color: isHighlighted ? "#111827" : "rgba(255,255,255,0.7)" },
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
                        size: isHighlighted ? 10 : 8,
                        color: "#cbd5e1",
                        opacity: isDimmed ? 0.12 : isHighlighted ? 0.95 : 0.75,
                        line: { width: isHighlighted ? 1 : 0.5, color: isHighlighted ? "#111827" : "#94a3b8" },
                    },
                    showlegend: false,
                });
            }
        });
    } else {
        grouped.forEach((points, label) => {
            if (state.hiddenLabels.has(label)) return;
            const isHighlighted = isLabelHighlighted(label);
            const isDimmed = hasHighlightSelection() && !isHighlighted;
            traces.push({
                type: "scattergl",
                mode: "markers",
                x: points.map((point) => point.x),
                y: points.map((point) => point.y),
                text: points.map((point) => point.sample_id),
                hovertemplate: "<b>%{text}</b><br>x=%{x:.3f}<br>y=%{y:.3f}<extra>" + label + "</extra>",
                marker: { size: isHighlighted ? plotConfig.markerSize + 4 : plotConfig.markerSize, color: colorMap.get(label), opacity: isDimmed ? 0.14 : isHighlighted ? 1 : plotConfig.markerOpacity },
                name: label,
                showlegend: true,
            });

            if (state.showEllipse) {
                const ellipse = ellipseTraceForGroup(label, points, colorMap.get(label), plotConfig.ellipseOpacity);
                if (ellipse) traces.push(ellipse);
            }
        });
    }

    let xTitle = `${run.type}-1`;
    let yTitle = `${run.type}-2`;
    if (run.type === "PCA" && run.data.explained_variance_ratio?.length >= 2) {
        xTitle = `PC1 (${(run.data.explained_variance_ratio[0] * 100).toFixed(2)}%)`;
        yTitle = `PC2 (${(run.data.explained_variance_ratio[1] * 100).toFixed(2)}%)`;
    }

    // Clear any loading placeholder before drawing Plotly canvas.
    dom.plotWrap.innerHTML = "";

    const layout = buildMultivarScatterLayout({
        xTitle,
        yTitle,
        plotConfig,
        savedRanges,
        activeFeatureOverlay,
        showLegend: !activeFeatureOverlay,
    });
    Plotly.newPlot(dom.plotWrap, traces, layout, getMultivarPlotOptions(plotConfig));
    bindLassoSelection({ plotWrap: dom.plotWrap, state, onSelectionChange: updateAppendButtonState });
}

function renderHistory() {
    dom.historyPopup.innerHTML = "";
    if (!state.runs.length) {
        dom.historyPopup.innerHTML = '<div class="history-meta">No runs yet.</div>';
        return;
    }

    state.runs.forEach((run) => {
        const item = document.createElement("div");
        item.className = `history-item d-flex align-items-start gap-2 ${state.currentRunId === run.run_id ? "active" : ""}`;
        const isDefaultRun = run.run_id === getDefaultRunId();
        const displayName = isDefaultRun ? `${run.type}: ${run.name} (Default)` : `${run.type}: ${run.name}`;
        item.title = displayName;

        const info = document.createElement("div");
        info.style.flex = "1";
        info.style.minWidth = "0";
        info.style.cursor = "pointer";
        info.title = displayName;
        info.innerHTML = `
            <div class="history-title">${displayName}</div>
            <div class="history-meta">${new Date(run.date).toLocaleString()}</div>
            <div class="history-meta mt-1">${getTaskStatusBadge(run.status)} <span class="ms-1">${formatTaskId(run)}</span></div>
            <div class="history-meta mt-1">${run.message || ""}</div>
        `;
        info.addEventListener("click", () => {
            if (isBusyRun(run)) return;
            applyRunSelection(run, true);
        });

        const setDefaultBtn = document.createElement("button");
        setDefaultBtn.className = `btn btn-sm py-0 px-1 ${isDefaultRun ? "btn-warning" : "btn-outline-warning"}`;
        setDefaultBtn.style.fontSize = "0.65rem";
        setDefaultBtn.style.flexShrink = "0";
        setDefaultBtn.innerHTML = '<i class="fa-solid fa-star"></i>';
        setDefaultBtn.title = isDefaultRun ? "This is default view" : "Set as default view";
        setDefaultBtn.disabled = isBusyRun(run) || isDefaultRun;
        setDefaultBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void setDefaultRun(run.run_id);
        });

        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-outline-danger btn-sm py-0 px-1";
        delBtn.style.fontSize = "0.65rem";
        delBtn.style.flexShrink = "0";
        delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        delBtn.title = isDefaultRun ? "Cannot delete default view" : "Delete this run";
        delBtn.disabled = isBusyRun(run) || isDefaultRun;
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteRun(run); });

        item.appendChild(info);
        item.appendChild(setDefaultBtn);
        item.appendChild(delBtn);
        dom.historyPopup.appendChild(item);
    });
}

async function deleteRun(run) {
    const defaultRunId = getDefaultRunId();
    const hasDefaultChild = run.type === "PCA" && state.runs.some((r) => r.parent_pca_run_id === run.run_id && r.run_id === defaultRunId);
    if (run.run_id === defaultRunId || hasDefaultChild) {
        setStatus(dom.pcaStatus, "Cannot delete default view. Set another run as default first.", true);
        return;
    }

    if (!confirm(`Delete "${run.type}: ${run.name}"?`)) return;

    // If deleting a PCA, also remove child UMAP/t-SNE that depend on it
    const idsToRemove = new Set([run.run_id]);
    if (run.type === "PCA") {
        state.runs.forEach((r) => {
            if (r.parent_pca_run_id === run.run_id) idsToRemove.add(r.run_id);
        });
    }

    // Delete files from Storage for the runs being removed
    for (const runId of idsToRemove) {
        const runToDelete = state.runs.find((r) => r.run_id === runId);
        if (runToDelete && runToDelete.data_path) {
            try {
                await deleteObject(ref(storage, runToDelete.data_path));
            } catch (error) {
                console.warn(`Failed to delete file for run ${runId}:`, error);
            }
        }
    }

    state.runs = state.runs.filter((r) => !idsToRemove.has(r.run_id));

    // If the current view was deleted, reset to empty
    if (idsToRemove.has(state.currentRunId)) {
        state.currentRunId = null;
        toggleViz(false);
    }
    if (idsToRemove.has(state.selectedPcaRunId)) {
        state.selectedPcaRunId = null;
        dom.runEmbeddingBtn.disabled = true;
    }

    renderHistory();
    refreshPcaSourceList();
    await syncFeatureInContext();
    await persistRuns();
}

function updateEllipseAvailability() {
    const run = getCurrentRun();
    const disableEllipse = !run;
    dom.ellipseToggle.disabled = disableEllipse;
    if (disableEllipse) {
        dom.ellipseToggle.checked = false;
        state.showEllipse = false;
    }
}

async function runPca() {
    const matrixPath = state.projectData?.matrixNormPath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setStatus(dom.pcaStatus, "No normalized matrix or metadata found. Run Normalize first.", true);
        return;
    }

    const useBatch = dom.pcaBatchCorrCheck?.checked || false;
    const batchCol = useBatch ? (dom.pcaBatchColSelect?.value || null) : null;
    if (useBatch && !batchCol) {
        setStatus(dom.pcaStatus, "Please select a batch column for ComBat correction.", true);
        return;
    }

    if (isCoolingDown("pca")) return;
    setStatus(dom.pcaStatus, "Running PCA...");
    dom.runPcaBtn.disabled = true;
    showVizLoading("Loading...");

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, "pca");
        const pendingRun = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            type: "PCA",
            name: buildPcaName(),
            config: {
                n_components: getPcaDim(),
                normalization: getNormalizationConfig() || {},
                batch_col: batchCol,
            },
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

        upsertRun({ ...pendingRun, status: "running", message: "PCA is running..." });
        await persistRuns();

        setStatus(dom.pcaStatus, `${pendingRun.name} is pending...`);
        startButtonCooldown("pca", dom.runPcaBtn, '<i class="fa-solid fa-play me-2"></i>RUN PCA', () => false);

        void (async () => {
            const { response, data: result } = await fetchJsonWithTimeout(`${vpsUrl}/pca/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                name: pendingRun.name,
                n_components: getPcaDim(),
                matrix_path: matrixPath,
                meta_path: metaPath,
                normalization: getNormalizationConfig() || {},
                batch_col: batchCol,
                run_id: identity.run_id,
                task_id: identity.task_id,
            }),
            });
            if (!response.ok) throw new Error(result.detail || "PCA failed");

            const run = normalizeRunRecord({
                ...pendingRun,
                ...result,
                date: pendingRun.date,
                started_at: pendingRun.started_at,
                updated_at: nowIso(),
                completed_at: nowIso(),
                status: "done",
                message: `Done: ${pendingRun.name}`,
            });
            upsertRun(run);
            state.pendingRunId = run.run_id;
            await persistRuns();
            refreshPcaSourceList();
            if (autoDefaultPca && !getDefaultRunId()) {
                try {
                    await updateDoc(doc(db, "projects", projectId), {
                        default_pca_run_id: run.run_id,
                        default_multivar_run_id: run.run_id,
                    });
                    state.projectData = {
                        ...state.projectData,
                        default_pca_run_id: run.run_id,
                        default_multivar_run_id: run.run_id,
                    };
                } catch (err) {
                    console.warn("Failed to save default PCA run id:", err);
                }
            }
            setStatus(dom.pcaStatus, `Done: ${run.name}`);
            await applyRunSelection(run);
            state.pendingRunId = null;
        })().catch(async (error) => {
            if (state.pendingRunId || state.runs.length) {
                const latestRun = state.runs.find((run) => isBusyRun(run) && run.type === "PCA");
                if (latestRun) {
                    upsertRun({
                        ...latestRun,
                        status: "error",
                        message: error.message || String(error),
                        updated_at: nowIso(),
                        completed_at: nowIso(),
                    });
                    await persistRuns();
                }
            }
            setStatus(dom.pcaStatus, error.message || String(error), true);
        });
    } catch (error) {
        setStatus(dom.pcaStatus, error.message || String(error), true);
    }
}

function toggleEmbeddingParams() {
    const isUMAP = dom.embeddingMethod.value === "UMAP";
    dom.umapParams.style.display = isUMAP ? "block" : "none";
    dom.tsneParams.style.display = isUMAP ? "none" : "block";
}

function getEmbeddingParams() {
    if (dom.embeddingMethod.value === "UMAP") {
        return {
            n_neighbors: parseInt(dom.umapNeighbors.value) || 15,
            min_dist: parseFloat(dom.umapMinDist.value) || 0.1,
            metric: dom.umapMetric.value || "euclidean",
        };
    }
    return {
        perplexity: parseFloat(dom.tsnePerplexity.value) || 30,
        learning_rate: parseFloat(dom.tsneLearningRate.value) || 200,
        max_iter: parseInt(dom.tsneMaxIter.value) || 1000,
    };
}

async function runEmbedding() {
    const pcaRun = getSelectedPcaRun();
    if (!pcaRun) {
        setStatus(dom.embeddingStatus, "Run or select a PCA result first", true);
        return;
    }

    await ensureRunData(pcaRun);
    if (!pcaRun.data?.embedding) {
        setStatus(dom.embeddingStatus, "PCA embedding data not available. Re-run PCA first.", true);
        return;
    }

    const method = dom.embeddingMethod.value;
    const endpoint = method === "UMAP" ? "/pca/run-umap" : "/pca/run-tsne";
    const params = getEmbeddingParams();
    if (isCoolingDown("embedding")) return;
    setStatus(dom.embeddingStatus, `Running ${method}...`);
    dom.runEmbeddingBtn.disabled = true;
    showVizLoading("Loading...");

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, method.toLowerCase());
        const pendingRun = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            type: method,
            name: buildEmbeddingName(),
            parent_pca_run_id: pcaRun.run_id,
            config: { params },
            date: nowIso(),
            started_at: identity.started_at,
            updated_at: identity.started_at,
            status: "pending",
            message: `Queued ${method} for processing.`,
        };
        upsertRun(pendingRun);
        await persistRuns();
        renderHistory();
        dom.historyPopup.classList.add("open");

        upsertRun({ ...pendingRun, status: "running", message: `${method} is running...` });
        await persistRuns();

        setStatus(dom.embeddingStatus, `${pendingRun.name} is pending...`);
        startButtonCooldown("embedding", dom.runEmbeddingBtn, '<i class="fa-solid fa-play me-2"></i>RUN EMBEDDING', () => !getSelectedPcaRun());

        void (async () => {
            const { response, data: result } = await fetchJsonWithTimeout(`${vpsUrl}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                name: pendingRun.name,
                parent_pca_run_id: pcaRun.run_id,
                pca_embedding: pcaRun.data.embedding,
                sample_ids: pcaRun.data.sample_ids,
                metadata: pcaRun.data.metadata,
                metadata_columns: pcaRun.data.metadata_columns,
                params,
                run_id: identity.run_id,
                task_id: identity.task_id,
            }),
            });
            if (!response.ok) throw new Error(result.detail || `${method} failed`);

            const run = normalizeRunRecord({
                ...pendingRun,
                ...result,
                date: pendingRun.date,
                started_at: pendingRun.started_at,
                updated_at: nowIso(),
                completed_at: nowIso(),
                status: "done",
                message: `Done: ${pendingRun.name}`,
            });
            upsertRun(run);
            state.pendingRunId = run.run_id;
            await persistRuns();
            setStatus(dom.embeddingStatus, `Done: ${run.name}`);
            await applyRunSelection(run);
            state.pendingRunId = null;
        })().catch(async (error) => {
            const latestRun = state.runs.find((run) => isBusyRun(run) && run.type === method);
            if (latestRun) {
                upsertRun({
                    ...latestRun,
                    status: "error",
                    message: error.message || String(error),
                    updated_at: nowIso(),
                    completed_at: nowIso(),
                });
                await persistRuns();
            }
            setStatus(dom.embeddingStatus, error.message || String(error), true);
        });
    } catch (error) {
        setStatus(dom.embeddingStatus, error.message || String(error), true);
    }
}

function bindEvents() {
    dom.pcaNameInput.addEventListener("input", () => { dom.pcaNamePreview.textContent = buildPcaName(); });
    dom.embeddingNameInput.addEventListener("input", () => { dom.embeddingNamePreview.textContent = buildEmbeddingName(); });

    dom.pcaDimRadios().forEach((radio) => {
        radio.addEventListener("change", () => {
            dom.pcaNamePreview.textContent = buildPcaName();
            dom.embeddingNamePreview.textContent = buildEmbeddingName();
        });
    });

    dom.embeddingMethod.addEventListener("change", () => {
        dom.embeddingNamePreview.textContent = buildEmbeddingName();
        updateEllipseAvailability();
        toggleEmbeddingParams();
    });

    dom.pcaSourceSelect.addEventListener("change", () => {
        state.selectedPcaRunId = dom.pcaSourceSelect.value;
        dom.embeddingNamePreview.textContent = buildEmbeddingName();
    });

    // Update name preview when params change
    [dom.umapNeighbors, dom.umapMinDist, dom.umapMetric, dom.tsnePerplexity, dom.tsneLearningRate, dom.tsneMaxIter].forEach((el) => {
        el.addEventListener("change", () => { dom.embeddingNamePreview.textContent = buildEmbeddingName(); });
        if (el.type === "number") el.addEventListener("input", () => { dom.embeddingNamePreview.textContent = buildEmbeddingName(); });
    });

    dom.runPcaBtn.addEventListener("click", runPca);
    dom.runEmbeddingBtn.addEventListener("click", runEmbedding);

    if (dom.pcaBatchCorrCheck) {
        dom.pcaBatchCorrCheck.addEventListener("change", () => {
            if (dom.pcaBatchColWrap) dom.pcaBatchColWrap.style.display = dom.pcaBatchCorrCheck.checked ? "" : "none";
        });
    }

    bindCommonVizEvents();
}

async function initProject(user) {
    state.user = user;
    await injectSidebar(user.uid);
    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    renderNormalizationSummary();
    refreshBatchColOptions();
    state.runs = dedupeRuns((state.projectData.pca_history || []).map(normalizeRunRecord));
    renderHistory();
    refreshPcaSourceList();
    await syncFeatureInContext();

    let shouldHideViz = true;
    const defaultRunId = getDefaultRunId();
    if (defaultRunId) {
        const defaultRun = state.runs.find((run) => run.run_id === defaultRunId);
        if (defaultRun) {
            // Restore the saved "Color By Metadata" column before applying the
            // run, so refreshColorOptions() keeps it and the first render uses
            // it. Falls back gracefully if the column no longer exists.
            const savedColorBy = state.projectData?.default_color_by || null;
            if (savedColorBy) state.colorBy = savedColorBy;
            await applyRunSelection(defaultRun);
            shouldHideViz = false;
        }
    } else if (autoDefaultPca) {
        setPcaDim(20);
        runPca();
    }

    if (shouldHideViz) {
        toggleViz(false);
    }

    onSnapshot(doc(db, "projects", projectId), async (snap) => {
        const data = snap.data();
        const prevMetaSignature = JSON.stringify(state.projectData?.meta_metadata || []);
        state.projectData = { ...(state.projectData || {}), ...(data || {}) };
        const nextMetaSignature = JSON.stringify(state.projectData?.meta_metadata || []);
        const metaChanged = prevMetaSignature !== nextMetaSignature;
        refreshColorOptions();
        refreshBatchColOptions();
        renderNormalizationSummary();
        if (!data?.pca_history) return;
        const incoming = dedupeRuns(data.pca_history.map(normalizeRunRecord));
        // Preserve in-memory data for runs already loaded (skip clearing during local meta ops)
        const effectiveMetaChanged = metaChanged && !state._metaOpBusy;
        state.runs = incoming.map((inc) => {
            const existing = state.runs.find((r) => r.run_id === inc.run_id);
            if (existing?.data?.plot_points && !effectiveMetaChanged) return { ...inc, data: existing.data };
            return inc;
        });
        renderHistory();
        refreshPcaSourceList();
        if (!state._metaOpBusy) await syncRunViewAfterSnapshot();
    });
}

bindEvents();
dom.pcaNamePreview.textContent = buildPcaName();
dom.embeddingNamePreview.textContent = buildEmbeddingName();
dom.paletteSelect.value = state.palette;
toggleEmbeddingParams();
toggleViz(false);

onAuthStateChanged(auth, async (user) => {
    if (user && projectId) {
        await initProject(user);
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
        Plotly.downloadImage(dom.plotWrap, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "scatter_plot" });
    },
});
