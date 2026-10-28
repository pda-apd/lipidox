import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { MULTIVAR_PALETTE_MAP, createMultivarFeatureIn, getCurrentPlotRanges, buildMultivarScatterLayout, getMultivarPlotOptions, renderEmptyMultivarPlot, bindLassoSelection } from "./multivar-common.js";
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
    plsdaNameInput: document.getElementById("plsdaNameInput"),
    runPlsdaBtn: document.getElementById("runPlsdaBtn"),
    plsdaStatus: document.getElementById("plsdaStatus"),
    plsdaTargetMeta: document.getElementById("plsdaTargetMeta"),
    oplsdaGroupSection: document.getElementById("oplsdaGroupSection"),
    oplsdaGroupList: document.getElementById("oplsdaGroupList"),
    oplsdaSelectAllGroups: document.getElementById("oplsdaSelectAllGroups"),
    oplsdaClearGroups: document.getElementById("oplsdaClearGroups"),
    plsdaComponents: document.getElementById("plsdaComponents"),
    plsdaCvFolds: document.getElementById("plsdaCvFolds"),
    plsdaPermutations: document.getElementById("plsdaPermutations"),
    permutationCvFolds: document.getElementById("permutationCvFolds"),
    cvanovaCvFolds: document.getElementById("cvanovaCvFolds"),
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
    runPermutationBtn: document.getElementById("runPermutationBtn"),
    runCvAnovaBtn: document.getElementById("runCvAnovaBtn"),
    permutationStatus: document.getElementById("permutationStatus"),
    cvanovaStatus: document.getElementById("cvanovaStatus"),
    checkingSummary: document.getElementById("checkingSummary"),
    permutationSummary: document.getElementById("permutationSummary"),
    cvAnovaSummary: document.getElementById("cvAnovaSummary"),
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

const defaultVizEmptyMessage = "Run OPLS-DA or load a saved run from history to show visualization and legend.";

const featureIn = createMultivarFeatureIn({
    dom,
    onSelectionChange: () => renderPlot(),
    paletteMap,
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
    historyKey: "oplsda_history",
    activePageFile: "oplsda.html",
    runLabel: "OPLS-DA",
    statusEl: () => dom.plsdaStatus,
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
        dom.runPlsdaBtn.disabled = true;
        dom.runPlsdaBtn.innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${getCooldownSecondsRemaining()}s`;
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

function buildPlsdaName() {
    const suffix = sanitizeSuffix(dom.plsdaNameInput.value) || `run_${Date.now()}`;
    const target = sanitizeSuffix(dom.plsdaTargetMeta.value) || "target";
    return `OPLSDA_${target}_${suffix}`;
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

function renderGroupList(groups, checkedGroups = null) {
    if (!dom.oplsdaGroupList) return;
    if (!groups.length) {
        dom.oplsdaGroupList.innerHTML = '<div class="history-meta">No groups found for selected metadata.</div>';
        return;
    }
    const checked = checkedGroups ? new Set(checkedGroups) : null;
    dom.oplsdaGroupList.innerHTML = groups.map((g) => {
        const isChecked = checked ? checked.has(g) : true;
        return `<div class="form-check"><input class="form-check-input oplsda-group-check" type="checkbox" value="${g}" id="oplsda-g-${g}" ${isChecked ? "checked" : ""}><label class="form-check-label extra-small" for="oplsda-g-${g}">${g}</label></div>`;
    }).join("");
    dom.oplsdaGroupList.querySelectorAll(".oplsda-group-check").forEach((cb) => cb.addEventListener("change", validateRunButton));
}

function getSelectedGroups() {
    if (!dom.oplsdaGroupList) return [];
    return [...dom.oplsdaGroupList.querySelectorAll(".oplsda-group-check:checked")].map((cb) => cb.value);
}

function onTargetMetaChange(preserveChecked = false, checkedGroups = null) {
    const target = dom.plsdaTargetMeta.value;
    const groups = getTargetGroups(target);
    renderGroupList(groups, preserveChecked ? checkedGroups : null);
    validateRunButton();
}

function clampPermutations(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 100;
    return Math.max(10, Math.min(1000, parsed));
}

function getPermutationInputValue() {
    if (!dom.plsdaPermutations) return 100;
    const clamped = clampPermutations(dom.plsdaPermutations.value);
    dom.plsdaPermutations.value = String(clamped);
    return clamped;
}

function clampCvFolds(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.max(2, Math.min(20, parsed));
}

function clampOrthogonal(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(0, Math.min(3, parsed));
}

function getOrthogonalValue() {
    if (!dom.plsdaComponents) return 1;
    const clamped = clampOrthogonal(dom.plsdaComponents.value);
    dom.plsdaComponents.value = String(clamped);
    return clamped;
}

function setOrthogonalValue(value = 1) {
    if (!dom.plsdaComponents) return;
    dom.plsdaComponents.value = String(clampOrthogonal(value));
}

function getCvFoldsValue() {
    if (!dom.plsdaCvFolds) return 5;
    const clamped = clampCvFolds(dom.plsdaCvFolds.value);
    dom.plsdaCvFolds.value = String(clamped);
    return clamped;
}

function getPermutationCvFoldsValue() {
    if (!dom.permutationCvFolds) return 5;
    const clamped = clampCvFolds(dom.permutationCvFolds.value);
    dom.permutationCvFolds.value = String(clamped);
    return clamped;
}

function getCvAnovaCvFoldsValue() {
    if (!dom.cvanovaCvFolds) return 5;
    const clamped = clampCvFolds(dom.cvanovaCvFolds.value);
    dom.cvanovaCvFolds.value = String(clamped);
    return clamped;
}

function formatNum(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "-";
}

function resetCheckingUI(message = "No checking result yet.") {
    if (dom.checkingSummary) {
        dom.checkingSummary.innerHTML = `<div class="checking-line">${message}</div>`;
    }
    if (dom.permutationSummary) {
        dom.permutationSummary.innerHTML = '<div class="checking-line"><strong>Permutation:</strong> -</div>';
    }
    if (dom.cvAnovaSummary) {
        dom.cvAnovaSummary.innerHTML = '<div class="checking-line"><strong>CV-ANOVA:</strong> -</div>';
    }
}

function setPermutationStatus(message, isError = false) {
    if (!dom.permutationStatus) return;
    setStatus(dom.permutationStatus, message, isError);
}

function setCvAnovaStatus(message, isError = false) {
    if (!dom.cvanovaStatus) return;
    setStatus(dom.cvanovaStatus, message, isError);
}

function renderChecking(run) {
    const validation = run?.data?.validation || {};
    const permutation = validation.permutation || {};
    const cvAnova = validation.cv_anova || {};

    if (!validation || (Object.keys(permutation).length === 0 && Object.keys(cvAnova).length === 0)) {
        resetCheckingUI("No checking result found in this run.");
        return;
    }

    const permCv = Number.isFinite(permutation.cv_folds) ? permutation.cv_folds : (run?.config?.permutation_cv_folds || 5);
    const cvaCv = Number.isFinite(cvAnova.cv_folds) ? cvAnova.cv_folds : (run?.config?.cvanova_cv_folds || 5);
    const nPerm = Number.isFinite(permutation.n_permutations) ? permutation.n_permutations : (run?.config?.n_permutations || 100);

    const permPass = permutation.pass;
    const cvaPass = cvAnova.pass;

    if (dom.checkingSummary) {
        dom.checkingSummary.innerHTML = [
            `<div class="checking-line"><strong>Permutation cv_folds:</strong> ${permCv}</div>`,
            `<div class="checking-line"><strong>n_permutations:</strong> ${nPerm}</div>`,
            `<div class="checking-line"><strong>Permutation PASS:</strong> ${typeof permPass === "boolean" ? (permPass ? "Yes" : "No") : "-"}</div>`,
            `<div class="checking-line"><strong>CV-ANOVA cv_folds:</strong> ${cvaCv}</div>`,
            `<div class="checking-line"><strong>CV-ANOVA PASS:</strong> ${typeof cvaPass === "boolean" ? (cvaPass ? "Yes" : "No") : "-"}</div>`,
        ].join("");
    }

    if (dom.permutationSummary) {
        dom.permutationSummary.innerHTML = [
            `<div class="checking-line"><strong>Q2 real:</strong> ${formatNum(permutation.q2_real)}</div>`,
            `<div class="checking-line"><strong>Q2 perm mean:</strong> ${formatNum(permutation.q2_perm_mean)}</div>`,
            `<div class="checking-line"><strong>p-value:</strong> ${formatNum(permutation.p_value, 4)}</div>`,
            `<div class="checking-line"><strong>Rule:</strong> Q2_real > 0 AND p < 0.05 AND Q2_real > Q2_perm_mean</div>`,
        ].join("");
    }

    if (dom.cvAnovaSummary) {
        dom.cvAnovaSummary.innerHTML = [
            `<div class="checking-line"><strong>F-stat:</strong> ${formatNum(cvAnova.f_stat)}</div>`,
            `<div class="checking-line"><strong>p-value:</strong> ${formatNum(cvAnova.p_value, 4)}</div>`,
        ].join("");
    }
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
    if (dom.metricInfo) dom.metricInfo.textContent = "R2X: - | R2Y: - | Q2: -";
    if (dom.pcVarianceInfo) dom.pcVarianceInfo.textContent = "";
    dom.plotWrap.innerHTML = "";
    resetCheckingUI();
}

function showVizEmpty() {
    state.isLoading = false;
    dom.vizEmpty.textContent = defaultVizEmptyMessage;
    toggleViz(false);
    resetCheckingUI();
}

function showVizContent() {
    state.isLoading = false;
    dom.vizEmpty.textContent = defaultVizEmptyMessage;
    toggleViz(true);
}

function renderPlotAfterLayout({ preserveRanges = true } = {}) {
    showVizContent();
    renderPlot({ preserveRanges });
    // Ensure Plotly recalculates dimensions after the container becomes visible.
    requestAnimationFrame(() => {
        if (!dom.plotWrap) return;
        Plotly.Plots.resize(dom.plotWrap);
    });
}

function getBaseCheckingConfig() {
    const targetMeta = dom.plsdaTargetMeta.value;
    const nOrthogonal = getOrthogonalValue();
    const selectedGroups = getSelectedGroups();

    return {
        target_meta: targetMeta,
        n_orthogonal: nOrthogonal,
        selected_groups: selectedGroups.length >= 2 ? selectedGroups : null,
    };
}

function getPermutationCheckingConfig() {
    return {
        ...getBaseCheckingConfig(),
        cv_folds: getPermutationCvFoldsValue(),
        n_permutations: getPermutationInputValue(),
    };
}

function getCvAnovaCheckingConfig() {
    return {
        ...getBaseCheckingConfig(),
        cv_folds: getCvAnovaCvFoldsValue(),
    };
}

function populateTargetMeta() {
    const meta = state.projectData?.meta_metadata || [];
    const eligible = meta.filter((m) => m.type === "Categorical" || m.type === "Ordinal");
    dom.plsdaTargetMeta.innerHTML = "";

    if (!eligible.length) {
        dom.plsdaTargetMeta.innerHTML = '<option value="" selected>-- No categorical/ordinal metadata --</option>';
        dom.runPlsdaBtn.disabled = true;
        renderGroupList([]);
        return;
    }

    const prev = dom.plsdaTargetMeta.value;
    dom.plsdaTargetMeta.innerHTML = '<option value="" selected>-- Select target --</option>' + eligible
        .map((m) => `<option value="${m.name}">${m.name}</option>`)
        .join("");
    if (prev && eligible.some((m) => m.name === prev)) {
        dom.plsdaTargetMeta.value = prev;
        renderGroupList(getTargetGroups(prev));
    } else {
        renderGroupList([]);
    }
}

async function applyRunSelection(run, fromHistory = false) {
    const requestId = ++state.loadRequestId;
    state.currentRunId = run.run_id;
    state.hiddenLabels.clear();
    state.highlightedLabels.clear();
    state.selectedSampleIds.clear();

    renderHistory();
    showVizLoading("Loading...");

    setStatus(dom.plsdaStatus, "Loading data...");
    const loaded = await ensureRunData(run);
    if (requestId !== state.loadRequestId) return;

    if (!loaded) {
        showVizEmpty();
        return;
    }
    setStatus(dom.plsdaStatus, "");

    if (run.config?.target_meta) {
        dom.plsdaTargetMeta.value = run.config.target_meta;
    }
    onTargetMetaChange(true, run.config?.selected_groups || []);
    setOrthogonalValue(Object.prototype.hasOwnProperty.call(run.config || {}, "n_orthogonal") ? run.config.n_orthogonal : 1);
    if (dom.plsdaCvFolds) {
        const folds = run.config?.cv_folds;
        dom.plsdaCvFolds.value = String(clampCvFolds(Number.isFinite(folds) ? folds : 5));
    }
    if (dom.permutationCvFolds) {
        const permFolds = run.config?.permutation_cv_folds;
        dom.permutationCvFolds.value = String(clampCvFolds(Number.isFinite(permFolds) ? permFolds : 5));
    }
    if (dom.cvanovaCvFolds) {
        const cvanovaFolds = run.config?.cvanova_cv_folds;
        dom.cvanovaCvFolds.value = String(clampCvFolds(Number.isFinite(cvanovaFolds) ? cvanovaFolds : 5));
    }
    if (dom.plsdaPermutations) {
        const perm = run.config?.n_permutations;
        dom.plsdaPermutations.value = String(clampPermutations(Number.isFinite(perm) ? perm : 100));
    }
    onTargetMetaChange(true, run.config?.selected_groups || []);

    refreshColorOptions();
    await syncFeatureInContext();
    updateMetricInfo(run);
    updateAxisInfo(run);
    renderChecking(run);
    renderHistory();
    try {
        renderPlotAfterLayout({ preserveRanges: false });
        if (requestId !== state.loadRequestId) return;
    } catch (error) {
        if (requestId !== state.loadRequestId) return;
        setStatus(dom.plsdaStatus, error.message || String(error), true);
        showVizEmpty();
        return;
    }

    if (fromHistory) dom.historyPopup.classList.remove("open");
}

function updateMetricInfo(run) {
    const metrics = run?.data?.metrics || {};
    const r2x = Number.isFinite(metrics.r2x)
        ? (Math.abs(metrics.r2x) > 0 && Math.abs(metrics.r2x) < 1e-3
            ? metrics.r2x.toExponential(2)
            : metrics.r2x.toFixed(3))
        : "-";
    const r2y = Number.isFinite(metrics.r2y) ? metrics.r2y.toFixed(3) : "-";
    const q2 = Number.isFinite(metrics.q2) ? metrics.q2.toFixed(3) : "-";
    dom.metricInfo.textContent = `R2X(pyopls): ${r2x} | R2Y: ${r2y} | Q2: ${q2}`;
}

function updateAxisInfo(run) {
    const axis = run?.data?.axis_labels || {};
    if (axis.x || axis.y) {
        dom.pcVarianceInfo.textContent = `${axis.x || "t_p[1]"} | ${axis.y || "t_o[1]"}`;
    } else {
        dom.pcVarianceInfo.textContent = "";
    }
}

function renderPlot({ preserveRanges = true } = {}) {
    const run = getCurrentRun();
    const previousRanges = (preserveRanges && run) ? getCurrentPlotRanges(dom.plotWrap) : null;
    if (!run) {
        renderEmptyMultivarPlot(dom.plotWrap);
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
    const layout = buildMultivarScatterLayout({
        xTitle: axis.x || "t_p[1]",
        yTitle: axis.y || "t_o[1]",
        plotConfig,
        savedRanges: previousRanges,
        activeFeatureOverlay,
        showLegend: !activeFeatureOverlay,
    });
    Plotly.newPlot(dom.plotWrap, traces, layout, getMultivarPlotOptions(plotConfig));
    bindLassoSelection({ plotWrap: dom.plotWrap, state, onSelectionChange: updateAppendButtonState });
}

function validateRunButton() {
    if (isRunCoolingDown()) {
        refreshRunCooldownUi();
        return;
    }
    const hasTarget = Boolean(dom.plsdaTargetMeta.value);
    const selectedGroups = getSelectedGroups();
    dom.runPlsdaBtn.disabled = !(hasTarget && selectedGroups.length >= 2);
    dom.runPlsdaBtn.innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN';
}

async function runPlsda() {
    const matrixPath = state.projectData?.matrixPreScalePath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setStatus(dom.plsdaStatus, "No normalized matrix or metadata found. Run Normalize first.", true);
        return;
    }

    const runConfig = {
        target_meta: dom.plsdaTargetMeta.value,
        selected_groups: getSelectedGroups(),
        n_orthogonal: getOrthogonalValue(),
        cv_folds: getCvFoldsValue(),
        normalization: getNormalizationConfig() || {},
        s_plot_corr: (document.getElementById("sPlotCorr") || {}).value || "spearman",
        s_plot_scale: (document.getElementById("sPlotScale") || {}).value || "pareto",
    };

    if (!runConfig.target_meta) {
        setStatus(dom.plsdaStatus, "Please select target metadata.", true);
        return;
    }
    if (runConfig.selected_groups.length < 2) {
        setStatus(dom.plsdaStatus, "Please select at least 2 groups.", true);
        return;
    }

    if (isRunCoolingDown()) return;
    setStatus(dom.plsdaStatus, "Running OPLS-DA...");
    dom.runPlsdaBtn.disabled = true;
    showVizLoading("Loading...");

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, "oplsda");
        const pendingRun = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            type: "OPLS-DA",
            name: buildPlsdaName(),
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

        upsertRun({ ...pendingRun, status: "running", message: "OPLS-DA is running..." });
        await persistRuns();

        setStatus(dom.plsdaStatus, `${pendingRun.name} is pending...`);
        startRunCooldown();

        void (async () => {
            const { response, data: result } = await fetchJsonWithTimeout(`${vpsUrl}/oplsda/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                name: pendingRun.name,
                matrix_path: matrixPath,
                meta_path: metaPath,
                target_meta: runConfig.target_meta,
                selected_groups: runConfig.selected_groups,
                n_orthogonal: runConfig.n_orthogonal,
                cv_folds: runConfig.cv_folds,
                normalization: runConfig.normalization,
                s_plot_corr: runConfig.s_plot_corr,
                s_plot_scale: runConfig.s_plot_scale,
                run_id: identity.run_id,
                task_id: identity.task_id,
            }),
            });
            if (!response.ok) throw new Error(result.detail || "OPLS-DA failed");

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
            setStatus(dom.plsdaStatus, `Done: ${run.name}`);
            await applyRunSelection(run);
        })().catch(async (error) => {
            const latestRun = state.runs.find((run) => isBusyRun(run) && run.type === "OPLS-DA");
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
            setStatus(dom.plsdaStatus, error.message || String(error), true);
            showVizEmpty();
        });
    } catch (error) {
        stopRunCooldown();
        setStatus(dom.plsdaStatus, error.message || String(error), true);
        showVizEmpty();
    }
}

async function runPermutationChecking() {
    const run = getCurrentRun();
    if (!run) {
        setPermutationStatus("Please run OPLS-DA or select a run from history first.", true);
        return;
    }

    const matrixPath = state.projectData?.matrixPreScalePath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setPermutationStatus("No normalized matrix or metadata found. Run Normalize first.", true);
        return;
    }

    const cfg = getPermutationCheckingConfig();
    if (!cfg.target_meta) {
        setPermutationStatus("Please select target metadata before checking.", true);
        return;
    }

    if (dom.runPermutationBtn) dom.runPermutationBtn.disabled = true;
    setPermutationStatus("Running permutation...");
    if (dom.permutationSummary) {
        dom.permutationSummary.innerHTML = '<div class="checking-line"><strong>Permutation:</strong> Running...</div>';
    }

    try {
        const response = await fetch(`${vpsUrl}/oplsda/run-checking/permutation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                matrix_path: matrixPath,
                meta_path: metaPath,
                ...cfg,
            }),
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "OPLS-DA permutation checking failed");

        run.data = run.data || {};
        run.data.validation = run.data.validation || {};
        run.data.validation.permutation = {
            ...(result?.data?.permutation || {}),
            cv_folds: cfg.cv_folds,
            n_permutations: cfg.n_permutations,
        };
        run.config = {
            ...(run.config || {}),
            permutation_cv_folds: cfg.cv_folds,
            n_permutations: cfg.n_permutations,
        };
        renderChecking(run);
        setPermutationStatus("Permutation done.");
        await persistRuns();
    } catch (error) {
        setPermutationStatus(error.message || String(error), true);
    } finally {
        if (dom.runPermutationBtn) dom.runPermutationBtn.disabled = false;
    }
}

async function runCvAnovaChecking() {
    const run = getCurrentRun();
    if (!run) {
        setCvAnovaStatus("Please run OPLS-DA or select a run from history first.", true);
        return;
    }

    const matrixPath = state.projectData?.matrixPreScalePath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) {
        setCvAnovaStatus("No normalized matrix or metadata found. Run Normalize first.", true);
        return;
    }

    const cfg = getCvAnovaCheckingConfig();
    if (!cfg.target_meta) {
        setCvAnovaStatus("Please select target metadata before checking.", true);
        return;
    }

    if (dom.runCvAnovaBtn) dom.runCvAnovaBtn.disabled = true;
    setCvAnovaStatus("Running CV-ANOVA...");
    if (dom.cvAnovaSummary) {
        dom.cvAnovaSummary.innerHTML = '<div class="checking-line"><strong>CV-ANOVA:</strong> Running...</div>';
    }

    try {
        const response = await fetch(`${vpsUrl}/oplsda/run-checking/cv-anova`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: state.user.uid,
                matrix_path: matrixPath,
                meta_path: metaPath,
                ...cfg,
            }),
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "OPLS-DA CV-ANOVA checking failed");

        run.data = run.data || {};
        run.data.validation = run.data.validation || {};
        run.data.validation.cv_anova = {
            ...(result?.data?.cv_anova || {}),
            cv_folds: cfg.cv_folds,
        };
        run.config = {
            ...(run.config || {}),
            cvanova_cv_folds: cfg.cv_folds,
        };
        renderChecking(run);
        setCvAnovaStatus("CV-ANOVA done.");
        await persistRuns();
    } catch (error) {
        setCvAnovaStatus(error.message || String(error), true);
    } finally {
        if (dom.runCvAnovaBtn) dom.runCvAnovaBtn.disabled = false;
    }
}

function bindEvents() {
    dom.plsdaNameInput.addEventListener("input", () => {
        if (!dom.plsdaNameInput.value.trim()) return;
        setStatus(dom.plsdaStatus, `Name: ${buildPlsdaName()}`);
    });

    dom.plsdaTargetMeta.addEventListener("change", () => {
        onTargetMetaChange();
    });

    if (dom.oplsdaSelectAllGroups) {
        dom.oplsdaSelectAllGroups.addEventListener("click", () => {
            dom.oplsdaGroupList?.querySelectorAll(".oplsda-group-check").forEach((cb) => { cb.checked = true; });
            validateRunButton();
        });
    }

    if (dom.oplsdaClearGroups) {
        dom.oplsdaClearGroups.addEventListener("click", () => {
            dom.oplsdaGroupList?.querySelectorAll(".oplsda-group-check").forEach((cb) => { cb.checked = false; });
            validateRunButton();
        });
    }

    if (dom.plsdaCvFolds) {
        dom.plsdaCvFolds.addEventListener("change", () => {
            dom.plsdaCvFolds.value = String(getCvFoldsValue());
        });
        dom.plsdaCvFolds.addEventListener("blur", () => {
            dom.plsdaCvFolds.value = String(getCvFoldsValue());
        });
    }

    if (dom.plsdaComponents) {
        dom.plsdaComponents.addEventListener("change", () => {
            dom.plsdaComponents.value = String(getOrthogonalValue());
        });
        dom.plsdaComponents.addEventListener("blur", () => {
            dom.plsdaComponents.value = String(getOrthogonalValue());
        });
    }

    if (dom.permutationCvFolds) {
        dom.permutationCvFolds.addEventListener("change", () => {
            dom.permutationCvFolds.value = String(getPermutationCvFoldsValue());
        });
        dom.permutationCvFolds.addEventListener("blur", () => {
            dom.permutationCvFolds.value = String(getPermutationCvFoldsValue());
        });
    }

    if (dom.cvanovaCvFolds) {
        dom.cvanovaCvFolds.addEventListener("change", () => {
            dom.cvanovaCvFolds.value = String(getCvAnovaCvFoldsValue());
        });
        dom.cvanovaCvFolds.addEventListener("blur", () => {
            dom.cvanovaCvFolds.value = String(getCvAnovaCvFoldsValue());
        });
    }

    if (dom.plsdaPermutations) {
        dom.plsdaPermutations.addEventListener("change", () => {
            dom.plsdaPermutations.value = String(getPermutationInputValue());
        });
        dom.plsdaPermutations.addEventListener("blur", () => {
            dom.plsdaPermutations.value = String(getPermutationInputValue());
        });
    }

    if (dom.runPermutationBtn) {
        dom.runPermutationBtn.addEventListener("click", runPermutationChecking);
    }

    if (dom.runCvAnovaBtn) {
        dom.runCvAnovaBtn.addEventListener("click", runCvAnovaChecking);
    }

    dom.runPlsdaBtn.addEventListener("click", runPlsda);

    bindCommonVizEvents();
}

async function initProject(user) {
    state.user = user;
    await injectSidebar(user.uid);

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    renderNormalizationSummary();
    populateTargetMeta();
    onTargetMetaChange();

    state.runs = dedupeRuns((state.projectData.oplsda_history || []).map(normalizeRunRecord));
    renderHistory();
    showVizEmpty();
    await syncFeatureInContext();
    validateRunButton();

    onSnapshot(doc(db, "projects", projectId), (snap) => {
        const data = snap.data() || {};
        state.projectData = { ...(state.projectData || {}), ...data };
        renderNormalizationSummary();
        populateTargetMeta();

        if (!data.oplsda_history) return;
        const incoming = dedupeRuns(data.oplsda_history.map(normalizeRunRecord));
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
if (dom.plsdaCvFolds) dom.plsdaCvFolds.value = String(clampCvFolds(dom.plsdaCvFolds.value));
setOrthogonalValue(dom.plsdaComponents?.value ?? 1);
if (dom.permutationCvFolds) dom.permutationCvFolds.value = String(clampCvFolds(dom.permutationCvFolds.value));
if (dom.cvanovaCvFolds) dom.cvanovaCvFolds.value = String(clampCvFolds(dom.cvanovaCvFolds.value));
if (dom.plsdaPermutations) dom.plsdaPermutations.value = String(clampPermutations(dom.plsdaPermutations.value));

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
        Plotly.downloadImage(dom.plotWrap, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "scatter_plot" });
    },
});

