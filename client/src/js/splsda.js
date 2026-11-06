import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { createFeatureInModule } from "./feature-in.js";
import { fetchJsonWithTimeout, normalizeTaskStatus, nowIso, prepareAnalysisTask } from "./task-utils.js";
import { sortMetadataLabels, normalizeMetaLabel } from "./meta-label-utils.js";
import { withInteractionLock } from "./ui-busy-lock.js";
import { createAnalysisCore } from "./analysis-shared.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { ref, getDownloadURL } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const plotConfig = { ...PLOT_CONFIG_DEFAULTS, ellipseOpacity: 0.15 };

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");

const state = {
    projectData: null,
    runs: [],
    currentRunId: null,
    loadRequestId: 0,
    isLoading: false,
    hiddenLabels: new Set(),
    highlightedLabels: new Set(),
    colorBy: null,
    palette: "vivid",
    showEllipse: false,
    user: null,
    customLabelColors: {},
    _metaOpBusy: false,
};

const paletteMap = {
    tableau: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AB"],
    set2: ["#ff000d", "#000dff", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    dark2: ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
    vivid: ["#FF0054", "#FF5400", "#FFBD00", "#00C853", "#00B8D9", "#2979FF", "#7C4DFF", "#D500F9", "#F50057", "#00E5FF"],
    neon: ["#39FF14", "#FF3131", "#FFF01F", "#00FFFF", "#FF6EC7", "#FF8C00", "#8A2BE2", "#00FF7F", "#1E90FF", "#FFD700"],
};

const dom = {
    splsdaNameInput: document.getElementById("splsdaNameInput"),
    runSplsdaBtn: document.getElementById("runSplsdaBtn"),
    splsdaStatus: document.getElementById("splsdaStatus"),
    splsdaTargetMeta: document.getElementById("splsdaTargetMeta"),
    splsdaGroupSection: document.getElementById("splsdaGroupSection"),
    splsdaGroupList: document.getElementById("splsdaGroupList"),
    splsdaSelectAllGroups: document.getElementById("splsdaSelectAllGroups"),
    splsdaClearGroups: document.getElementById("splsdaClearGroups"),
    splsdaNcomp: document.getElementById("splsdaNcomp"),
    splsdaKeepX: document.getElementById("splsdaKeepX"),
    splsdaScale: document.getElementById("splsdaScale"),
    splsdaCvFolds: document.getElementById("splsdaCvFolds"),
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
    metricInfo: document.getElementById("metricInfo"),
    normSummaryCard: null,
    normSummaryBody: null,
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
};

const defaultVizEmptyMessage = "Run sPLS-DA or load a saved run from history to show visualization and legend.";

const featureIn = createFeatureInModule({
    searchInput: dom.featureSearchInput,
    results: dom.featureSearchResults,
    scaleMode: dom.featureScaleMode,
    status: dom.featureSearchStatus,
    summary: dom.featureCurrentSummary,
    selectedList: dom.featureSelectedList,
    clearAllButton: dom.featureClearAllBtn,
    distributionPlot: dom.featureDistributionPlot,
    overlayLegend: dom.featureOverlayLegend,
    onSelectionChange: () => renderPlot(),
    getPaletteColors: (palette) => paletteMap[palette] || paletteMap.vivid,
});

const {
    safeString, sanitizeSuffix, sanitizeHtml, labelOrNone, isBusyRun, dedupeRuns, setStatus,
    isLabelHighlighted, hasHighlightSelection, toggleHighlightedLabel,
    getCurrentRun, normalizeRunRecord, upsertRun, buildRunRecords, persistRuns,
    deleteStorageArtifacts, ensureRunData,
    getNormalizationConfig, renderNormalizationSummary,
    toggleViz, getFeatureOverlay, syncFeatureInContext,
    buildColorMap, groupPoints, ellipseTraceForGroup,
    updateAppendButtonState, refreshColorOptions, renderLegend,
    reloadAllRunMetadata,
    appendHighlightedLabelsToMetadata, applyMetadataColumnEdits,
    createNewMetadataColumn, deleteMetadataColumns, openUnifiedMetadataManager,
    injectSidebar, renderHistory, deleteRun, bindCommonVizEvents,
} = createAnalysisCore({
    state, dom, db, storage, projectId, vpsUrl, featureIn, paletteMap,
    historyKey: "splsda_history",
    activePageFile: "splsda.html",
    runLabel: "sPLS-DA",
    statusEl: () => dom.splsdaStatus,
    applyRunSelection,
    extraRunFields: (r) => ({ type: r.type, config: r.config || {} }),
    extraRunFields: (r) => ({ type: r.type, config: r.config || {} }),
    onRunDeleted: showVizEmpty,
    renderPlot,
});

let runCooldownUntil = 0;
let runCooldownTimer = null;

function isRunCoolingDown() {
    return Date.now() < runCooldownUntil;
}

function getCooldownSecondsRemaining() {
    return Math.max(1, Math.ceil((runCooldownUntil - Date.now()) / 1000));
}

function refreshRunCooldownUi() {
    if (isRunCoolingDown()) {
        dom.runSplsdaBtn.disabled = true;
        dom.runSplsdaBtn.innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${getCooldownSecondsRemaining()}s`;
        return;
    }
    runCooldownUntil = 0;
    validateRunButton();
}

function stopRunCooldown() {
    runCooldownUntil = 0;
    if (runCooldownTimer) {
        clearInterval(runCooldownTimer);
        runCooldownTimer = null;
    }
    validateRunButton();
}

function startRunCooldown() {
    runCooldownUntil = Date.now() + RUN_SUBMIT_COOLDOWN_MS;
    if (runCooldownTimer) clearInterval(runCooldownTimer);
    refreshRunCooldownUi();
    runCooldownTimer = setInterval(() => {
        if (!isRunCoolingDown()) {
            clearInterval(runCooldownTimer);
            runCooldownTimer = null;
        }
        refreshRunCooldownUi();
    }, 250);
}

function buildSplsdaName() {
    const suffix = sanitizeSuffix(dom.splsdaNameInput.value) || `run_${Date.now()}`;
    const target = sanitizeSuffix(dom.splsdaTargetMeta.value) || "target";
    return `SPLSDA_${target}_${suffix}`;
}

function getMetaByName(name) {
    return (state.projectData?.meta_metadata || []).find((m) => m.name === name) || null;
}

function getTargetGroups(metaName) {
    const meta = getMetaByName(metaName);
    if (!meta) return [];
    const groups = Array.isArray(meta.groups) ? meta.groups : [];
    return [...new Set(groups.map((g) => String(g)).filter((g) => g && g.toLowerCase() !== "nan"))];
}

function getSelectedGroups() {
    if (!dom.splsdaGroupList) return [];
    return [...dom.splsdaGroupList.querySelectorAll(".splsda-group-check:checked")]
        .map((cb) => cb.value);
}

function renderGroupList(groups, checkedGroups = null) {
    if (!dom.splsdaGroupList) return;
    if (!groups.length) {
        dom.splsdaGroupList.innerHTML = '<div class="history-meta">No groups found.</div>';
        return;
    }
    const checked = checkedGroups ? new Set(checkedGroups) : new Set(groups);
    dom.splsdaGroupList.innerHTML = groups.map((g) => {
        const isChecked = checked.has(g) ? "checked" : "";
        const id = `splsda-grp-${CSS.escape(g)}`;
        return `<div class="form-check">
            <input class="form-check-input splsda-group-check" type="checkbox" value="${g}" id="${id}" ${isChecked}>
            <label class="form-check-label extra-small" for="${id}">${g}</label>
        </div>`;
    }).join("");
    dom.splsdaGroupList.querySelectorAll(".splsda-group-check").forEach((cb) => {
        cb.addEventListener("change", validateRunButton);
    });
}

// ---------------------------------------------------------------------------
// Parse keepX from the text input
// ---------------------------------------------------------------------------
function parseKeepX(ncomp) {
    const raw = (dom.splsdaKeepX?.value || "").trim();
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const nums = parts.map((s) => Math.max(1, parseInt(s, 10) || 50));
    while (nums.length < ncomp) nums.push(nums[nums.length - 1] || 50);
    return nums.slice(0, ncomp);
}

function clampNcomp(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 2;
    return Math.max(2, Math.min(10, parsed));
}

function getNcompValue() {
    if (!dom.splsdaNcomp) return 2;
    const clamped = clampNcomp(dom.splsdaNcomp.value);
    dom.splsdaNcomp.value = String(clamped);
    return clamped;
}

function clampCvFolds(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.max(2, Math.min(20, parsed));
}

function getCvFoldsValue() {
    if (!dom.splsdaCvFolds) return 5;
    const clamped = clampCvFolds(dom.splsdaCvFolds.value);
    dom.splsdaCvFolds.value = String(clamped);
    return clamped;
}

function populateTargetMeta() {
    const meta = state.projectData?.meta_metadata || [];
    const eligible = meta.filter((m) => m.type === "Categorical" || m.type === "Ordinal");
    dom.splsdaTargetMeta.innerHTML = "";

    if (!eligible.length) {
        dom.splsdaTargetMeta.innerHTML = '<option value="" selected>-- No categorical/ordinal metadata --</option>';
        dom.runSplsdaBtn.disabled = true;
        renderGroupList([]);
        return;
    }

    const prev = dom.splsdaTargetMeta.value;
    dom.splsdaTargetMeta.innerHTML = '<option value="" selected>-- Select target --</option>' + eligible
        .map((m) => `<option value="${m.name}">${m.name}</option>`)
        .join("");
    if (prev && eligible.some((m) => m.name === prev)) {
        dom.splsdaTargetMeta.value = prev;
        renderGroupList(getTargetGroups(prev));
    } else {
        renderGroupList([]);
    }
}

function onTargetMetaChange(preserveChecked = false, checkedGroups = null) {
    const target = dom.splsdaTargetMeta.value;
    const groups = target ? getTargetGroups(target) : [];
    renderGroupList(groups, preserveChecked ? checkedGroups : null);
    validateRunButton();
}

async function applyRunSelection(run, fromHistory = false) {
    const requestId = ++state.loadRequestId;
    state.currentRunId = run.run_id;
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();

    renderHistory();
    showVizLoading("Loading...");

    setStatus(dom.splsdaStatus, "Loading data...");
    const loaded = await ensureRunData(run);
    if (requestId !== state.loadRequestId) return;

    if (!loaded) {
        showVizEmpty();
        return;
    }
    setStatus(dom.splsdaStatus, "");

    if (run.config?.target_meta) {
        dom.splsdaTargetMeta.value = run.config.target_meta;
        const groups = getTargetGroups(run.config.target_meta);
        const checkedGroups = Array.isArray(run.config.selected_groups) && run.config.selected_groups.length
            ? run.config.selected_groups
            : groups;
        renderGroupList(groups, checkedGroups);
    }
    if (run.config && run.config.ncomp != null) {
        dom.splsdaNcomp.value = String(clampNcomp(run.config.ncomp));
    }
    if (run.config?.keepX && Array.isArray(run.config.keepX)) {
        dom.splsdaKeepX.value = run.config.keepX.join(",");
    }
    if (dom.splsdaScale && run.config?.scale != null) {
        dom.splsdaScale.checked = Boolean(run.config.scale);
    }
    if (dom.splsdaCvFolds) {
        const folds = run.config?.cv_folds;
        dom.splsdaCvFolds.value = String(clampCvFolds(Number.isFinite(folds) ? folds : 5));
    }

    refreshColorOptions();
    await syncFeatureInContext();
    updateMetricInfo(run);
    updateAxisInfo(run);
    renderHistory();
    try {
        renderPlotAfterLayout({ preserveRanges: false });
        if (requestId !== state.loadRequestId) return;
    } catch (error) {
        if (requestId !== state.loadRequestId) return;
        setStatus(dom.splsdaStatus, error.message || String(error), true);
        showVizEmpty();
        return;
    }

    if (fromHistory) dom.historyPopup.classList.remove("open");
}

function updateMetricInfo(run) {
    const metrics = run?.data?.metrics || {};
    const r2x = Number.isFinite(metrics.r2x) ? (metrics.r2x * 100).toFixed(1) + "%" : "-";
    const ev = metrics.explained_variance_per_comp || [];
    const v1 = ev[0] != null ? Number(ev[0]).toFixed(1) + "%" : "-";
    const v2 = ev[1] != null ? Number(ev[1]).toFixed(1) + "%" : "-";
    dom.metricInfo.textContent = `R2X: ${r2x} | Comp1: ${v1} | Comp2: ${v2}`;
}

function updateAxisInfo(run) {
    const axis = run?.data?.axis_labels || {};
    if (axis.x || axis.y) {
        dom.pcVarianceInfo.textContent = `${axis.x || "Comp 1"} | ${axis.y || "Comp 2"}`;
    } else {
        dom.pcVarianceInfo.textContent = "";
    }
}

function getCurrentPlotRanges() {
    const xRange = dom.plotWrap?.layout?.xaxis?.range;
    const yRange = dom.plotWrap?.layout?.yaxis?.range;
    if (!Array.isArray(xRange) || !Array.isArray(yRange) || xRange.length !== 2 || yRange.length !== 2) return null;
    return { xRange: [...xRange], yRange: [...yRange] };
}

function showVizLoading(message = "Loading...") {
    state.isLoading = true;
    dom.vizEmpty.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;color:#6c757d;font-size:0.9rem;">
            <span class="spinner-border spinner-border-sm text-secondary me-2" role="status" aria-hidden="true"></span>${message}
        </div>
    `;
    toggleViz(false);
    dom.legendList.innerHTML = "";
    if (dom.metricInfo) dom.metricInfo.textContent = "R2X: - | Comp1: - | Comp2: -";
    if (dom.pcVarianceInfo) dom.pcVarianceInfo.textContent = "";
    dom.plotWrap.innerHTML = "";
}

function showVizEmpty() {
    state.isLoading = false;
    dom.vizEmpty.textContent = defaultVizEmptyMessage;
    toggleViz(false);
}

function showVizContent() {
    state.isLoading = false;
    dom.vizEmpty.textContent = defaultVizEmptyMessage;
    toggleViz(true);
}

function renderPlotAfterLayout({ preserveRanges = true } = {}) {
    showVizContent();
    renderPlot({ preserveRanges });
    requestAnimationFrame(() => {
        if (!dom.plotWrap) return;
        Plotly.Plots.resize(dom.plotWrap);
    });
}

function renderPlot({ preserveRanges = true } = {}) {
    const run = getCurrentRun();
    const previousRanges = (preserveRanges && run) ? getCurrentPlotRanges() : null;
    if (!run) {
        Plotly.newPlot(dom.plotWrap, [], { margin: { t: 10, r: 10, b: 10, l: 10 } }, { responsive: true, displaylogo: false });
        return;
    }

    updateMetricInfo(run);
    updateAxisInfo(run);

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
                    x: finitePoints.map((p) => p.x),
                    y: finitePoints.map((p) => p.y),
                    text: finitePoints.map((p) => p.sample_id),
                    customdata: finitePoints.map((p) => [p.groupLabel, p.expression]),
                    hovertemplate: `<b>%{text}</b><br>${activeFeatureOverlay.feature}: %{customdata[1]:.4f}<br>${state.colorBy || "Group"}: %{customdata[0]}<br>x=%{x:.3f}<br>y=%{y:.3f}<extra></extra>`,
                    marker: {
                        size: isHighlighted ? 12 : 9,
                        color: finitePoints.map((p) => p.expression),
                        colorscale: [[0, "#d1d5db"], [0.35, "#f3d2cf"], [0.7, "#d96a62"], [1, "#b81d13"]],
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
                    x: missingPoints.map((p) => p.x),
                    y: missingPoints.map((p) => p.y),
                    text: missingPoints.map((p) => p.sample_id),
                    customdata: missingPoints.map((p) => [p.groupLabel]),
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
                x: points.map((p) => p.x),
                y: points.map((p) => p.y),
                text: points.map((p) => p.sample_id),
                hovertemplate: "<b>%{text}</b><br>x=%{x:.3f}<br>y=%{y:.3f}<extra>" + label + "</extra>",
                marker: {
                    size: isHighlighted ? plotConfig.markerSize + 4 : plotConfig.markerSize,
                    color: colorMap.get(label),
                    opacity: isDimmed ? 0.14 : isHighlighted ? 1 : plotConfig.markerOpacity,
                },
                name: label,
                showlegend: true,
            });

            if (state.showEllipse) {
                const ellipse = ellipseTraceForGroup(label, points, colorMap.get(label), plotConfig.ellipseOpacity);
                if (ellipse) traces.push(ellipse);
            }
        });
    }

    const axis = run.data.axis_labels || {};
    const xAxisLabel = axis.x || "Comp 1";
    const yAxisLabel = axis.y || "Comp 2";
    const xaxis = { title: xAxisLabel, zeroline: false, gridcolor: "#edf1f5" };
    const yaxis = { title: yAxisLabel, zeroline: false, gridcolor: "#edf1f5" };
    if (previousRanges) {
        xaxis.autorange = false;
        xaxis.range = previousRanges.xRange;
        yaxis.autorange = false;
        yaxis.range = previousRanges.yRange;
    }

    Plotly.newPlot(dom.plotWrap, traces, {
        margin: { t: 20, r: activeFeatureOverlay ? 62 : 20, b: 50, l: 60 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: { title: { text: xAxisLabel, font: { size: plotConfig.axisFontSize } }, tickfont: { size: plotConfig.axisFontSize }, zeroline: false, gridcolor: "#edf1f5", ...(xaxis.autorange === false ? { autorange: false, range: xaxis.range } : {}) },
        yaxis: { title: { text: yAxisLabel, font: { size: plotConfig.axisFontSize } }, tickfont: { size: plotConfig.axisFontSize }, zeroline: false, gridcolor: "#edf1f5", ...(yaxis.autorange === false ? { autorange: false, range: yaxis.range } : {}) },
        showlegend: !activeFeatureOverlay,
        legend: { bgcolor: "rgba(255,255,255,0.85)", borderwidth: 1, font: { size: plotConfig.legendFontSize }, x: 1, xanchor: "right", y: 1, yanchor: "top" },
    }, { responsive: true, displayModeBar: "hover", scrollZoom: true, displaylogo: false, toImageButtonOptions: { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === "svg" ? 1 : 6 }, edits: { legendPosition: true } });
}

function validateRunButton() {
    if (isRunCoolingDown()) {
        refreshRunCooldownUi();
        return;
    }
    const hasTarget = Boolean(dom.splsdaTargetMeta.value);
    const selectedGroups = getSelectedGroups();
    const hasEnoughGroups = selectedGroups.length >= 2;
    dom.runSplsdaBtn.disabled = !(hasTarget && hasEnoughGroups);
    dom.runSplsdaBtn.innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN';
}

async function runSplsda() {
    const matrixPath = state.projectData?.matrixPreScalePath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setStatus(dom.splsdaStatus, "No normalized matrix or metadata found. Run Normalize first.", true);
        return;
    }

    const ncomp = getNcompValue();
    const keepX = parseKeepX(ncomp);
    const scale = dom.splsdaScale?.checked !== false;
    const cvFolds = getCvFoldsValue();
    const targetMeta = dom.splsdaTargetMeta.value;
    const selectedGroups = getSelectedGroups();

    if (!targetMeta) {
        setStatus(dom.splsdaStatus, "Please select target metadata.", true);
        return;
    }
    if (selectedGroups.length < 2) {
        setStatus(dom.splsdaStatus, "Please select at least 2 groups.", true);
        return;
    }

    if (isRunCoolingDown()) return;
    setStatus(dom.splsdaStatus, "Running sPLS-DA...");
    dom.runSplsdaBtn.disabled = true;
    showVizLoading("Loading...");

    const runConfig = { target_meta: targetMeta, ncomp, keepX, scale, cv_folds: cvFolds, selected_groups: selectedGroups };

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, "splsda");
        const pendingRun = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            type: "sPLS-DA",
            name: buildSplsdaName(),
            config: runConfig,
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

        upsertRun({ ...pendingRun, status: "running", message: "sPLS-DA is running..." });
        await persistRuns();

        setStatus(dom.splsdaStatus, `${pendingRun.name} is pending...`);
        startRunCooldown();

        void (async () => {
            const { response, data: result } = await fetchJsonWithTimeout(`${vpsUrl}/splsda/run`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    project_id: projectId,
                    uid: state.user.uid,
                    name: pendingRun.name,
                    matrix_path: matrixPath,
                    meta_path: metaPath,
                    target_meta: targetMeta,
                    ncomp,
                    keepX,
                    scale,
                    cv_folds: cvFolds,
                    selected_groups: selectedGroups,
                    run_id: identity.run_id,
                    task_id: identity.task_id,
                }),
            });
            if (!response.ok) throw new Error(result.detail || "sPLS-DA failed");

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
            await persistRuns();
            stopRunCooldown();
            setStatus(dom.splsdaStatus, `Done: ${run.name}`);
            await applyRunSelection(run);
        })().catch(async (error) => {
            const latestRun = state.runs.find((r) => isBusyRun(r) && r.type === "sPLS-DA");
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
            stopRunCooldown();
            setStatus(dom.splsdaStatus, error.message || String(error), true);
            showVizEmpty();
        });
    } catch (error) {
        stopRunCooldown();
        setStatus(dom.splsdaStatus, error.message || String(error), true);
        showVizEmpty();
    }
}

function bindEvents() {
    dom.splsdaNameInput.addEventListener("input", () => {
        if (!dom.splsdaNameInput.value.trim()) return;
        setStatus(dom.splsdaStatus, `Name: ${buildSplsdaName()}`);
    });

    dom.splsdaTargetMeta.addEventListener("change", () => onTargetMetaChange());

    if (dom.splsdaSelectAllGroups) {
        dom.splsdaSelectAllGroups.addEventListener("click", () => {
            dom.splsdaGroupList?.querySelectorAll(".splsda-group-check").forEach((cb) => { cb.checked = true; });
            validateRunButton();
        });
    }
    if (dom.splsdaClearGroups) {
        dom.splsdaClearGroups.addEventListener("click", () => {
            dom.splsdaGroupList?.querySelectorAll(".splsda-group-check").forEach((cb) => { cb.checked = false; });
            validateRunButton();
        });
    }

    if (dom.splsdaNcomp) {
        dom.splsdaNcomp.addEventListener("change", () => {
            dom.splsdaNcomp.value = String(getNcompValue());
        });
        dom.splsdaNcomp.addEventListener("blur", () => {
            dom.splsdaNcomp.value = String(getNcompValue());
        });
    }

    if (dom.splsdaCvFolds) {
        dom.splsdaCvFolds.addEventListener("change", () => {
            dom.splsdaCvFolds.value = String(getCvFoldsValue());
        });
        dom.splsdaCvFolds.addEventListener("blur", () => {
            dom.splsdaCvFolds.value = String(getCvFoldsValue());
        });
    }

    dom.runSplsdaBtn.addEventListener("click", runSplsda);

    bindCommonVizEvents();
}

async function initProject(user) {
    state.user = user;
    await injectSidebar(user.uid);

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    renderNormalizationSummary();
    populateTargetMeta();  // also calls renderGroupList

    state.runs = dedupeRuns((state.projectData.splsda_history || []).map(normalizeRunRecord));
    renderHistory();
    showVizEmpty();
    await syncFeatureInContext();
    validateRunButton();

    onSnapshot(doc(db, "projects", projectId), (snap) => {
        const data = snap.data() || {};
        state.projectData = { ...(state.projectData || {}), ...data };
        renderNormalizationSummary();
        populateTargetMeta();

        if (!data.splsda_history) return;
        const incoming = dedupeRuns(data.splsda_history.map(normalizeRunRecord));
        state.runs = incoming.map((inc) => {
            const existing = state.runs.find((r) => r.run_id === inc.run_id);
            if (existing?.data?.plot_points) return { ...inc, data: existing.data };
            return inc;
        });
        renderHistory();
    });
}

bindEvents();
dom.paletteSelect.value = state.palette;
if (dom.splsdaNcomp) dom.splsdaNcomp.value = String(clampNcomp(dom.splsdaNcomp.value));
if (dom.splsdaCvFolds) dom.splsdaCvFolds.value = String(clampCvFolds(dom.splsdaCvFolds.value));

showVizEmpty();

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
        Plotly.downloadImage(dom.plotWrap, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "splsda_scatter" });
    },
});
