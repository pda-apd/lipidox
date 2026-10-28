import "./auth-gate.js";
import { db, auth, storage } from "./firebase-config.js";
import { createSplitMetaEngine } from "./splitmeta.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { sortMetadataLabels } from "./meta-label-utils.js";
import { normalizeGroupValue, getDistinctMetaValues, getCleanMetaGroupValues, getMetaGroupCountValues, getObservedGroupCounts, parseMetaCsv } from "./meta-csv-utils.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { getDownloadURL, ref, uploadString, deleteObject, listAll } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");

const MAX_ESTIMATORS = 10000;
const DEFAULT_N_TREES = 500;
const DEFAULT_MAX_FEATURES = "sqrt";
const DEFAULT_TOP_FEATURES = 15;
const DEFAULT_TOP_OUTLIERS = 5;

let projectData = null;
let analysisHistory = [];
let currentRunId = null;
let selectedHistoryRunId = null;
let currentPayload = null;
let currentRunContext = null;
let splitEngine = null;
let pendingSplitHistorySnapshot = null;
let currentTab = "classification";
let currentResultsPromise = null;
let currentResultsData = null;
let currentState = {
    visibleFeatures: new Set(),
    visibleSamples: new Set(),
    labelSamples: new Set(),
    selectedSampleId: null,
};
let runCooldownUntil = 0;
let runCooldownTimer = null;
let isBusy = false;
let splitPreloadPromise = null;
let mountedPlotPanels = [];
let featureViolinModal = null;
let featureViolinConfigPanel = null;
let currentViolinFeature = null;
let currentViolinLabels = [];
let selectedModelType = "rf";
let svmImportanceView = "feature";
let forceAutoscaleErrorPlot = false;

let expressionSourceCache = {
    matrixPath: null,
    sampleIds: [],
    featureToValues: new Map(),
};

const dom = {
    sidebarPlaceholder: () => document.getElementById("sidebar-placeholder"),
    historyToggle: () => document.getElementById("rf-history-toggle"),
    historyPopup: () => document.getElementById("rf-history-popup"),
    setupCard: () => document.getElementById("rf-setup-card"),
    analysisName: () => document.getElementById("rf-analysis-name"),
    modeManual: () => document.getElementById("rf-mode-manual"),
    modeSplit: () => document.getElementById("rf-mode-split"),
    manualSection: () => document.getElementById("rf-manual-section"),
    targetSelect: () => document.getElementById("rf-target"),
    comparisonList: () => document.getElementById("rf-comparisons-list"),
    modelType: () => document.getElementById("rf-model-type"),
    rfConfigWrap: () => document.getElementById("rf-config-rf"),
    svmConfigWrap: () => document.getElementById("rf-config-svm"),
    nEstimators: () => document.getElementById("rf-ntree"),
    maxFeatures: () => document.getElementById("rf-max-features"),
    svmKernel: () => document.getElementById("svm-kernel"),
    svmC: () => document.getElementById("svm-C"),
    svmCvFolds: () => document.getElementById("svm-cv-folds"),
    svmClassWeight: () => document.getElementById("svm-class-weight"),
    svmNBootstrap: () => document.getElementById("svm-n-bootstrap"),
    svmCiLevel: () => document.getElementById("svm-ci-level"),
    svmCutoffMethod: () => document.getElementById("svm-cutoff-method"),
    svmNRepeatsWrap: () => document.getElementById("svm-n-repeats-wrap"),
    svmNRepeatsPermutation: () => document.getElementById("svm-n-repeats-permutation"),
    runButton: () => document.getElementById("rf-run-btn"),
    runStatus: () => document.getElementById("rf-run-status"),
    splitConfigHost: () => document.getElementById("rf-split-config-host"),
    splitWorkspace: () => document.getElementById("rf-split-workspace"),
    resultsArea: () => document.getElementById("rf-results-area"),
    emptyState: () => document.getElementById("rf-empty-state"),
    resultTabsSection: () => document.getElementById("rf-result-tabs-section"),
    resultTabs: () => document.querySelectorAll("[data-rf-tab]"),
    resultTabRow: () => document.querySelector(".rf-result-tab-row"),
    outlierTab: () => document.querySelector('[data-rf-tab="outlier"]'),
    classificationSection: () => document.getElementById("rf-classification-section"),
    importanceSection: () => document.getElementById("rf-importance-section"),
    outlierSection: () => document.getElementById("rf-outlier-section"),
    importanceTableBody: () => document.getElementById("rf-importance-table-body"),
    importanceCount: () => document.getElementById("rf-importance-count"),
    importanceDownload: () => document.getElementById("rf-importance-download"),
    outlierTableBody: () => document.getElementById("rf-outlier-table-body"),
    outlierCount: () => document.getElementById("rf-outlier-count"),
    outlierDownload: () => document.getElementById("rf-outlier-download"),
    importanceSort: () => document.getElementById("rf-importance-sort"),
    importanceClass: () => document.getElementById("rf-importance-class"),
    importanceSearch: () => document.getElementById("rf-importance-search"),
    outlierSort: () => document.getElementById("rf-outlier-sort"),
    outlierClass: () => document.getElementById("rf-outlier-class"),
    outlierSearch: () => document.getElementById("rf-outlier-search"),
    classificationInfo: () => document.getElementById("rf-classification-info"),
    importanceInfo: () => document.getElementById("rf-importance-info"),
    outlierInfo: () => document.getElementById("rf-outlier-info"),
    featureViolinModal: () => document.getElementById("rf-feature-violin-modal"),
    featureViolinTitle: () => document.getElementById("rf-feature-violin-title"),
    featureViolinPlot: () => document.getElementById("rf-feature-violin-plot"),
    featureViolinConfigAnchor: () => document.getElementById("rf-feature-violin-config-anchor"),
    titleError: () => document.getElementById("rfd-title-error"),
    titleOutlier: () => document.getElementById("rfd-title-outlier"),
    svmImportanceModeToggle: () => document.getElementById("svm-importance-mode-toggle"),
    svmViewFeatureBtn: () => document.getElementById("svm-view-feature"),
    svmViewBoundaryBtn: () => document.getElementById("svm-view-boundary"),
};

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getMetaDescriptorByName(columnName) {
    return (projectData?.meta_metadata || []).find((item) => item?.name === columnName) || null;
}

function getManualGroupValues(columnName) {
    const meta = getMetaDescriptorByName(columnName);
    const configured = getCleanMetaGroupValues(meta);
    if (configured.length) return configured;
    const counted = getMetaGroupCountValues(meta);
    if (counted.length) return counted;
    return getDistinctMetaValues(columnName, splitSourceCache.sampleToMeta);
}

function getManualGroupEntries(columnName) {
    const labels = getManualGroupValues(columnName);
    const observedCounts = getObservedGroupCounts(columnName, splitSourceCache.sampleToMeta);
    const meta = getMetaDescriptorByName(columnName);
    const fallbackCounts = meta?.group_counts && typeof meta.group_counts === "object"
        ? new Map(Object.entries(meta.group_counts).map(([label, count]) => [normalizeGroupValue(label), Number(count) || 0]))
        : new Map();

    return labels.map((label) => ({
        label,
        count: observedCounts.get(normalizeGroupValue(label)) ?? fallbackCounts.get(normalizeGroupValue(label)) ?? 0,
    }));
}

function buildPairOptions(groups) {
    const pairs = [];
    for (let i = 0; i < groups.length; i += 1) {
        for (let j = i + 1; j < groups.length; j += 1) {
            pairs.push({
                value: `${groups[i]}|||${groups[j]}`,
                label: `${groups[i]} vs ${groups[j]}`,
                selectedGroups: [groups[i], groups[j]],
            });
        }
    }
    return pairs;
}

function renderComparisonOptions() {
    const list = dom.comparisonList();
    const target = dom.targetSelect()?.value;
    if (!list) return;
    if (!target) {
        list.innerHTML = "";
        return;
    }
    const groupEntries = getManualGroupEntries(target);
    if (groupEntries.length < 2) {
        list.innerHTML = '<div class="text-muted extra-small">No valid comparison pairs found for this metadata column.</div>';
        return;
    }
    const groups = groupEntries.map((entry) => entry.label);
    const pairOptions = buildPairOptions(groups);
    const countMap = new Map(groupEntries.map((entry) => [entry.label, entry.count]));

    let html = `<div class="form-check"><input class="form-check-input rf-comp-check" type="radio" name="rf-comparison" value="__all__" id="rf-comp-all" checked><label class="form-check-label extra-small" for="rf-comp-all">All groups (${groups.length})</label></div>`;
    pairOptions.forEach((pair, index) => {
        const leftCount = countMap.get(pair.selectedGroups[0]) ?? 0;
        const rightCount = countMap.get(pair.selectedGroups[1]) ?? 0;
        const pairLabel = `${pair.selectedGroups[0]} (${leftCount}) vs ${pair.selectedGroups[1]} (${rightCount})`;
        const id = `rf-comp-${index}`;
        html += `<div class="form-check"><input class="form-check-input rf-comp-check" type="radio" name="rf-comparison" value="${escapeHtml(pair.value)}" id="${id}"><label class="form-check-label extra-small" for="${id}">${escapeHtml(pairLabel)}</label></div>`;
    });

    list.innerHTML = html;
}

function getSelectedComparisonValue() {
    return document.querySelector(".rf-comp-check:checked")?.value || "";
}

function getEligibleGroupedMetaColumns(minGroups = 2) {
    const orderedNames = sortMetadataLabels(Array.isArray(splitSourceCache.metaHeader) && splitSourceCache.metaHeader.length
        ? splitSourceCache.metaHeader
        : (Array.isArray(projectData?.meta_metadata) ? projectData.meta_metadata.map((item) => item?.name).filter(Boolean) : []));

    return orderedNames
        .map((name) => {
            const meta = getMetaDescriptorByName(name);
            const groups = getCleanMetaGroupValues(meta).length ? getCleanMetaGroupValues(meta) : (getMetaGroupCountValues(meta).length ? getMetaGroupCountValues(meta) : getDistinctMetaValues(name, splitSourceCache.sampleToMeta));
            return { ...(meta || {}), name, groups };
        })
        .filter((item) => item.name && item.groups.length >= minGroups)
        .sort((left, right) => left.name.localeCompare(right.name));
}

let currentMode = "manual";
let splitValid = false;

const splitSourceCache = {
    metaPath: null,
    metaHeader: [],
    sampleToMeta: new Map(),
};

async function getStorageCsvText(path) {
    if (!path) throw new Error("Missing metadata file path in project settings.");
    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load metadata file from local storage.");
    return response.text();
}

async function ensureSplitMetaLoaded(metaPathOverride = null) {
    const metaPath = metaPathOverride || projectData?.metaCheckedPath || projectData?.meta_path || null;
    if (!metaPath) throw new Error("Project is missing metadata path.");
    if (splitSourceCache.metaPath === metaPath && splitSourceCache.sampleToMeta.size) return;

    const text = await getStorageCsvText(metaPath);
    const parsed = parseMetaCsv(text, getMetaDescriptorByName);
    splitSourceCache.metaPath = metaPath;
    splitSourceCache.metaHeader = parsed.metaHeader;
    splitSourceCache.sampleToMeta = parsed.sampleToMeta;
}

async function loadSidebar(uid) {
    const sidebar = await fetch("./sidebar.html").then((response) => response.text());
    dom.sidebarPlaceholder().innerHTML = sidebar;
    dom.sidebarPlaceholder().querySelectorAll("script").forEach((oldScript) => {
        const script = document.createElement("script");
        script.textContent = oldScript.textContent;
        document.head.appendChild(script);
    });

    document.querySelectorAll("#analysis-nav a").forEach((link) => {
        const href = link.getAttribute("href");
        if (href && href !== "#") link.href = `${href}?id=${projectId}&uid=${uid}`;
    });
    const activeLink = document.querySelector('#analysis-nav a[href^="random-forest.html"]');
    if (activeLink) {
        document.querySelectorAll("#analysis-nav .nav-link").forEach((l) => l.classList.remove("active"));
        activeLink.classList.add("active");
    }

    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

function setRunStatus(message = "", isError = false) {
    const status = dom.runStatus();
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
}

function isRunCoolingDown() {
    return Date.now() < runCooldownUntil;
}

function refreshRunCooldownUi() {
    if (isRunCoolingDown()) {
        dom.runButton().disabled = true;
        dom.runButton().innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${Math.max(1, Math.ceil((runCooldownUntil - Date.now()) / 1000))}s`;
        return;
    }
    runCooldownUntil = 0;
    dom.runButton().disabled = false;
    dom.runButton().innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN';
    validateForm();
}

function syncModelTypeUi() {
    selectedModelType = String(dom.modelType()?.value || "rf").toLowerCase() === "svm" ? "svm" : "rf";
    dom.rfConfigWrap()?.classList.toggle("d-none", selectedModelType !== "rf");
    dom.svmConfigWrap()?.classList.toggle("d-none", selectedModelType !== "svm");

    const kernel = String(dom.svmKernel()?.value || "rbf").toLowerCase();
    dom.svmNRepeatsWrap()?.classList.toggle("d-none", !(selectedModelType === "svm" && kernel === "rbf"));

    const loadedResultModel = String(currentResultsData?.model_type || "rf").toLowerCase();
    const loadedResultKernel = String(currentResultsData?.kernel || "rbf").toLowerCase();
    const showSvmToggle = Boolean(currentResultsData) && loadedResultModel === "svm" && loadedResultKernel === "rbf";
    dom.svmImportanceModeToggle()?.classList.toggle("d-none", !showSvmToggle);
    if (!showSvmToggle) svmImportanceView = "feature";

    if (dom.titleError()) {
        dom.titleError().innerHTML = selectedModelType === "svm"
            ? '<i class="fa-solid fa-chart-column fa-xs me-1"></i>CV Accuracy per Fold'
            : '<i class="fa-solid fa-chart-line fa-xs me-1"></i>OOB Error vs Trees';
    }
    if (dom.titleOutlier()) {
        dom.titleOutlier().innerHTML = selectedModelType === "svm"
            ? '<i class="fa-solid fa-chart-simple fa-xs me-1"></i>ROC Curve'
            : '<i class="fa-solid fa-circle-exclamation fa-xs me-1"></i>Outlier Detection';
    }

    const outlierTab = dom.outlierTab();
    if (outlierTab) {
        outlierTab.classList.remove("d-none");
        outlierTab.textContent = selectedModelType === "svm" ? "ROC Detail" : "Outlier Detection";
    }
}

function ensureOutlierTabPresent() {
    if (dom.outlierTab()) return;
    const tabRow = dom.resultTabRow();
    if (!tabRow) return;
    const button = document.createElement("button");
    button.className = "rf-result-tab";
    button.dataset.rfTab = "outlier";
    button.textContent = "Outlier Detection";
    button.addEventListener("click", () => setActiveTab("outlier"));
    tabRow.appendChild(button);
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

function setBusy(nextBusy, message = "", isError = false) {
    isBusy = Boolean(nextBusy);
    setRunStatus(message, isError);
    dom.runButton().disabled = isBusy || isRunCoolingDown();
    if (!isBusy && !isRunCoolingDown()) refreshRunCooldownUi();
}

function setMode(mode) {
    currentMode = mode === "split" ? "split" : "manual";
    dom.modeManual().classList.toggle("active", currentMode === "manual");
    dom.modeSplit().classList.toggle("active", currentMode === "split");
    dom.manualSection().classList.toggle("d-none", currentMode !== "manual");
    dom.splitConfigHost().classList.toggle("d-none", currentMode !== "split");
    dom.splitWorkspace().classList.toggle("d-none", currentMode !== "split");
    if (currentMode === "split") {
        dom.resultsArea()?.classList.add("d-none");
        dom.emptyState()?.classList.add("d-none");
        if (pendingSplitHistorySnapshot && splitEngine) {
            splitEngine.applySnapshot(pendingSplitHistorySnapshot);
            pendingSplitHistorySnapshot = null;
        }
        splitEngine?.setVisible(true);
        splitEngine?.render();
    } else {
        splitEngine?.setVisible(false);
        if (currentPayload) {
            dom.resultsArea()?.classList.remove("d-none");
            dom.emptyState()?.classList.add("d-none");
        } else {
            dom.emptyState()?.classList.remove("d-none");
        }
    }
    validateForm();
}

function escapeCsvValue(value) {
    const text = String(value ?? "");
    if (!/[",\n\r]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
    if (!rows || !rows.length) return "";
    const headers = Object.keys(rows[0]);
    const lines = [headers.map(escapeCsvValue).join(",")];
    rows.forEach((row) => {
        lines.push(headers.map((key) => escapeCsvValue(row[key])).join(","));
    });
    return lines.join("\n");
}

function parseCsvRow(line) {
    const row = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (char === "," && !inQuotes) {
            row.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    row.push(current);
    return row;
}

function parseMatrixCsv(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length < 2) throw new Error("Matrix file is empty.");

    const header = parseCsvRow(lines[0]);
    const sampleIds = header.slice(1).map((value) => String(value || "").trim());
    const featureToValues = new Map();

    for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
        const row = parseCsvRow(lines[rowIndex]);
        const feature = String(row[0] || "").trim();
        if (!feature) continue;
        const values = new Array(sampleIds.length);
        for (let sampleIndex = 0; sampleIndex < sampleIds.length; sampleIndex += 1) {
            const num = Number(row[sampleIndex + 1]);
            values[sampleIndex] = Number.isFinite(num) ? num : null;
        }
        featureToValues.set(feature, values);
    }

    return { sampleIds, featureToValues };
}

async function ensureExpressionSourceLoaded() {
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath || null;
    if (!matrixPath) throw new Error("Project is missing normalized matrix path.");

    if (expressionSourceCache.matrixPath === matrixPath && expressionSourceCache.featureToValues.size) return;

    const matrixText = await getStorageCsvText(matrixPath);
    const matrixParsed = parseMatrixCsv(matrixText);
    expressionSourceCache = {
        matrixPath,
        sampleIds: matrixParsed.sampleIds,
        featureToValues: matrixParsed.featureToValues,
    };
}

function buildSampleClassMap() {
    const map = new Map();

    // Preferred source for SVM/RF: explicit sample -> class mapping from backend payload.
    const payloadMap = currentPayload?.sample_class_labels;
    if (payloadMap && typeof payloadMap === "object") {
        Object.entries(payloadMap).forEach(([sampleId, classLabel]) => {
            const sampleKey = String(sampleId || "").trim();
            if (!sampleKey) return;
            map.set(sampleKey, String(classLabel || "Unknown"));
        });
        if (map.size) return map;
    }

    // Secondary source for SVM RBF runs.
    const boundaryPoints = currentPayload?.decision_boundary?.sample_points;
    if (Array.isArray(boundaryPoints) && boundaryPoints.length) {
        boundaryPoints.forEach((point) => {
            const sampleKey = String(point?.sample_id || "").trim();
            if (!sampleKey) return;
            map.set(sampleKey, String(point?.class_label || "Unknown"));
        });
        if (map.size) return map;
    }

    // Legacy RF source.
    const rows = currentPayload?.outlier_detection?.table || [];
    rows.forEach((row) => {
        if (!row?.sample_id) return;
        map.set(String(row.sample_id).trim(), String(row.class_label || "Unknown"));
    });
    return map;
}

function getFeatureGroupMeans(feature) {
    const values = expressionSourceCache.featureToValues.get(feature);
    if (!values || !expressionSourceCache.sampleIds.length) return [];

    const sampleClassMap = buildSampleClassMap();
    const aggregate = new Map();
    expressionSourceCache.sampleIds.forEach((sampleId, index) => {
        const classLabel = sampleClassMap.get(sampleId);
        if (!classLabel) return;
        const value = values[index];
        if (!Number.isFinite(value)) return;
        const prev = aggregate.get(classLabel) || { sum: 0, count: 0 };
        prev.sum += value;
        prev.count += 1;
        aggregate.set(classLabel, prev);
    });

    const classOrder = Array.isArray(currentPayload?.class_labels) ? currentPayload.class_labels : [];
    const ordered = classOrder
        .filter((label) => aggregate.has(label))
        .map((label) => {
            const item = aggregate.get(label);
            return { label, mean: item.sum / item.count, count: item.count };
        });
    const fallback = [...aggregate.entries()]
        .filter(([label]) => !classOrder.includes(label))
        .map(([label, item]) => ({ label, mean: item.sum / item.count, count: item.count }));
    return [...ordered, ...fallback];
}

function getFeatureDominantClass(feature, sampleClassMap = null) {
    const values = expressionSourceCache.featureToValues.get(feature);
    if (!values || !expressionSourceCache.sampleIds.length) return "Unknown";

    const classMap = sampleClassMap || buildSampleClassMap();
    const aggregate = new Map();
    expressionSourceCache.sampleIds.forEach((sampleId, index) => {
        const classLabel = classMap.get(sampleId);
        if (!classLabel) return;
        const value = values[index];
        if (!Number.isFinite(value)) return;
        const prev = aggregate.get(classLabel) || { sum: 0, count: 0 };
        prev.sum += value;
        prev.count += 1;
        aggregate.set(classLabel, prev);
    });

    if (!aggregate.size) return "Unknown";
    let bestLabel = "Unknown";
    let bestMean = -Infinity;
    aggregate.forEach((item, label) => {
        const mean = item.count > 0 ? (item.sum / item.count) : -Infinity;
        if (mean > bestMean) {
            bestMean = mean;
            bestLabel = label;
        }
    });
    return bestLabel;
}

function populateClassFilterOptions(selectEl, labels) {
    if (!selectEl) return;
    const currentValue = selectEl.value || "__all__";
    const uniqueLabels = [...new Set((labels || []).map((label) => String(label || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    selectEl.innerHTML = '<option value="__all__">All classes</option>' + uniqueLabels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join("");
    if (currentValue !== "__all__" && uniqueLabels.includes(currentValue)) {
        selectEl.value = currentValue;
    } else {
        selectEl.value = "__all__";
    }
}

function getDefaultTopOutlierSampleIds(rows, topN = DEFAULT_TOP_OUTLIERS) {
    const byGroup = new Map();
    (rows || []).forEach((row) => {
        const group = String(row?.class_label || "Unknown");
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group).push(row);
    });

    const selected = [];
    byGroup.forEach((groupRows) => {
        groupRows
            .sort((a, b) => Number(b.outlier_score || 0) - Number(a.outlier_score || 0))
            .slice(0, topN)
            .forEach((row) => selected.push(row.sample_id));
    });
    return selected;
}

function downloadText(filename, text, contentType = "text/csv") {
    const blob = new Blob([text], { type: contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function populateTargetSelect() {
    const select = dom.targetSelect();
    if (!select) return;
    const options = getEligibleGroupedMetaColumns(2);
    select.innerHTML = '<option value="">-- Select --</option>' + options.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join("");
    renderComparisonOptions();
}

async function ensureSplitEngineMounted() {
    if (splitEngine) return splitEngine;
    splitEngine = await createSplitMetaEngine({
        mode: "anova",
        configHost: document.getElementById("rf-split-config-host"),
        workspaceHost: document.getElementById("rf-split-workspace"),
        minGroups: 3,
        maxGroups: 8,
        defaultGroupNames: ["group1", "group2", "group3"],
        comparisonSeparator: " | ",
        getEligibleColumns: () => getEligibleGroupedMetaColumns(1),
        visible: false,
        onChange: (summary) => {
            splitValid = Boolean(summary?.isValid);
            populateTargetSelect();
            validateForm();
        },
    });
    return splitEngine;
}

async function syncSplitEngineMetadata(metaPathOverride = null) {
    const engine = await ensureSplitEngineMounted();
    await ensureSplitMetaLoaded(metaPathOverride);
    engine.setMetadata({ metaHeader: splitSourceCache.metaHeader, sampleToMeta: splitSourceCache.sampleToMeta });
    populateTargetSelect();
}

function preloadSplitEngine(metaPathOverride = null) {
    if (!splitPreloadPromise) {
        splitPreloadPromise = (async () => {
            await ensureSplitEngineMounted();
            await syncSplitEngineMetadata(metaPathOverride);
        })().catch((error) => {
            splitPreloadPromise = null;
            throw error;
        });
    }
    return splitPreloadPromise;
}

async function buildManualMetaSource() {
    const targetColumn = dom.targetSelect().value;
    if (!targetColumn) throw new Error("Select a metadata column.");
    const comparison = getSelectedComparisonValue() || "__all__";
    let selectedGroups = [];
    if (comparison && comparison !== "__all__") {
        selectedGroups = comparison.split("|||").map((item) => item.trim()).filter(Boolean);
    }
    return {
        target: targetColumn,
        displayTarget: targetColumn,
        comparison,
        selected_groups: selectedGroups,
        mode: "manual",
    };
}

async function buildSplitMetaSource() {
    const engine = await ensureSplitEngineMounted();
    await syncSplitEngineMetadata();
    const derived = engine.buildDerivedMetaCsv({ columnPrefix: "__rf_split" });
    const metaPathOverride = `projects/${auth.currentUser.uid}/${projectId}/random_forest/rf_split_meta_${Date.now()}.csv`;
    await uploadString(ref(storage, metaPathOverride), derived.csvText, "raw", { contentType: "text/csv" });
    return {
        target: derived.targetColumn,
        displayTarget: derived.displayTarget,
        comparison: derived.comparison,
        metaPathOverride,
        splitConfig: derived.splitConfig,
        mode: "split",
    };
}

function validateForm() {
    syncModelTypeUi();
    const nTrees = Number(dom.nEstimators().value);
    const maxFeatures = String(dom.maxFeatures().value || DEFAULT_MAX_FEATURES);
    const treeOk = Number.isFinite(nTrees) && nTrees >= 1 && nTrees <= MAX_ESTIMATORS;
    const maxFeaturesOk = Boolean(maxFeatures);
    const svmCOk = Number.isFinite(Number(dom.svmC()?.value)) && Number(dom.svmC()?.value) >= 0.01 && Number(dom.svmC()?.value) <= 1000;
    const svmKernelOk = ["rbf", "linear"].includes(String(dom.svmKernel()?.value || "rbf"));
    const modelCfgOk = selectedModelType === "svm" ? (svmCOk && svmKernelOk) : (treeOk && maxFeaturesOk);
    const manualComparisonOk = Boolean(getSelectedComparisonValue());
    const modeOk = currentMode === "split"
        ? splitValid
        : Boolean(dom.targetSelect().value) && manualComparisonOk;
    dom.runButton().disabled = isBusy || isRunCoolingDown() || !modelCfgOk || !modeOk;
    return modelCfgOk && modeOk;
}

function normalizeTaskStatus(status) {
    const value = String(status || "done").toLowerCase();
    if (value === "pending") return "pending";
    if (value === "running") return "running";
    if (value === "error") return "error";
    return "done";
}

function formatTaskId(item) {
    if (item?.task_id == null || item?.task_id === "") return null;
    return `ID ${item.task_id}`;
}

function getTaskStatusBadge(status) {
    if (status === "running") return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === "pending") return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === "error") return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

function escapeHtmlAttr(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Helper to convert file URL to storage path
function getStoragePathFromUrl(url) {
    if (!url) return null;
    
    // Format 0 (REST API): http://localhost:8000/files/projects/{uid}/{projectId}/...
    if (url.includes("/files/")) {
        const path = url.split("/files/")[1];
        if (path) return path;
    }
    
    // Format 1: https://localhost:8000/files/path/to/file
    if (url.includes("/o/")) {
        const match = url.match(/\/o\/(.+?)(\?|$)/);
        if (match) {
            const encoded = match[1];
            const decoded = decodeURIComponent(encoded);
            console.log("✅ Decoded path (from /o/):", decoded);
            return decoded;
        }
    }
    
    // Format 2: https://storage.googleapis.com/bucket/path/to/file
    if (url.includes("storage.googleapis.com/")) {
        const parts = url.split("storage.googleapis.com/")[1];
        if (parts) {
            const pathParts = parts.split("/");
            // First part is bucket name, rest is path
            if (pathParts.length > 1) {
                const path = pathParts.slice(1).join("/");
                console.log("✅ Decoded path (from storage.googleapis.com):", path);
                return path;
            }
        }
    }
    
    // Format 3: gs://bucket/path/to/file
    if (url.startsWith("gs://")) {
        const parts = url.split("gs://")[1];
        if (parts) {
            const path = parts.split("/").slice(1).join("/");
            console.log("✅ GS path:", path);
            return path;
        }
    }
    
    console.error("❌ Unknown URL format:", url);
    return null;
}

// Extract run folder path from results URL
function getRunFolderPath(resultsUrl) {
    if (!resultsUrl) return null;
    
    const path = getStoragePathFromUrl(resultsUrl);
    if (!path) {
        console.error("❌ Could not extract storage path");
        return null;
    }
    
    // resultsUrl is like: projects/{uid}/{projectId}/random_forest/{run_id}/results.json
    // We want: projects/{uid}/{projectId}/random_forest/{run_id}/
    const parts = path.split("/");
    console.log("📂 Path parts:", parts);
    
    // Find the index of results.json or the last part
    const lastPart = parts[parts.length - 1];
    const folderPath = lastPart.endsWith(".json") 
        ? parts.slice(0, -1).join("/") + "/"
        : path.endsWith("/") ? path : path + "/";
    
    console.log("📂 Run folder path:", folderPath);
    return folderPath;
}

// Delete all files in a local storage folder
async function deleteRunFolder(resultsUrl) {
    if (!resultsUrl) {
        console.error("❌ No results URL provided");
        return;
    }
    
    const runFolderPath = getRunFolderPath(resultsUrl);
    if (!runFolderPath) {
        console.error("❌ Unable to determine run folder path from:", resultsUrl);
        return;
    }
    
    console.log("🗑️  Starting delete process for folder:", runFolderPath);
    
    try {
        const folderRef = ref(storage, runFolderPath);
        console.log("📋 Listing files in folder...");
        
        const fileList = await listAll(folderRef);
        console.log(`📊 Found ${fileList.items.length} files and ${fileList.prefixes.length} subfolders`);
        
        if (fileList.items.length === 0 && fileList.prefixes.length === 0) {
            console.warn("⚠️  Folder appears to be empty or path is invalid");
        }
        
        // Delete all files
        for (const item of fileList.items) {
            try {
                console.log(`🗑️  Deleting file: ${item.fullPath}`);
                await deleteObject(item);
                console.log(`✅ Deleted: ${item.fullPath}`);
            } catch (err) {
                console.error(`❌ Failed to delete ${item.fullPath}:`, err);
            }
        }
        
        // Recursively delete subfolders
        for (const prefix of fileList.prefixes) {
            try {
                console.log(`🗑️  Processing subfolder: ${prefix.fullPath}/`);
                await deleteRunFolder(prefix.fullPath + "/results.json");
            } catch (err) {
                console.error(`❌ Error with subfolder ${prefix.fullPath}:`, err);
            }
        }
        
        console.log("✅ Folder deletion completed");
    } catch (err) {
        console.error("❌ Error during folder deletion:", err.code, err.message);
        if (err.code === "storage/object-not-found") {
            console.warn("⚠️  Folder not found - may have already been deleted");
        } else if (err.code === "storage/unauthorized") {
            console.error("🔐 Permission denied - check local storage rules");
        }
    }
}

// Alternative: Try to delete known file types in the run folder
async function deleteRunFolderFallback(resultsUrl) {
    if (!resultsUrl) return;
    
    const runFolderPath = getRunFolderPath(resultsUrl);
    if (!runFolderPath) return;
    
    console.log("🔄 Using fallback deletion method for:", runFolderPath);
    
    const filesToDelete = [
        runFolderPath + "results.json",
        runFolderPath + "classification.html",
        runFolderPath + "feature_importance.html",
        runFolderPath + "outlier_detection.html",
        runFolderPath + "preprocessed_data.csv",
        runFolderPath + "metadata.csv",
    ];
    
    for (const filePath of filesToDelete) {
        try {
            console.log(`🗑️  Attempting fallback delete: ${filePath}`);
            await deleteObject(ref(storage, filePath));
            console.log(`✅ Deleted: ${filePath}`);
        } catch (err) {
            if (err.code !== "storage/object-not-found") {
                console.warn(`⚠️  Could not delete ${filePath}:`, err.message);
            }
        }
    }
}

// Test function to verify Storage deletion permissions
async function testStorageDelete() {
    console.log("🧪 Testing Storage deletion permissions...");
    try {
        const testPath = `projects/${auth.currentUser.uid}/${projectId}/random_forest/test_delete_${Date.now()}.txt`;
        const testRef = ref(storage, testPath);
        
        // Try to upload a test file
        console.log("📤 Uploading test file:", testPath);
        await uploadString(testRef, "test content", "raw");
        console.log("✅ Upload successful");
        
        // Try to delete it
        console.log("🗑️  Attempting to delete test file...");
        await deleteObject(testRef);
        console.log("✅ Delete successful - permissions are OK");
        return true;
    } catch (err) {
        console.error("❌ Delete test failed:", err.code, err.message);
        if (err.code === "storage/unauthorized") {
            console.error("🔐 PERMISSION ERROR: Check local storage rules");
            console.log("📌 Required rules: allow delete if request.auth != null;");
        }
        return false;
    }
}

// Make test function globally available
window.testStorageDelete = testStorageDelete;

function parseGroupsFromComparison(comparison) {
    const value = String(comparison || "").trim();
    if (!value || value === "__all__") return [];
    if (value.includes("|||")) return value.split("|||").map((part) => part.trim()).filter(Boolean);
    if (/\s+vs\s+/i.test(value)) return value.split(/\s+vs\s+/i).map((part) => part.trim()).filter(Boolean);
    if (value.includes("|")) return value.split("|").map((part) => part.trim()).filter(Boolean);
    return [];
}

function deriveGroupsDisplay(item, fallback = null) {
    const direct = String(item?.selected_groups_display || "").trim();
    if (direct) return direct;

    const fallbackDirect = String(fallback?.selected_groups_display || "").trim();
    if (fallbackDirect) return fallbackDirect;

    const selectedGroups = [
        ...(Array.isArray(item?.selected_groups) ? item.selected_groups : []),
        ...(Array.isArray(item?.settings?.selected_groups) ? item.settings.selected_groups : []),
    ].map((group) => String(group || "").trim()).filter(Boolean);
    if (selectedGroups.length) return selectedGroups.join(" | ");

    const splitGroups = [
        ...(Array.isArray(item?.splitConfig?.groups) ? item.splitConfig.groups : []),
        ...(Array.isArray(item?.settings?.splitConfig?.groups) ? item.settings.splitConfig.groups : []),
    ].map((group) => (typeof group === "string" ? group : group?.name))
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    if (splitGroups.length) return splitGroups.join(" | ");

    const fromComparison = parseGroupsFromComparison(item?.comparison || item?.settings?.comparison || "");
    if (fromComparison.length) return fromComparison.join(" | ");

    const comparisonValue = String(item?.comparison || item?.settings?.comparison || fallback?.comparison || fallback?.settings?.comparison || "").trim();
    if (comparisonValue === "__all__") {
        const targetName = String(item?.displayTarget || item?.target || fallback?.displayTarget || fallback?.target || "").trim();
        if (targetName) {
            const manualGroups = getManualGroupValues(targetName);
            if (manualGroups.length) return manualGroups.join(" | ");
        }
    }

    return "";
}

function deduplicateHistory(history, previousHistory = analysisHistory) {
    const seen = new Set();
    const fallbackByRunId = new Map((previousHistory || [])
        .filter((item) => item?.run_id)
        .map((item) => [item.run_id, item]));

    return (history || []).map((item) => {
        const fallback = item?.run_id ? fallbackByRunId.get(item.run_id) : null;
        return {
            ...fallback,
            ...item,
            displayTarget: item?.displayTarget || fallback?.displayTarget || item?.target || fallback?.target || null,
            comparison: item?.comparison || fallback?.comparison || item?.settings?.comparison || fallback?.settings?.comparison || null,
            model_type: String(item?.model_type || fallback?.model_type || item?.settings?.model_type || "rf").toLowerCase() === "svm" ? "svm" : "rf",
            selected_groups_display: deriveGroupsDisplay(item, fallback),
            status: normalizeTaskStatus(item?.status),
        };
    }).filter((item) => {
        const key = item.run_id || `${item.name}_${item.target}_${item.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildTaskFallbackEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        name: task.name || "Untitled",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        target: task.target || null,
        model_type: task.model_type || "rf",
        results_url: task.results_url || null,
        status: normalizeTaskStatus(task.status),
        message: task.message || "",
    };
}

function formatGroupsDisplay(item) {
    return deriveGroupsDisplay(item);
}

function getAutoAnalysisName() {
    const now = new Date();
    const pad2 = (value) => String(value).padStart(2, "0");
    const datePart = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const timePart = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    const prefix = selectedModelType === "svm" ? "SVM" : "RF";
    return `${prefix}_${datePart}_${timePart}`;
}

function getDefaultAnalysisName() {
    const prefix = selectedModelType === "svm" ? "SVM" : "RF";
    const base = String(projectData?.project_name || "Analysis").trim().replace(/\s+/g, "_");
    return `${prefix}_${base}`;
}

function maybeRefreshDefaultAnalysisName() {
    const input = dom.analysisName();
    if (!input) return;
    const current = String(input.value || "").trim();
    const prevSuggested = String(input.dataset.suggestedName || "").trim();
    const shouldReplace = !current || current === "Analysis" || (prevSuggested && current === prevSuggested);
    if (shouldReplace) {
        const nextSuggested = getDefaultAnalysisName();
        input.value = nextSuggested;
        input.dataset.suggestedName = nextSuggested;
    }
}

async function syncRunTaskState(task) {
    if (!task?.run_id) {
        if (!currentRunId) setBusy(false, "", false);
        return;
    }

    const normalizedStatus = normalizeTaskStatus(task.status);
    if (normalizedStatus === "pending" || normalizedStatus === "running") {
        currentRunId = task.run_id;
        renderHistoryPopup();
        // Only update status message, don't disable button for background tasks
        setRunStatus(task.message || `${task.name || "Random Forest"} is ${normalizedStatus}...`);
        return;
    }

    if (normalizedStatus === "error") {
        if (!currentRunId || currentRunId === task.run_id) {
            currentRunId = null;
            setRunStatus(task.message || "Random Forest failed.", true);
        }
        renderHistoryPopup();
        return;
    }

    const hasVisibleResult = Boolean(currentPayload && currentResultsData?.classification);
    const shouldAutoload = Boolean((currentRunId && currentRunId === task.run_id) || !hasVisibleResult);
    currentRunId = null;
    selectedHistoryRunId = task.run_id;
    setBusy(false, task.message || `Done: ${task.name || task.run_id}`);
    renderHistoryPopup();

    if (!shouldAutoload) return;

    const entry = analysisHistory.find((item) => item.run_id === task.run_id) || buildTaskFallbackEntry(task);
    if (entry?.results_url) {
        await loadHistoryEntry(entry);
    }
}

function resetResultsViewToDefault() {
    currentPayload = null;
    currentResultsData = null;
    selectedHistoryRunId = null;
    currentState.visibleFeatures = new Set();
    currentState.visibleSamples = new Set();
    currentState.labelSamples = new Set();
    currentState.selectedSampleId = null;
    dom.resultTabsSection()?.classList.add("d-none");
    dom.resultsArea()?.classList.add("d-none");
    dom.emptyState()?.classList.remove("d-none");
}

function renderHistoryPopup() {
    const popup = dom.historyPopup();

    if (!popup) return;
    analysisHistory = deduplicateHistory(analysisHistory);
    if (!analysisHistory.length) {
        popup.innerHTML = '<div class="history-meta p-2 text-center">No runs yet.</div>';
        return;
    }
    popup.innerHTML = analysisHistory.map((item) => {
        const groupsDisplay = formatGroupsDisplay(item);
        return `
        <div class="history-item d-flex align-items-start gap-2 ${selectedHistoryRunId === item.run_id ? "active" : ""}" data-run-id="${escapeHtml(item.run_id || "")}">
            <div class="history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">${escapeHtml(item.name || "Untitled")}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getTaskStatusBadge(normalizeTaskStatus(item.status))}<span>${escapeHtml(formatTaskId(item) || "No ID")}</span></div>
                <div class="history-meta"><strong>Target:</strong> ${escapeHtml(item.displayTarget || item.target || "-")}</div>
                ${groupsDisplay ? `<div class="history-meta"; font-weight:500;"><strong>Groups:</strong> ${escapeHtml(groupsDisplay)}</div>` : ""}
                <div class="history-meta">${escapeHtml(item.message || (normalizeTaskStatus(item.status) === "done" ? "Ready to open." : normalizeTaskStatus(item.status) === "running" ? "Task is running..." : normalizeTaskStatus(item.status) === "pending" ? "Queued for processing..." : "Task failed."))}</div>
                <div class="history-meta extra-small" style="color:#94a3b8;">${escapeHtml(item.date ? new Date(item.date).toLocaleString() : "-")}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete" data-run-id="${escapeHtml(item.run_id || "")}" title="Delete this run" style="font-size:0.65rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `;
    }).join("");
// ${item.comparison ? `<div class="history-meta"><strong>Comparison:</strong> ${escapeHtml(item.comparison)}</div>` : ""}
    popup.querySelectorAll(".history-info").forEach((itemEl) => {
        itemEl.addEventListener("click", async () => {
            const runId = itemEl.parentElement?.dataset.runId;
            const item = analysisHistory.find((entry) => entry.run_id === runId);
            if (!item) return;
            const status = normalizeTaskStatus(item.status);
            if (status === "pending" || status === "running") return;
            if (status === "error") {
                setRunStatus(item.message || "Random Forest task failed.", true);
                return;
            }
            await loadHistoryEntry(item);
            selectedHistoryRunId = runId;
            renderHistoryPopup();
            popup.classList.remove("open");
        });
    });

    popup.querySelectorAll(".history-delete").forEach((btn) => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            const entry = analysisHistory.find((h) => h.run_id === runId);
            if (!entry) return;
            
            const status = normalizeTaskStatus(entry.status);
            if (status === "pending" || status === "running") {
                setRunStatus("This task is still processing and cannot be deleted yet.", true);
                return;
            }
            
            if (!confirm(`Delete "${entry.name}"?`)) return;

            // Optimistic UI update: remove immediately for smooth UX.
            console.log("📋 Removing entry from history array");
            const isDeletingCurrentView = selectedHistoryRunId === runId || currentPayload?.run_id === runId;
            analysisHistory = analysisHistory.filter((h) => h.run_id !== runId);

            // If deleting the run currently shown, reset to default empty state.
            // If deleting a non-viewed run, keep the current result on screen.
            if (isDeletingCurrentView) {
                resetResultsViewToDefault();
            }
            
            renderHistoryPopup();

            setRunStatus("History entry deleted. Cleaning up Storage in background...");

            // Run Storage cleanup in background, do not block UI.
            (async () => {
                try {
                    const projectState = buildProjectStateFromHistory();
                    console.log("💾 Updating project history");
                    await updateDoc(doc(db, "projects", projectId), projectState);
                    console.log("✅ History updated");
                    projectData = { ...projectData, ...projectState };
                } catch (err) {
                    console.error("❌ Error updating history:", err);
                    setRunStatus("Deleted on UI, but failed to sync history. Check console.", true);
                }

                if (!entry.results_url) {
                    console.warn("⚠️  No results_url found in entry, skipping Storage deletion");
                    return;
                }

                try {
                    console.log("🗑️  Calling deleteRunFolder with URL:", entry.results_url);
                    await deleteRunFolder(entry.results_url);
                    console.log("✅ local storage deletion completed");
                } catch (err) {
                    console.error("❌ Error deleting from local storage (primary method):", err);
                    console.log("🔄 Attempting fallback deletion method...");
                    try {
                        await deleteRunFolderFallback(entry.results_url);
                        console.log("✅ Fallback deletion method completed");
                    } catch (fallbackErr) {
                        console.error("❌ Fallback method also failed:", fallbackErr);
                        setRunStatus("Deleted on UI, but Storage cleanup failed. Check console.", true);
                        return;
                    }
                }

                setRunStatus("History entry deleted successfully.", false);
            })();
        };
    });
}

function buildProjectStateFromHistory() {
    return {
        rf_history: analysisHistory.length ? analysisHistory : null,
        rf_results_url: currentPayload?.results_url || null,
    };
}

async function persistCurrentState() {
    if (!projectId || !currentPayload?.run_id) return;
    await updateDoc(doc(db, "projects", projectId), buildProjectStateFromHistory());
}

async function loadResultsPayload(resultsUrl) {
    const response = await fetch(resultsUrl, { cache: "no-store" });
    if (!response.ok) {
        throw new Error("Unable to load random forest results payload.");
    }
    return response.json();
}

async function loadHistoryEntry(entry) {
    if (!entry?.results_url) {
        currentPayload = null;
        return;
    }
    setBusy(true, `Loading run ${entry.run_id}...`);
    try {
        const payload = await loadResultsPayload(entry.results_url);
        currentResultsData = payload;
        currentPayload = payload;
        // For each newly loaded result, restore default plot settings and reset zoom/autoscale once.
        resetPlotCfgDefaults();
        bumpPlotSession();
        forceAutoscaleErrorPlot = true;
        selectedModelType = String(payload.model_type || "rf").toLowerCase() === "svm" ? "svm" : "rf";
        if (dom.modelType()) dom.modelType().value = selectedModelType;
        if (selectedModelType === "svm") {
            if (dom.svmKernel()) dom.svmKernel().value = String(payload.kernel || "rbf");
            if (dom.svmC()) dom.svmC().value = String(payload.C ?? 1.0);
            if (dom.svmCvFolds()) dom.svmCvFolds().value = String(payload.cv_folds ?? 5);
            if (dom.svmClassWeight()) dom.svmClassWeight().value = String(payload.class_weight ?? "balanced");
            if (dom.svmNBootstrap()) dom.svmNBootstrap().value = String(payload.n_bootstrap ?? 1000);
            if (dom.svmCiLevel()) dom.svmCiLevel().value = String(payload.ci_level ?? 0.95);
            if (dom.svmCutoffMethod()) dom.svmCutoffMethod().value = String(payload.cutoff_method ?? "youden");
            if (dom.svmNRepeatsPermutation()) dom.svmNRepeatsPermutation().value = String(payload.n_repeats_permutation ?? 10);
        }
        syncModelTypeUi();
        currentRunId = payload.run_id || entry.run_id || null;
        selectedHistoryRunId = entry.run_id || null;
        currentState.visibleFeatures = new Set(payload.feature_importance?.visible_feature_names || (payload.feature_importance?.table || []).slice(0, DEFAULT_TOP_FEATURES).map((row) => row.feature));
        const defaultVisible = selectedModelType === "svm"
            ? []
            : (() => {
                const perGroupTop = getDefaultTopOutlierSampleIds(payload.outlier_detection?.table || [], DEFAULT_TOP_OUTLIERS);
                const fallbackTop = payload.outlier_detection?.top_label_sample_ids || (payload.outlier_detection?.table || []).slice(0, DEFAULT_TOP_OUTLIERS).map((row) => row.sample_id);
                return perGroupTop.length ? perGroupTop : fallbackTop;
            })();
        currentState.visibleSamples = new Set(defaultVisible);
        currentState.labelSamples = new Set();
        currentState.selectedSampleId = null;
        await ensureExpressionSourceLoaded().catch(() => {
            // Importance hover and violin popup still work with fallback when matrix cannot be loaded.
        });
        renderAllPlots();
        setActiveTab(currentTab);
        setBusy(false, `Loaded ${entry.name || entry.run_id}`);
    } catch (error) {
        setBusy(false, error.message, true);
        throw error;
    }
}

function renderClassificationInfo() {
    if (!currentResultsData?.classification) {
        dom.classificationInfo().innerHTML = "No classification results loaded yet.";
        return;
    }
    const data = currentResultsData.classification;
    const reportRows = Array.isArray(data.classification_report) ? data.classification_report : [];
    const isSvm = String(currentResultsData?.model_type || "rf").toLowerCase() === "svm";
    const reportTitle = isSvm
        ? `Classification Report (${escapeHtml(currentResultsData?.cv_folds || 5)}-Fold CV)`
        : "Classification report (OOB)";
    const reportTableHtml = reportRows.length
        ? `
        <div class="mt-2">
            <div class="fw-bold" style="font-size:0.74rem; color:#334155;">${reportTitle}</div>
            <div class="table-responsive mt-1">
                <table class="table table-sm table-bordered mb-0" style="font-size:0.72rem;">
                    <thead class="table-light">
                        <tr>
                            <th>Class</th>
                            <th>Precision</th>
                            <th>Recall</th>
                            <th>F1-score</th>
                            <th>Support</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${reportRows.map((row) => {
                            const fmt = (value) => value == null || value === "" ? "-" : Number(value).toFixed(4);
                            return `
                                <tr>
                                    <td>${escapeHtml(row.label)}</td>
                                    <td>${fmt(row.precision)}</td>
                                    <td>${fmt(row.recall)}</td>
                                    <td>${fmt(row.f1_score)}</td>
                                    <td>${row.support == null ? "-" : escapeHtml(row.support)}</td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        </div>
        `
        : "";

    const rocRows = Array.isArray(currentResultsData?.roc?.table) ? currentResultsData.roc.table : [];
    const rocDetailHtml = isSvm && rocRows.length
        ? `
        <div class="mt-2">
            <div class="fw-bold" style="font-size:0.74rem; color:#334155;">ROC detail</div>
            <div class="table-responsive mt-1">
                <table class="table table-sm table-bordered mb-0" style="font-size:0.72rem;">
                    <thead class="table-light">
                        <tr><th>Class</th><th>AUC</th><th>95% CI</th><th>Cutoff</th><th>FPR</th><th>TPR</th></tr>
                    </thead>
                    <tbody>
                        ${rocRows.map((row) => {
                            const fmt = (value) => value == null || value === "" ? "-" : Number(value).toFixed(4);
                            const ci = row.ci_low == null || row.ci_high == null ? "-" : `${Number(row.ci_low).toFixed(4)}-${Number(row.ci_high).toFixed(4)}`;
                            return `<tr>
                                <td>${escapeHtml(row.class_label)}</td>
                                <td>${fmt(row.auc)}</td>
                                <td>${ci}</td>
                                <td>${fmt(row.optimal_threshold)}</td>
                                <td>${fmt(row.optimal_fpr)}</td>
                                <td>${fmt(row.optimal_tpr)}</td>
                            </tr>`;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        </div>`
        : "";

    dom.classificationInfo().innerHTML = [
        `<div><strong>Classes:</strong> ${escapeHtml((currentResultsData.class_labels || []).join(", "))}</div>`,
        isSvm
            ? `<div><strong>kernel:</strong> ${escapeHtml(currentResultsData.kernel || "rbf")} | <strong>C:</strong> ${escapeHtml(currentResultsData.C)}</div>`
            : `<div><strong>n_estimators:</strong> ${escapeHtml(currentResultsData.n_estimators)}</div>`,
        isSvm
            ? `<div><strong>CV accuracy (mean ± std):</strong> ${data.cv_mean_accuracy == null ? "-" : `${Number(data.cv_mean_accuracy).toFixed(4)} ± ${Number(data.cv_std_accuracy || 0).toFixed(4)}`}</div>`
            : `<div><strong>max_features:</strong> ${escapeHtml(String(currentResultsData.max_features ?? DEFAULT_MAX_FEATURES))}</div>`,
        `<div><strong>${isSvm ? "Overall accuracy" : "OOB accuracy"}:</strong> ${data.oob_accuracy == null ? "-" : Number(data.oob_accuracy).toFixed(4)}</div>`,
        `<div><strong>${isSvm ? "CV samples" : "OOB samples"}:</strong> ${escapeHtml(data.oob_valid_count)} / ${escapeHtml(data.total_count)}</div>`,
        reportTableHtml,
        rocDetailHtml,
    ].join("");
}

function renderImportanceTable() {
    const rows = currentResultsData?.feature_importance?.table || [];
    const isSvm = String(currentResultsData?.model_type || "rf").toLowerCase() === "svm";
    const searchText = String(dom.importanceSearch()?.value || "").trim().toLowerCase();
    const sortKey = String(dom.importanceSort()?.value || "importance_desc");
    const sampleClassMap = buildSampleClassMap();
    const rowsWithClass = rows.map((row) => ({
        ...row,
        class_label: getFeatureDominantClass(row.feature, sampleClassMap),
    }));

    populateClassFilterOptions(dom.importanceClass(), rowsWithClass.map((row) => row.class_label));
    const selectedClass = String(dom.importanceClass()?.value || "__all__");

    let data = [...rowsWithClass];

    if (selectedClass !== "__all__") {
        data = data.filter((row) => String(row.class_label || "") === selectedClass);
    }

    if (searchText) {
        data = data.filter((row) => {
            const feature = String(row.feature || "").toLowerCase();
            const cls = String(row.class_label || "").toLowerCase();
            return feature.includes(searchText) || cls.includes(searchText);
        });
    }

    const primaryKey = "importance";
    if (sortKey === "importance_asc") data.sort((a, b) => Number(a[primaryKey] ?? a.base_importance ?? 0) - Number(b[primaryKey] ?? b.base_importance ?? 0));
    else if (sortKey === "name_asc") data.sort((a, b) => String(a.feature || "").localeCompare(String(b.feature || "")));
    else data.sort((a, b) => Number(b[primaryKey] ?? b.base_importance ?? 0) - Number(a[primaryKey] ?? a.base_importance ?? 0));

    const tbody = dom.importanceTableBody();
    if (!tbody) return;
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3 text-center">No features match current filter.</td></tr>';
        dom.importanceCount().textContent = "0 features";
        return;
    }

    const colLabel = isSvm ? "Source" : "Class";
    const thead = tbody.closest("table")?.querySelector("thead tr");
    if (thead) {
        const ths = thead.querySelectorAll("th");
        if (ths[2]) ths[2].textContent = colLabel;
    }

    tbody.innerHTML = data.map((row) => {
        const isVisible = currentState.visibleFeatures.has(row.feature);
        const rawImportance = row.importance ?? row.base_importance;
        const primaryVal = rawImportance == null ? "—" : Number(rawImportance).toFixed(6);
        const sourceLabel = String(row.importance_source || "")
            .replace(/^svm_/, "")
            .replace(/_/g, " ")
            .trim();
        const thirdCol = isSvm ? (sourceLabel || "-") : String(row.class_label || "Unknown");
        return `
            <tr class="${isVisible ? "table-active" : ""}" data-feature="${escapeHtml(row.feature)}">
                <td>${escapeHtml(row.rank)}</td>
                <td>${escapeHtml(row.feature)}</td>
                <td>${escapeHtml(thirdCol)}</td>
                <td>${primaryVal}</td>
            </tr>
        `;
    }).join("");
    dom.importanceCount().textContent = `${data.length} features`;
    dom.importanceDownload().onclick = () => downloadText("var_importance.csv", buildCsv(rowsWithClass));
    tbody.querySelectorAll("tr[data-feature]").forEach((row) => {
        row.addEventListener("click", () => toggleFeatureVisibility(row.dataset.feature));
    });
    const infoMsg = `Showing top ${DEFAULT_TOP_FEATURES} features by default. Click a row to show/hide its point on the plot.`;
    dom.importanceInfo().innerHTML = infoMsg;
}

function renderOutlierTable() {
    const isSvm = String(currentResultsData?.model_type || "rf").toLowerCase() === "svm";
    if (isSvm) {
        const rows = currentResultsData?.roc?.table || [];
        const tbody = dom.outlierTableBody();
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3 text-center">No ROC rows.</td></tr>';
            dom.outlierCount().textContent = "0 rows";
            return;
        }
        tbody.innerHTML = rows.map((row) => `
            <tr>
                <td>${escapeHtml(row.class_label)}</td>
                <td>AUC ${Number(row.auc || 0).toFixed(4)}</td>
                <td>TPR ${Number(row.optimal_tpr || 0).toFixed(4)}</td>
                <td>FPR ${Number(row.optimal_fpr || 0).toFixed(4)}</td>
            </tr>
        `).join("");
        dom.outlierCount().textContent = `${rows.length} rows`;
        dom.outlierDownload().onclick = () => downloadText("roc_detail.csv", buildCsv(rows));
        dom.outlierInfo().innerHTML = "ROC detail per class (OvR).";
        return;
    }

    const rows = currentResultsData?.outlier_detection?.table || [];
    const searchText = String(dom.outlierSearch()?.value || "").trim().toLowerCase();
    const sortKey = String(dom.outlierSort()?.value || "score_desc");

    populateClassFilterOptions(dom.outlierClass(), rows.map((row) => row.class_label));
    const selectedClass = String(dom.outlierClass()?.value || "__all__");

    let data = [...rows];

    if (selectedClass !== "__all__") {
        data = data.filter((row) => String(row.class_label || "") === selectedClass);
    }

    if (searchText) {
        data = data.filter((row) => {
            const sampleName = String(row.sample_id || "").toLowerCase();
            const className = String(row.class_label || "").toLowerCase();
            return sampleName.includes(searchText) || className.includes(searchText);
        });
    }

    if (sortKey === "score_asc") data.sort((a, b) => Number(a.outlier_score || 0) - Number(b.outlier_score || 0));
    else if (sortKey === "measure_desc") data.sort((a, b) => Number(b.outlying_measure || 0) - Number(a.outlying_measure || 0));
    else if (sortKey === "sample_asc") data.sort((a, b) => String(a.sample_id || "").localeCompare(String(b.sample_id || "")));
    else data.sort((a, b) => Number(b.outlier_score || 0) - Number(a.outlier_score || 0));

    const tbody = dom.outlierTableBody();
    if (!tbody) return;
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3 text-center">No samples match current filter.</td></tr>';
        dom.outlierCount().textContent = "0 samples";
        return;
    }
    tbody.innerHTML = data.map((row) => {
        const isActive = currentState.visibleSamples.has(row.sample_id);
        return `
            <tr class="${isActive ? "table-active" : ""}" data-sample-id="${escapeHtml(row.sample_id)}">
                <td>${escapeHtml(row.sample_id)}</td>
                <td>${escapeHtml(row.class_label)}</td>
                <td>${Number(row.outlier_score).toFixed(3)}</td>
                <td>${Number(row.outlying_measure).toFixed(6)}</td>
            </tr>
        `;
    }).join("");
    dom.outlierCount().textContent = `${data.length} samples`;
    dom.outlierDownload().onclick = () => downloadText("outlier_detection.csv", buildCsv(rows));
    tbody.querySelectorAll("tr[data-sample-id]").forEach((row) => {
        row.addEventListener("click", () => toggleSampleVisibility(row.dataset.sampleId));
    });
    dom.outlierInfo().innerHTML = `Top ${DEFAULT_TOP_OUTLIERS} per group shown on chart. Click a row to add/remove bars. Click a bar on the chart to toggle its label.`;
}

// ─── Plot config state ────────────────────────────────────────────────────────
function createDefaultPlotCfg() {
    return {
        error:      { axisFontSize: 11, legendFontSize: 10, lineWidth: 2 },
        cm:         { axisFontSize: 11, legendFontSize: 10 },
        violin:     { axisTitleFontSize: 18, lineWidth: 1.6, classColors: {} },
        importance: {
            axisFontSize: 11,
            legendFontSize: 10,
            lineWidth: 1.5,
            dotSize: 9,
            dotOpacity: 0.8,
            boundaryRegionOpacity: 0.25,
            boxColor: "#1e40af",
        },
        outlier:    { axisFontSize: 11, legendFontSize: 10, lineWidth: 1.5, labelFontSize: 10, dotSize: 9, dotOpacity: 0.8, boundaryRegionOpacity: 0.25 },
    };
}

let plotCfg = createDefaultPlotCfg();
let plotSessionKey = 0;

function resetPlotCfgDefaults() {
    plotCfg = createDefaultPlotCfg();
}

function bumpPlotSession() {
    plotSessionKey += 1;
}

function getPlotUiRevision(plotKey) {
    return `${plotSessionKey}-${plotKey}`;
}
const GROUP_PALETTE = ["#2563eb","#16a34a","#dc2626","#d97706","#7c3aed","#0891b2","#be185d","#059669","#0d9488","#b45309"];

function exprToColor(val, min, max) {
    if (!isFinite(val)) return "#94a3b8";
    if (max === min) return "#94a3b8";
    const t = Math.max(0, Math.min(1, (val - min) / (max - min)));
    const r = Math.round(37 + t * (220 - 37));
    const g = Math.round(99 + t * (38 - 99));
    const b = Math.round(235 + t * (38 - 235));
    return `rgb(${r},${g},${b})`;
}

function makeDraggable(el) {
    if (!el) return;
    let startX, startY, startLeft, startTop;
    el.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const parent = el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
        startLeft = rect.left - parent.left;
        startTop = rect.top - parent.top;
        startX = e.clientX;
        startY = e.clientY;
        const onMove = (ev) => {
            el.style.left = (startLeft + ev.clientX - startX) + "px";
            el.style.top = (startTop + ev.clientY - startY) + "px";
            el.style.right = "auto";
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
}

function preservePlotLegendPosition(plotEl, layout) {
    const legend = plotEl?._fullLayout?.legend;
    if (!legend || !layout) return;
    layout.legend = {
        ...(layout.legend || {}),
        x: legend.x,
        y: legend.y,
        xanchor: legend.xanchor,
        yanchor: legend.yanchor,
        orientation: legend.orientation,
    };
}

function mountImportanceLegend(rows, minExpr, maxExpr, fontSize) {
    const el = document.getElementById("rfd-legend-importance");
    if (!el) return;
    const minLabel = isFinite(minExpr) ? minExpr.toFixed(2) : "Low";
    const maxLabel = isFinite(maxExpr) ? maxExpr.toFixed(2) : "High";
    el.innerHTML = `
        <div style="font-weight:600;font-size:${fontSize}px;margin-bottom:4px;color:#1e40af;">Mean Expression</div>
        <div class="rfd-legend-grad">
            <div class="rfd-legend-grad-bar"></div>
            <div class="rfd-legend-grad-labels"><span>${escapeHtml(minLabel)}</span><span>${escapeHtml(maxLabel)}</span></div>
        </div>`;
    makeDraggable(el);
}

function mountViolinConfigPanel(labels) {
    const anchor = dom.featureViolinConfigAnchor();
    if (!anchor) return;
    const nextLabels = Array.isArray(labels) ? labels : [];
    const signature = nextLabels.join("||");
    const previousSignature = currentViolinLabels.join("||");
    currentViolinLabels = [...nextLabels];

    if (featureViolinConfigPanel && signature === previousSignature) {
        return;
    }

    if (featureViolinConfigPanel) {
        featureViolinConfigPanel.destroy();
        featureViolinConfigPanel = null;
    }
    anchor.innerHTML = "";

    const fallbackPalette = ["#1d4ed8", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#be185d"];
    const colorList = nextLabels.map((label, idx) => {
        const key = `violinColor_${idx}`;
        const value = String(plotCfg.violin.classColors?.[label] || fallbackPalette[idx % fallbackPalette.length]);
        return { key, label, value };
    });
    const colorDefaults = colorList.reduce((acc, item) => {
        acc[item.key] = item.value;
        return acc;
    }, {});

    featureViolinConfigPanel = mountPlotConfigPanel({
        anchor,
        defaults: {
            ...PLOT_CONFIG_DEFAULTS,
            axisFontSize: Number(plotCfg.violin.axisTitleFontSize || 18),
            imgWidth: 900,
            imgHeight: 600,
            imgFormat: "svg",
            ...colorDefaults,
        },
        options: {
            showMarkerSize: false,
            showMarkerOpacity: false,
            showAxisFontSize: true,
            showLabelSize: false,
            showLegendFontSize: false,
            showLineWidth: false,
            showEllipseOpacity: false,
            showColorList: true,
            colorList,
            showDownloadSection: true,
        },
        onUpdate: async (key, value, allCfg) => {
            plotCfg.violin.axisTitleFontSize = Number(allCfg.axisFontSize || 18);
            nextLabels.forEach((label, idx) => {
                const colorKey = `violinColor_${idx}`;
                const fallback = fallbackPalette[idx % fallbackPalette.length];
                plotCfg.violin.classColors[label] = String(allCfg[colorKey] || fallback);
            });
            if (dom.featureViolinModal()?.classList.contains("show") && currentViolinFeature) {
                await openFeatureViolinModal(currentViolinFeature);
            }
        },
        onDownload: async (cfg) => {
            const plotEl = dom.featureViolinPlot();
            if (!plotEl || !plotEl._fullLayout) return;
            try {
                await Plotly.downloadImage(plotEl, {
                    format: cfg.imgFormat,
                    filename: `violin_${currentViolinFeature || "feature"}`,
                    width: cfg.imgWidth,
                    height: cfg.imgHeight,
                    scale: cfg.imgFormat === "svg" ? 1 : 6,
                });
            } catch (error) {
                console.warn("Download failed:", error);
            }
        },
    });
}

async function openFeatureViolinModal(feature) {
    if (!feature || !currentPayload) return;

    try {
        await ensureExpressionSourceLoaded();
        const values = expressionSourceCache.featureToValues.get(feature);
        if (!values) throw new Error(`Cannot find feature '${feature}' in normalized matrix.`);

        const sampleClassMap = buildSampleClassMap();
        const groups = new Map();
        expressionSourceCache.sampleIds.forEach((sampleId, index) => {
            const classLabel = sampleClassMap.get(sampleId);
            if (!classLabel) return;
            const value = values[index];
            if (!Number.isFinite(value)) return;
            if (!groups.has(classLabel)) groups.set(classLabel, []);
            groups.get(classLabel).push(value);
        });

        const orderedLabels = (Array.isArray(currentPayload.class_labels) ? currentPayload.class_labels : []).filter((label) => groups.has(label));
        const extraLabels = [...groups.keys()].filter((label) => !orderedLabels.includes(label));
        const labels = [...orderedLabels, ...extraLabels];
        if (!labels.length) throw new Error("No expression points available for violin plot.");

        const palette = ["#1d4ed8", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#be185d"];
        mountViolinConfigPanel(labels);
        const traces = labels.map((label, index) => ({
            type: "violin",
            name: label,
            x: new Array(groups.get(label).length).fill(label),
            y: groups.get(label),
            points: "outliers",
            pointpos: 0,
            jitter: 0.15,
            fillcolor: String(plotCfg.violin.classColors?.[label] || palette[index % palette.length]),
            line: { color: "#000000", width: Number(plotCfg.violin.lineWidth || 1.6) },
            box: { visible: true },
            meanline: { visible: true, color: "#000000", width: Number(plotCfg.violin.lineWidth || 1.6) },
            opacity: 0.7,
            hovertemplate: `${escapeHtml(label)}<br>Expression: %{y:.4f}<extra></extra>`,
            showlegend: false,
        }));

        const modalEl = dom.featureViolinModal();
        const plotEl = dom.featureViolinPlot();
        if (!modalEl || !plotEl) return;
        currentViolinFeature = feature;

        const violinPlotConfig = {
            titleFontSize: Number(plotCfg.violin?.axisTitleFontSize || 18),
            imgFormat: "svg",
            imgWidth: 500,
            imgHeight: 500,
            imgScale: 6,
        };
        dom.featureViolinTitle().textContent = `${feature}`;
        await Plotly.newPlot(plotEl, traces, {
            height: 420,
            margin: { t: 20, r: 16, b: 56, l: 56 },
            xaxis: {
                title: { text: "Group", font: { size: violinPlotConfig.titleFontSize } },
                tickfont: { size: violinPlotConfig.titleFontSize },
            },
            yaxis: {
                title: { text: "Normalized_Expression", font: { size: violinPlotConfig.titleFontSize } },
                tickfont: { size: violinPlotConfig.titleFontSize },
                automargin: true,
            },
            paper_bgcolor: "#fff",
            plot_bgcolor: "#fff",
        }, {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            toImageButtonOptions: {
                format: violinPlotConfig.imgFormat,
                filename: `violin_${feature}`,
                width: violinPlotConfig.imgWidth,
                height: violinPlotConfig.imgHeight,
                scale: violinPlotConfig.imgScale,
            },
        });


        if (!featureViolinModal && window.bootstrap) {
            featureViolinModal = new window.bootstrap.Modal(modalEl);
            modalEl.addEventListener("hidden.bs.modal", () => {
                currentViolinFeature = null;
                currentViolinLabels = [];
                if (featureViolinConfigPanel) {
                    featureViolinConfigPanel.destroy();
                    featureViolinConfigPanel = null;
                }
                const anchor = dom.featureViolinConfigAnchor();
                if (anchor) anchor.innerHTML = "";
                try {
                    Plotly.purge(plotEl);
                } catch (_) {
                    // ignore purge errors
                }
            });
        }
        featureViolinModal?.show();
    } catch (error) {
        setRunStatus(error?.message || "Unable to render feature violin plot.", true);
    }
}

function getBoundaryPalette() {
    const mode = String(plotCfg.importance?.classDotPalette || "default").toLowerCase();
    if (mode === "pastel") return ["#7dd3fc", "#86efac", "#fca5a5", "#fcd34d", "#c4b5fd", "#fdba74", "#f9a8d4", "#99f6e4"];
    if (mode === "high_contrast") return ["#1d4ed8", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0f766e", "#be123c", "#111827"];
    return GROUP_PALETTE;
}

function renderErrorPlot(payload) {
    const el = document.getElementById("rfd-plot-error");
    if (!el) return;
    const isSvm = String(payload?.model_type || "rf").toLowerCase() === "svm";
    if (isSvm) {
        const cfg = plotCfg.error;
        const folds = payload.classification?.cv_accuracy_folds || [];
        if (!folds.length) {
            el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No CV fold accuracy data available.</div>";
            return;
        }
        const x = folds.map((row) => `Fold ${row.fold}`);
        const y = folds.map((row) => Number(row.accuracy || 0));
        const mean = Number(payload.classification?.cv_mean_accuracy || 0);
        const traces = [{
            x,
            y,
            type: "scatter",
            mode: "lines+markers",
            line: { color: "#2563eb", width: cfg.lineWidth },
            marker: { color: "#2563eb", size: 12, line: { color: "#ffffff", width: 1.5 } },
            name: "Fold accuracy",
        }, {
            x,
            y: x.map(() => mean),
            type: "scatter",
            mode: "lines+markers",
            name: "Mean",
            line: { color: "#ef4444", width: cfg.lineWidth, dash: "dash" },
            marker: { color: "#ef4444", size: 11, symbol: "diamond", line: { color: "#ffffff", width: 1.5 } },
        }];
        Plotly.react(el, traces, {
            margin: { t: 16, r: 16, b: 50, l: 56 },
            xaxis: { title: { text: "CV Fold", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
            yaxis: { title: { text: "Accuracy", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, range: [0, 1] },
            legend: { font: { size: cfg.legendFontSize } },
            hovermode: "x unified",
            uirevision: getPlotUiRevision("classification-error-plot"),
            plot_bgcolor: "#fff",
            paper_bgcolor: "#fff",
        }, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true, edits: { legendPosition: true } });
        if (forceAutoscaleErrorPlot) {
            forceAutoscaleErrorPlot = false;
            Plotly.relayout(el, {
                "xaxis.autorange": true,
                "yaxis.autorange": true,
            }).catch(() => {
                // Ignore relayout timing errors.
            });
        }
        return;
    }

    const oobCurve = payload.classification?.oob_curve || [];
    if (!oobCurve.length) {
        el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No OOB error data available.</div>";
        return;
    }
    const cfg = plotCfg.error;
    const classLabels = payload.class_labels || [];
    const classColors = ["#2563eb","#dc2626","#16a34a","#d97706","#7c3aed","#0891b2"];
    const traces = [{
        x: oobCurve.map((row) => row.n_trees),
        y: oobCurve.map((row) => row.oob_error),
        type: "scatter",
        mode: "lines",
        name: "Overall",
        line: { color: "#1e293b", width: cfg.lineWidth, dash: "solid" },
    }];
    // Per-class OOB error lines (if backend provides them)
    classLabels.forEach((label, ci) => {
        const key = `error_class_${ci}`;
        if (oobCurve[0]?.[key] !== undefined) {
            traces.push({
                x: oobCurve.map((row) => row.n_trees),
                y: oobCurve.map((row) => row[key]),
                type: "scatter",
                mode: "lines",
                name: label,
                line: { color: classColors[ci % classColors.length], width: cfg.lineWidth, dash: "dot" },
            });
        }
    });
    const layout = {
        margin: { t: 16, r: 16, b: 50, l: 56 },
        xaxis: { title: { text: "Number of Trees", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
        yaxis: { title: { text: "OOB Error Rate", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
        legend: { font: { size: cfg.legendFontSize }, bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1 },
        showlegend: true,
        hovermode: "x unified",
        plot_bgcolor: "#fff",
        paper_bgcolor: "#fff",
    };
    layout.uirevision = getPlotUiRevision("classification-error-plot");
    preservePlotLegendPosition(el, layout);
    Plotly.react(el, traces, layout, {
        responsive: true,
        displayModeBar: "hover",
        displaylogo: false,
        scrollZoom: true,
        editable: true,
        edits: { legendPosition: true },
    });
}

function renderCmPlot(payload) {
    const el = document.getElementById("rfd-plot-cm");
    if (!el) return;
    const cfg = plotCfg.cm;
    const classLabels = payload.class_labels || [];
    const cmData = payload.classification?.confusion_matrix || [];
    if (!cmData.length) {
        el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No confusion matrix data available.</div>";
        return;
    }
    // cmData may be a 2D array (list of lists) or list of {label: count} objects
    const z = cmData.map((row) => {
        if (Array.isArray(row)) return row.map(Number);
        return classLabels.map((label) => Number(row[label] ?? 0));
    });
    const annotations = [];
    z.forEach((rowVals, ri) => {
        const rowMax = Math.max(...rowVals, 1);
        rowVals.forEach((val, ci) => {
            annotations.push({
                x: classLabels[ci],
                y: classLabels[ri],
                text: String(val),
                showarrow: false,
                font: { size: cfg.labelFontSize ?? cfg.axisFontSize, color: val > rowMax * 0.5 ? "#fff" : "#1e293b" },
            });
        });
    });
    const trace = {
        z,
        x: classLabels,
        y: classLabels,
        type: "heatmap",
        colorscale: [[0, "#dbeafe"], [1, "#1e40af"]],
        showscale: false,
        hoverongaps: false,
    };
    const layout = {
        margin: { t: 16, r: 16, b: 56, l: 64 },
        xaxis: { title: { text: "Predicted", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, side: "bottom" },
        yaxis: { title: { text: "Actual", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, autorange: "reversed" },
        annotations,
        plot_bgcolor: "#fff",
        paper_bgcolor: "#fff",
    };
    layout.uirevision = getPlotUiRevision("classification-cm-plot");
    Plotly.react(el, [trace], layout, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true });
}

function renderImportancePlot(payload) {
    const el = document.getElementById("rfd-plot-importance");
    if (!el) return;
    const isSvm = String(payload?.model_type || "rf").toLowerCase() === "svm";
    const svmKernel = String(payload?.kernel || "rbf").toLowerCase();

    if (isSvm && svmKernel === "rbf" && svmImportanceView === "boundary") {
        const boundary = payload?.decision_boundary;
        if (!boundary?.z || !boundary?.grid_x || !boundary?.grid_y) {
            el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No decision boundary data available.</div>";
            return;
        }
        const cfg = plotCfg.importance;
        const samplePoints = Array.isArray(boundary.sample_points) ? boundary.sample_points : [];
        const palette = getBoundaryPalette();
        const labels = [...new Set(samplePoints.map((p) => p.class_label))];
        const decisionGrid = Array.isArray(boundary.decision_function) ? boundary.decision_function : null;
        const decisionGridOvr = boundary?.decision_function_ovr && typeof boundary.decision_function_ovr === "object"
            ? boundary.decision_function_ovr
            : null;
        const isMulticlass = labels.length > 2;
        const traces = [{
            type: "contour",
            x: boundary.grid_x,
            y: boundary.grid_y,
            z: boundary.z,
            contours: { coloring: "heatmap" },
            line: { width: Math.max(0.5, Number(cfg.lineWidth || 1.5)) },
            opacity: Math.max(0.1, Math.min(1, Number(cfg.boundaryRegionOpacity || 0.25))),
            showscale: false,
            hoverinfo: "skip",
        }];
        if (decisionGrid && !isMulticlass) {
            [
                { level: -1, color: "#334155", name: "Hyperplane -1" },
                { level: 0, color: "#0f172a", name: "Decision boundary" },
                { level: 1, color: "#334155", name: "Hyperplane +1" },
            ].forEach((lineCfg) => {
                traces.push({
                    type: "contour",
                    x: boundary.grid_x,
                    y: boundary.grid_y,
                    z: decisionGrid,
                    contours: {
                        coloring: "none",
                        showlines: true,
                        start: lineCfg.level,
                        end: lineCfg.level,
                        size: 1,
                    },
                    line: { color: lineCfg.color, width: Math.max(0.5, Number(cfg.lineWidth || 1.5)), dash: lineCfg.level === 0 ? "solid" : "dash" },
                    name: lineCfg.name,
                    showlegend: true,
                    hoverinfo: "skip",
                });
            });
        } else if (decisionGridOvr && isMulticlass) {
            labels.forEach((label, idx) => {
                const classGrid = decisionGridOvr[label];
                if (!Array.isArray(classGrid) || !classGrid.length) return;
                [
                    { level: -1, dash: "dash", color: "#64748b" },
                    { level: 0, dash: "solid", color: palette[idx % palette.length] },
                    { level: 1, dash: "dash", color: "#64748b" },
                ].forEach((lineCfg) => {
                    traces.push({
                        type: "contour",
                        x: boundary.grid_x,
                        y: boundary.grid_y,
                        z: classGrid,
                        contours: {
                            coloring: "none",
                            showlines: true,
                            start: lineCfg.level,
                            end: lineCfg.level,
                            size: 1,
                        },
                        line: {
                            color: lineCfg.color,
                            width: Math.max(0.5, Number(cfg.lineWidth || 1.5)),
                            dash: lineCfg.dash,
                        },
                        name: `${label} ${lineCfg.level === 0 ? "boundary" : lineCfg.level > 0 ? "+1 margin" : "-1 margin"}`,
                        showlegend: false,
                        hoverinfo: "skip",
                    });
                });
            });

            // Add compact legend descriptors for multiclass overlays.
            traces.push({
                type: "scatter",
                mode: "lines",
                x: [null, null],
                y: [null, null],
                line: { color: "#334155", width: Math.max(0.5, Number(cfg.lineWidth || 1.5)), dash: "dash" },
                name: "Hyperplanes (±1)",
                hoverinfo: "skip",
            });
            traces.push({
                type: "scatter",
                mode: "lines",
                x: [null, null],
                y: [null, null],
                line: { color: "#0f172a", width: Math.max(0.5, Number(cfg.lineWidth || 1.5)), dash: "solid" },
                name: "Decision boundary",
                hoverinfo: "skip",
            });
        }
        const supportVectors = samplePoints.filter((p) => Boolean(p.is_support_vector));
        labels.forEach((label, idx) => {
            const rows = samplePoints.filter((p) => p.class_label === label);
            traces.push({
                type: "scatter",
                mode: "markers",
                name: label,
                x: rows.map((p) => p.pc1),
                y: rows.map((p) => p.pc2),
                marker: {
                    size: Number(cfg.dotSize || 9),
                    opacity: Number(cfg.dotOpacity || 0.8),
                    color: palette[idx % palette.length],
                },
            });
        });
        if (supportVectors.length) {
            traces.push({
                type: "scatter",
                mode: "markers",
                name: "Support Vectors",
                x: supportVectors.map((p) => p.pc1),
                y: supportVectors.map((p) => p.pc2),
                marker: {
                    size: Math.max(Number(cfg.dotSize || 9) + 4, 10),
                    symbol: "circle-open",
                    color: "#111",
                    line: { width: Math.max(0.5, Number(cfg.lineWidth || 1.5)), color: "#111" },
                },
                hovertemplate: "Support Vector<extra></extra>",
            });
        }
        Plotly.react(el, traces, {
            margin: { t: 16, r: 16, b: 56, l: 72 },
            xaxis: { title: { text: `PC1 (${(Number(boundary.pc1_variance_ratio || 0) * 100).toFixed(1)}% variance)`, font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
            yaxis: { title: { text: `PC2 (${(Number(boundary.pc2_variance_ratio || 0) * 100).toFixed(1)}% variance)`, font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
            legend: { font: { size: cfg.legendFontSize } },
            uirevision: getPlotUiRevision("classification-importance-plot"),
            plot_bgcolor: "#fff",
            paper_bgcolor: "#fff",
        }, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true, edits: { legendPosition: true } });
        return;
    }

    const cfg = plotCfg.importance;
    const allRows = (payload.feature_importance?.table || []).filter((row) => currentState.visibleFeatures.has(row.feature));
    const legendEl = document.getElementById("rfd-legend-importance");
    if (legendEl) {
        legendEl.innerHTML = "";
        legendEl.style.display = "none";
    }
    if (!allRows.length) {
        el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No features selected. Click rows in the Feature Table to show features.</div>";
        return;
    }
    const traces = allRows.map((row) => {
        const color = String(plotCfg.importance?.boxColor || "#1e40af");
        const groupMeans = getFeatureGroupMeans(row.feature);
        const meanText = groupMeans.length
            ? groupMeans.map((item) => `${escapeHtml(item.label)} mean: ${Number(item.mean).toFixed(4)} (n=${item.count})`).join("<br>")
            : (row.mean_expression == null ? "" : `Overall mean expression: ${Number(row.mean_expression).toFixed(4)}`);
        const xVal = Number(row.importance ?? row.base_importance ?? 0);
        return {
            x: [xVal],
            y: [row.feature],
            type: "bar",
            orientation: "h",
            name: row.feature,
            marker: { color, line: { color, width: 0.5 } },
            hovertemplate: `<b>${escapeHtml(row.feature)}</b><br>Importance: %{x:.6f}<br>${meanText}<extra></extra>`,
            showlegend: false,
        };
    });
    const sortedFeatures = [...allRows].sort((a, b) => {
        const aVal = Number(a.importance ?? a.base_importance ?? 0);
        const bVal = Number(b.importance ?? b.base_importance ?? 0);
        return aVal - bVal;
    }).map((r) => r.feature);
    const layout = {
        margin: { t: 16, r: 16, b: 56, l: 130 },
        xaxis: { title: { text: "Importance", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
        yaxis: { title: { font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, categoryorder: "array", categoryarray: sortedFeatures },
        showlegend: false,
        uirevision: getPlotUiRevision("classification-importance-plot"),
        plot_bgcolor: "#fff",
        paper_bgcolor: "#fff",
    };
    Plotly.react(el, traces, layout, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true });
    if (typeof el.removeAllListeners === "function") {
        el.removeAllListeners("plotly_click");
    }
    el.on("plotly_click", (event) => {
        const feature = event?.points?.[0]?.data?.name;
        if (feature) openFeatureViolinModal(feature);
    });
}

function renderOutlierPlot(payload) {
    const el = document.getElementById("rfd-plot-outlier");
    if (!el) return;
    const isSvm = String(payload?.model_type || "rf").toLowerCase() === "svm";
    if (isSvm) {
        const cfg = plotCfg.outlier;
        const curves = payload?.roc?.curves || [];
        if (!curves.length) {
            el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No ROC curve data available.</div>";
            return;
        }
        const traces = [{
            x: [0, 1],
            y: [0, 1],
            type: "scatter",
            mode: "lines",
            line: { dash: "dash", color: "#94a3b8", width: cfg.lineWidth },
            name: "Random",
        }];
        curves.forEach((curve, idx) => {
            const ciText = (curve.ci_low == null || curve.ci_high == null)
                ? ""
                : ` (95% CI: ${Number(curve.ci_low).toFixed(2)}-${Number(curve.ci_high).toFixed(2)})`;
            traces.push({
                x: curve.fpr,
                y: curve.tpr,
                type: "scatter",
                mode: "lines",
                name: `${curve.class_label} — AUC=${Number(curve.auc || 0).toFixed(2)}${ciText}`,
                line: { width: cfg.lineWidth, color: GROUP_PALETTE[idx % GROUP_PALETTE.length] },
            });
            traces.push({
                x: [curve.optimal_fpr],
                y: [curve.optimal_tpr],
                type: "scatter",
                mode: "markers",
                showlegend: false,
                marker: { size: 10, color: GROUP_PALETTE[idx % GROUP_PALETTE.length], line: { width: 1, color: "#0f172a" } },
                hovertemplate: `${escapeHtml(curve.class_label)}<br>Cutoff=%{text}<extra></extra>`,
                text: [curve.optimal_threshold == null ? "-" : Number(curve.optimal_threshold).toFixed(4)],
            });
        });
        Plotly.react(el, traces, {
            margin: { t: 20, r: 16, b: 56, l: 56 },
            xaxis: { title: { text: "False Positive Rate", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, range: [0, 1] },
            yaxis: { title: { text: "True Positive Rate", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, range: [0, 1] },
            legend: { font: { size: cfg.legendFontSize } },
            uirevision: getPlotUiRevision("classification-outlier-plot"),
            plot_bgcolor: "#fff",
            paper_bgcolor: "#fff",
        }, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true, edits: { legendPosition: true } });
        return;
    }

    const cfg = plotCfg.outlier;
    const allRows = (payload.outlier_detection?.table || []).filter((r) => currentState.visibleSamples.has(r.sample_id));
    if (!allRows.length) {
        el.innerHTML = "<div style='padding:1rem;color:#64748b;font-size:0.8rem;'>No outlier data available.</div>";
        return;
    }
    const groups = [...new Set(allRows.map((r) => r.class_label))].sort();
    const colorMap = {};
    groups.forEach((g, i) => { colorMap[g] = GROUP_PALETTE[i % GROUP_PALETTE.length]; });
    // Interpret lineWidth control as bar thickness along the x-category axis.
    const barWidth = Math.max(0.12, Math.min(0.95, Number(cfg.lineWidth || 1.5) / 3));
    const groupTraces = groups.map((group) => {
        const groupRows = allRows.filter((r) => r.class_label === group);
        return {
            x: groupRows.map((r) => r.sample_id),
            y: groupRows.map((r) => r.outlying_measure),
            type: "bar",
            name: group,
            width: barWidth,
            marker: { color: colorMap[group], line: { color: "#fff", width: 0.6 } },
            text: groupRows.map((r) => currentState.labelSamples.has(r.sample_id) ? r.sample_id : ""),
            textposition: "outside",
            textfont: { size: cfg.labelFontSize },
            outsidetextfont: { size: cfg.labelFontSize },
            cliponaxis: false,
            hovertemplate: `<b>%{x}</b><br>Outlying Measure: %{y:.4f}<extra>${escapeHtml(group)}</extra>`,
            showlegend: true,
            customdata: groupRows.map((r) => r.sample_id),
        };
    });
    const layout = {
        margin: { t: 20, r: 16, b: 80, l: 56 },
        xaxis: { title: { text: "Sample", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 }, tickangle: -45 },
        yaxis: { title: { text: "Outlying Measure", font: { size: cfg.axisFontSize } }, tickfont: { size: cfg.axisFontSize - 1 } },
        barmode: "stack",
        showlegend: true,
        legend: { font: { size: cfg.legendFontSize }, bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1 },
        plot_bgcolor: "#fff",
        paper_bgcolor: "#fff",
    };
    layout.uirevision = getPlotUiRevision("classification-outlier-plot");
    preservePlotLegendPosition(el, layout);
    Plotly.react(el, groupTraces, layout, { responsive: true, displayModeBar: "hover", displaylogo: false, scrollZoom: true, editable: true, edits: { legendPosition: true } });
    if (typeof el.removeAllListeners === "function") {
        el.removeAllListeners("plotly_click");
    }
    el.on("plotly_click", (event) => {
        const sampleId = event?.points?.[0]?.customdata;
        if (sampleId) toggleSampleLabel(sampleId);
    });
}

function renderAllPlots() {
    if (!currentPayload) return;
    ensureOutlierTabPresent();
    initPlotConfigPanels();
    syncModelTypeUi();
    dom.resultTabsSection()?.classList.remove("d-none");
    dom.resultsArea()?.classList.remove("d-none");
    dom.emptyState()?.classList.add("d-none");
    renderClassificationInfo();
    renderImportanceTable();
    renderOutlierTable();
    renderErrorPlot(currentPayload);
    renderCmPlot(currentPayload);
    renderImportancePlot(currentPayload);
    renderOutlierPlot(currentPayload);
}

function setActiveTab(name) {
    currentTab = name;
    dom.resultTabs().forEach((btn) => btn.classList.toggle("active", btn.dataset.rfTab === name));
    dom.classificationSection()?.classList.toggle("d-none", name !== "classification");
    dom.importanceSection()?.classList.toggle("d-none", name !== "importance");
    dom.outlierSection()?.classList.toggle("d-none", name !== "outlier");
}

function readConfigFromInputs(plotKey) {
    if (plotKey === "error") {
        plotCfg.error.axisFontSize = Number(document.getElementById("rfd-error-axisfont")?.value || 11);
        plotCfg.error.legendFontSize = Number(document.getElementById("rfd-error-legfont")?.value || 10);
        plotCfg.error.lineWidth = Number(document.getElementById("rfd-error-linewidth")?.value || 2);
    } else if (plotKey === "cm") {
        plotCfg.cm.axisFontSize = Number(document.getElementById("rfd-cm-axisfont")?.value || 11);
        plotCfg.cm.legendFontSize = Number(document.getElementById("rfd-cm-legfont")?.value || 10);
    } else if (plotKey === "importance") {
        plotCfg.importance.axisFontSize = Number(document.getElementById("rfd-importance-axisfont")?.value || 11);
        plotCfg.importance.legendFontSize = Number(document.getElementById("rfd-importance-legfont")?.value || 10);
    } else if (plotKey === "outlier") {
        plotCfg.outlier.axisFontSize = Number(document.getElementById("rfd-outlier-axisfont")?.value || 11);
        plotCfg.outlier.legendFontSize = Number(document.getElementById("rfd-outlier-legfont")?.value || 10);
        plotCfg.outlier.lineWidth = Number(document.getElementById("rfd-outlier-linewidth")?.value || 1.5);
        plotCfg.outlier.labelFontSize = Number(document.getElementById("rfd-outlier-labelsize")?.value || 10);
    }
}

function applyPlot(plotKey) {
    if (!currentPayload) return;
    // plotCfg.* is already updated by spec.sync() before applyPlot is called;
    // do NOT call readConfigFromInputs here (old inline HTML inputs no longer exist)
    if (plotKey === "error") renderErrorPlot(currentPayload);
    else if (plotKey === "cm") renderCmPlot(currentPayload);
    else if (plotKey === "importance") {
        renderImportancePlot(currentPayload);
        const modalEl = dom.featureViolinModal();
        if (modalEl?.classList.contains("show") && currentViolinFeature) {
            openFeatureViolinModal(currentViolinFeature);
        }
    }
    else if (plotKey === "outlier") renderOutlierPlot(currentPayload);
}

function initPlotConfigPanels() {
    mountedPlotPanels.forEach((panel) => panel?.destroy?.());
    mountedPlotPanels = [];

    const isSvmPayload = String(currentPayload?.model_type || "rf").toLowerCase() === "svm";
    const isSvmRbf = isSvmPayload && String(currentPayload?.kernel || "rbf").toLowerCase() === "rbf";
    const isBoundaryMode = isSvmRbf && svmImportanceView === "boundary";

    const panelSpecs = [
        {
            key: "cm",
            anchorSelector: "#rfd-panel-cm .rfd-actions",
            plotId: "rfd-plot-cm",
            filename: "confusion_matrix",
            defaults: { ...PLOT_CONFIG_DEFAULTS, axisFontSize: plotCfg.cm.axisFontSize, legendFontSize: plotCfg.cm.legendFontSize, labelFontSize: 12, imgFormat: "svg", imgWidth: 900, imgHeight: 600 },
            options: { showMarkerSize: false, showMarkerOpacity: false, showAxisFontSize: true, showLabelSize: true, showLegendFontSize: false, showLineWidth: false, showEllipseOpacity: false },
            sync: (cfg) => {
                plotCfg.cm.axisFontSize = Number(cfg.axisFontSize || 11);
                plotCfg.cm.legendFontSize = Number(cfg.legendFontSize || 10);
                plotCfg.cm.labelFontSize = Number(cfg.labelFontSize || 12);
            },
        },
        {
            key: "error",
            anchorSelector: "#rfd-panel-error .rfd-actions",
            plotId: "rfd-plot-error",
            filename: "oob_error",
            defaults: { ...PLOT_CONFIG_DEFAULTS, axisFontSize: plotCfg.error.axisFontSize, legendFontSize: plotCfg.error.legendFontSize, lineWidth: plotCfg.error.lineWidth, imgFormat: "svg", imgWidth: 900, imgHeight: 600 },
            options: { showMarkerSize: false, showMarkerOpacity: false, showAxisFontSize: true, showLabelSize: false, showLegendFontSize: true, showLineWidth: true, showEllipseOpacity: false },
            sync: (cfg) => {
                plotCfg.error.axisFontSize = Number(cfg.axisFontSize || 11);
                plotCfg.error.legendFontSize = Number(cfg.legendFontSize || 10);
                plotCfg.error.lineWidth = Number(cfg.lineWidth || 2);
            },
        },
        {
            key: "importance",
            anchorSelector: "#rfd-panel-importance .rfd-actions",
            plotId: "rfd-plot-importance",
            filename: "var_importance",
            defaults: {
                ...PLOT_CONFIG_DEFAULTS,
                axisFontSize: plotCfg.importance.axisFontSize,
                legendFontSize: plotCfg.importance.legendFontSize,
                lineWidth: plotCfg.importance.lineWidth,
                markerSize: plotCfg.importance.dotSize,
                markerOpacity: plotCfg.importance.dotOpacity,
                ellipseOpacity: plotCfg.importance.boundaryRegionOpacity,
                boxColor: plotCfg.importance.boxColor,
                testType: plotCfg.importance.classDotPalette || "default",
                imgFormat: "svg",
                imgWidth: 900,
                imgHeight: 600,
            },
            options: {
                showMarkerSize: isBoundaryMode,
                showMarkerOpacity: isBoundaryMode,
                showAxisFontSize: true,
                showLabelSize: false,
                showLegendFontSize: isBoundaryMode,
                showLineWidth: isBoundaryMode,
                showEllipseOpacity: isBoundaryMode,
                showColorPicker: !isBoundaryMode,
                colorPickerKey: "boxColor",
                colorPickerLabel: "Boxplot color",
                showTestType: isBoundaryMode,
                testTypeLabel: "Class dot color",
                defaultTestType: plotCfg.importance.classDotPalette || "default",
                testTypeList: [
                    { value: "default", label: "Default" },
                    { value: "high_contrast", label: "High contrast" },
                    { value: "pastel", label: "Pastel" },
                ],
            },
            sync: (cfg) => {
                plotCfg.importance.axisFontSize = Number(cfg.axisFontSize || 11);
                plotCfg.importance.legendFontSize = Number(cfg.legendFontSize || 10);
                plotCfg.importance.lineWidth = Number(cfg.lineWidth || 1.5);
                plotCfg.importance.dotSize = Number(cfg.markerSize || 9);
                plotCfg.importance.dotOpacity = Number(cfg.markerOpacity || 0.8);
                plotCfg.importance.boundaryRegionOpacity = Number(cfg.ellipseOpacity || 0.25);
                plotCfg.importance.boxColor = String(cfg.boxColor || "#1e40af");
                plotCfg.importance.classDotPalette = String(cfg.testType || plotCfg.importance.classDotPalette || "default");
            },
        },
        {
            key: "outlier",
            anchorSelector: "#rfd-panel-outlier .rfd-actions",
            plotId: "rfd-plot-outlier",
            filename: "outlier_detection",
            defaults: {
                ...PLOT_CONFIG_DEFAULTS,
                axisFontSize: plotCfg.outlier.axisFontSize,
                legendFontSize: plotCfg.outlier.legendFontSize,
                labelFontSize: 10,
                lineWidth: plotCfg.outlier.lineWidth,
                imgFormat: "svg",
                imgWidth: 900,
                imgHeight: 600,
            },
            options: {
                showMarkerSize: false,
                showMarkerOpacity: false,
                showAxisFontSize: true,
                showLabelSize: !isSvmPayload,
                showLegendFontSize: true,
                showLineWidth: true,
                showEllipseOpacity: false,
            },
            sync: (cfg) => {
                plotCfg.outlier.axisFontSize = Number(cfg.axisFontSize || 11);
                plotCfg.outlier.legendFontSize = Number(cfg.legendFontSize || 10);
                plotCfg.outlier.labelFontSize = Number(cfg.labelFontSize || plotCfg.outlier.labelFontSize || 10);
                plotCfg.outlier.lineWidth = Number(cfg.lineWidth || 1.5);
            },
        },
    ];

    panelSpecs.forEach((spec) => {
        const anchor = document.querySelector(spec.anchorSelector);
        if (!anchor) return;
        anchor.innerHTML = "";
        const panel = mountPlotConfigPanel({
            anchor,
            defaults: spec.defaults,
            options: spec.options,
            onUpdate: (_key, _value, allCfg) => {
                spec.sync(allCfg);
                applyPlot(spec.key);
            },
            onDownload: async (cfg) => {
                const plotEl = document.getElementById(spec.plotId);
                if (!plotEl || !plotEl._fullLayout) return;
                try {
                    await Plotly.downloadImage(plotEl, {
                        format: cfg.imgFormat,
                        filename: spec.filename,
                        width: cfg.imgWidth,
                        height: cfg.imgHeight,
                        scale: cfg.imgFormat === "svg" ? 1 : 6,
                    });
                } catch (error) {
                    console.warn("Download failed:", error);
                }
            },
        });
        mountedPlotPanels.push(panel);
    });
}

function toggleFeatureVisibility(feature) {
    if (!feature) return;
    if (currentState.visibleFeatures.has(feature)) currentState.visibleFeatures.delete(feature);
    else currentState.visibleFeatures.add(feature);
    renderImportanceTable();
    if (currentPayload) renderImportancePlot(currentPayload);
}

function toggleSampleVisibility(sampleId) {
    if (!sampleId) return;
    if (currentState.visibleSamples.has(sampleId)) {
        currentState.visibleSamples.delete(sampleId);
        currentState.labelSamples.delete(sampleId);
    } else {
        currentState.visibleSamples.add(sampleId);
    }
    renderOutlierTable();
    if (currentPayload) renderOutlierPlot(currentPayload);
}

function toggleSampleLabel(sampleId) {
    if (!sampleId) return;
    if (currentState.labelSamples.has(sampleId)) currentState.labelSamples.delete(sampleId);
    else currentState.labelSamples.add(sampleId);
    if (currentPayload) renderOutlierPlot(currentPayload);
}

function highlightSampleRow(sampleId) {
    if (!sampleId) return;
    currentState.selectedSampleId = sampleId;
    renderOutlierTable();
}



// Định nghĩa đúng hàm executeRun để tránh lỗi runtime và đảm bảo nút RUN hoạt động
async function executeRun() {
    if (!validateForm()) return;
    startRunCooldown();
    const runLabel = selectedModelType === "svm" ? "SVM" : "Random Forest";
    setBusy(true, `Submitting ${runLabel} analysis...`);
    try {
        // Analysis Name: auto-fill with RFA_date_time if empty
        let analysisName = dom.analysisName().value.trim();
        const defaultAnalysisName = getDefaultAnalysisName();
        if (!analysisName || analysisName === defaultAnalysisName || analysisName === "Analysis") {
            analysisName = getAutoAnalysisName();
            dom.analysisName().value = analysisName;
        }
        const baseSettings = {
            analysis_name: analysisName,
            model_type: selectedModelType,
            mode: currentMode,
        };

        if (selectedModelType === "svm") {
            baseSettings.kernel = String(dom.svmKernel()?.value || "rbf");
            baseSettings.C = Number(dom.svmC()?.value || 1.0);
            baseSettings.cv_folds = Number(dom.svmCvFolds()?.value || 5);
            baseSettings.class_weight = String(dom.svmClassWeight()?.value || "balanced");
            baseSettings.n_bootstrap = Number(dom.svmNBootstrap()?.value || 1000);
            baseSettings.ci_level = Number(dom.svmCiLevel()?.value || 0.95);
            baseSettings.cutoff_method = String(dom.svmCutoffMethod()?.value || "youden");
            baseSettings.max_importance_top = 15;
            if (String(baseSettings.kernel).toLowerCase() === "rbf") {
                baseSettings.n_repeats_permutation = Number(dom.svmNRepeatsPermutation()?.value || 10);
            }
        } else {
            baseSettings.ntree = Number(dom.nEstimators().value || DEFAULT_N_TREES);
            baseSettings.max_features = dom.maxFeatures().value || DEFAULT_MAX_FEATURES;
        }

        let runSettings = baseSettings;
        if (currentMode === "split") {
            const splitMeta = await buildSplitMetaSource();
            runSettings = {
                ...baseSettings,
                ...splitMeta,
                meta_path: splitMeta.metaPathOverride,
            };
        } else {
            const manualMeta = await buildManualMetaSource();
            runSettings = {
                ...baseSettings,
                ...manualMeta,
            };
        }

        const response = await fetch(`${vpsUrl}/random-forest/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                matrix_path: projectData?.matrixNormPath,
                meta_path: runSettings.meta_path || projectData?.metaCheckedPath,
                settings: runSettings,
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.detail || "Failed to start Random Forest run.");
        }
        currentRunId = data.run_id || null;
        selectedHistoryRunId = currentRunId;
        
        // Format selected groups for display
        let groupsDisplay = "";
        if (currentMode === "split" && runSettings.splitConfig) {
            // For split mode: extract group names from comparison
            const comparison = String(runSettings.comparison || "");
            groupsDisplay = comparison; // e.g., "g1 | g2 | g3"
        } else if (runSettings.selected_groups && runSettings.selected_groups.length > 0) {
            // For manual mode: join selected groups
            groupsDisplay = runSettings.selected_groups.join(" | ");
        } else if (currentMode === "manual" && runSettings.comparison === "__all__") {
            // Manual all-groups mode: derive group labels from target metadata
            const manualGroups = getManualGroupValues(runSettings.target || "");
            groupsDisplay = manualGroups.join(" | ");
        }
        
        analysisHistory = deduplicateHistory([
            {
                run_id: data.run_id || null,
                task_id: data.task_id ?? null,
                name: analysisName,
                date: new Date().toISOString(),
                target: runSettings.displayTarget || runSettings.target || null,
                displayTarget: runSettings.displayTarget || runSettings.target || null,
                comparison: runSettings.comparison || null,
                selected_groups_display: groupsDisplay,
                status: "pending",
                message: "Queued for processing.",
                model_type: selectedModelType,
            },
            ...analysisHistory.filter((item) => item.run_id !== data.run_id),
        ]);
        renderHistoryPopup();
        dom.historyPopup().classList.add("open");
        setBusy(false, data.message || `Queued run ${currentRunId || ""}`);
    } catch (error) {
        setBusy(false, error.message, true);
    }
}

async function initPage() {
    // Debug local storage
    console.log("🔥 local storage initialized:");
    console.log("  - Storage:", storage ? "✅ Available" : "❌ Missing");
    console.log("  - Bucket:", storage?.app?.options?.storageBucket || "unknown");
    console.log("  - User:", auth.currentUser?.email || "not logged in");
    
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(projectData.norm_settings, projectData.normality_stat);
    analysisHistory = deduplicateHistory(Array.isArray(projectData.rf_history) ? [...projectData.rf_history] : []);
    
    // Debug history entries
    if (analysisHistory.length > 0) {
        console.log("📋 Loaded history entries:");
        analysisHistory.forEach((entry) => {
            console.log(`  - ${entry.name} (${entry.run_id}):`, entry.results_url);
        });
    }
    
    renderHistoryPopup();
    validateForm();

    const initialMetaPath = projectData?.metaCheckedPath || projectData?.meta_path || null;
    if (initialMetaPath) {
        preloadSplitEngine(initialMetaPath).catch(() => {
            // Keep manual mode usable even if split preload fails.
        });
    }
    populateTargetSelect();

    // Keep initial view empty; load a run only when user explicitly picks from History or runs a new analysis.

    await syncRunTaskState(projectData.rf_task || null);

    onSnapshot(doc(db, "projects", projectId), async (docSnap) => {
        const data = docSnap.data() || {};
        projectData = data;
        analysisHistory = deduplicateHistory(Array.isArray(data.rf_history) ? [...data.rf_history] : []);
        renderHistoryPopup();
        await syncRunTaskState(data.rf_task || null);
    });

    dom.historyToggle().addEventListener("click", () => {
        dom.historyPopup().classList.toggle("open");
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".history-anchor")) {
            dom.historyPopup().classList.remove("open");
        }
    });

    dom.modeManual().onclick = () => setMode("manual");
    dom.modeSplit().onclick = async () => {
        setMode("split");
        validateForm();
        try {
            if (splitPreloadPromise) await splitPreloadPromise;
            else await preloadSplitEngine();
            if (!pendingSplitHistorySnapshot) {
                splitEngine?.reset();
            }
            validateForm();
        } catch (error) {
            setRunStatus(error?.message || "Unable to initialize split mode.", true);
        }
    };
    dom.targetSelect().onchange = () => {
        renderComparisonOptions();
        validateForm();
    };
    dom.modelType()?.addEventListener("change", () => {
        syncModelTypeUi();
        initPlotConfigPanels();
        maybeRefreshDefaultAnalysisName();
        validateForm();
        if (currentPayload) {
            renderClassificationInfo();
            renderErrorPlot(currentPayload);
            renderOutlierPlot(currentPayload);
            renderImportancePlot(currentPayload);
        }
    });
    dom.svmKernel()?.addEventListener("change", () => {
        syncModelTypeUi();
        initPlotConfigPanels();
        validateForm();
        if (currentPayload) renderImportancePlot(currentPayload);
    });
    dom.svmViewFeatureBtn()?.addEventListener("click", () => {
        svmImportanceView = "feature";
        dom.svmViewFeatureBtn()?.classList.add("active");
        dom.svmViewBoundaryBtn()?.classList.remove("active");
        initPlotConfigPanels();
        if (currentPayload) renderImportancePlot(currentPayload);
    });
    dom.svmViewBoundaryBtn()?.addEventListener("click", () => {
        svmImportanceView = "boundary";
        dom.svmViewBoundaryBtn()?.classList.add("active");
        dom.svmViewFeatureBtn()?.classList.remove("active");
        initPlotConfigPanels();
        if (currentPayload) renderImportancePlot(currentPayload);
    });
    document.addEventListener("change", (event) => {
        if (event.target?.matches?.(".rf-comp-check")) {
            validateForm();
        }
    });
    
    // ntree popup trigger
    const ntreeButton = document.getElementById("rf-ntree-trigger");
    const ntreePopup = document.getElementById("rf-ntree-popup");
    const presetButtons = document.querySelectorAll(".rf-preset-btn");
    
    if (ntreeButton) {
        ntreeButton.addEventListener("click", (e) => {
            e.stopPropagation();
            ntreePopup.classList.toggle("open");
        });
    }
    
    presetButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            const value = btn.dataset.value;
            dom.nEstimators().value = value;
            if (ntreeButton) {
                ntreeButton.textContent = `Select Trees: ${value}`;
            }
            ntreePopup.classList.remove("open");
            validateForm();
        });
    });
    
    // Close popup when clicking outside
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".rf-ntree-anchor")) {
            ntreePopup.classList.remove("open");
        }
    });
    
    dom.maxFeatures().onchange = validateForm;
    dom.svmC()?.addEventListener("input", validateForm);
    dom.svmCvFolds()?.addEventListener("change", validateForm);
    dom.svmClassWeight()?.addEventListener("change", validateForm);
    dom.svmNBootstrap()?.addEventListener("change", validateForm);
    dom.svmCiLevel()?.addEventListener("change", validateForm);
    dom.svmCutoffMethod()?.addEventListener("change", validateForm);
    dom.svmNRepeatsPermutation()?.addEventListener("change", validateForm);
    dom.importanceSort()?.addEventListener("change", () => renderImportanceTable());
    dom.importanceClass()?.addEventListener("change", () => renderImportanceTable());
    dom.importanceSearch()?.addEventListener("input", () => renderImportanceTable());
    dom.outlierSort()?.addEventListener("change", () => renderOutlierTable());
    dom.outlierClass()?.addEventListener("change", () => renderOutlierTable());
    dom.outlierSearch()?.addEventListener("input", () => renderOutlierTable());
    dom.runButton().onclick = executeRun;
    dom.resultTabs().forEach((button) => {
        button.addEventListener("click", () => setActiveTab(button.dataset.rfTab));
    });
    initPlotConfigPanels();

    const initialSuggestedName = getDefaultAnalysisName();
    dom.analysisName().value = initialSuggestedName;
    dom.analysisName().dataset.suggestedName = initialSuggestedName;
    dom.nEstimators().value = DEFAULT_N_TREES;
    dom.maxFeatures().value = DEFAULT_MAX_FEATURES;
    if (dom.modelType()) dom.modelType().value = "rf";
    syncModelTypeUi();
    setMode("manual");
    document.body.classList.add("loaded");
}

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) {
        document.body.classList.add("loaded");
        return;
    }
    try {
        await loadSidebar(user.uid);
        await initPage();
    } catch (err) {
        console.error("Random Forest init error:", err);
        document.body.classList.add("loaded");
    }
});
