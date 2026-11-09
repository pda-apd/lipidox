import "./auth-gate.js";
import { db, auth, storage } from "./firebase-config.js";
import { createSplitMetaEngine } from "./splitmeta.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { sortMetadataLabels } from "./meta-label-utils.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, updateDoc, onSnapshot, getToken } from "./firebase-config.js";
import { ref, getDownloadURL, uploadString } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS, TASK_STALE_TIMEOUT_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");
const requestedRunId = urlParams.get("run");
const requestedTab = urlParams.get("tab") || "overview";
const FALLBACK_ENRICHMENT_DATABASES = [
    "GO_Biological_Process_2023",
    "GO_Cellular_Component_2023",
    "GO_Molecular_Function_2023",
    "KEGG_2021_Human",
    "Reactome_2022",
    "WikiPathway_2023_Human",
    "Human_Protein_Atlas_ver25_Biological_process",
    "Human_Protein_Atlas_ver25_Disease_involvement",
    "Human_Protein_Atlas_ver25_Protein_class",
];
const HPA_DATABASE_PREFIX = "Human_Protein_Atlas_ver25";

let projectData = null;
let uniResultsGlobal = [];
let selectedLipids = new Set();
const volcanoLabelPositions = new Map(); // lipid → { ax, ay } in data coords — persists dragged label positions
let analysisHistory = [];
let enrichmentHistory = [];
let networkHistory = [];
let currentRunId = null;
let currentCsvUrl = null;
let selectedHistoryRunId = null;
let selectedEnrichmentRunId = null;
let selectedNetworkRunId = null;
let currentResultsUrl = null;
let violinDataCache = new Map();
let currentAnalysisContext = { target: null, comparison: null, displayTarget: null, displayComparison: null, displayGroupMap: null, metaPathOverride: null };
let currentViolinRequestId = 0;
let enrichmentModal = null;
let networkModal = null;
let staleAnalysisRunId = null;
let runCooldownUntil = 0;
let runCooldownTimer = null;
let splitWorkspaceVisible = false;
let pendingSplitHistorySnapshot = null;
const splitRunContext = new Map();
let splitEngine = null;
let splitNodeRegistry = new Map();

const volcanoPlotConfig = { ...PLOT_CONFIG_DEFAULTS, imgWidth: 800, imgHeight: 500 };
const violinPlotConfig = {
    tickFontSize: 18,      // cỡ chữ số/nhãn trên trục (tick labels)
    titleFontSize: 18,     // cỡ chữ tiêu đề trục (axis title)
    imgFormat: "svg",     // định dạng download: 'svg' | 'png'
    imgWidth: 300,        // pixel width khi download
    imgHeight: 300,       // pixel height khi download
    imgScale: 6,          // scale (chỉ áp dụng khi format = 'png')
};
let splitSelectedBranchKeys = { group1: [], group2: [] };
let violinSourceCache = {
    matrixPath: null,
    metaPath: null,
    matrixHeader: [],
    lipidToValues: new Map(),
    metaHeader: [],
    sampleToMeta: new Map()
};

const MAX_SPLIT_LEVELS = 3;
const DEFAULT_SPLIT_LEVEL = () => ({ column: "" });
const splitState = {
    mode: "manual",
    activeGroup: "group1",
    groupNames: { group1: "group1", group2: "group2" },
    levelConfigs: Array.from({ length: MAX_SPLIT_LEVELS }, () => DEFAULT_SPLIT_LEVEL()),
    selectedNodes: { group1: [], group2: [] },
};

const dom = {
    setupCard: () => document.getElementById("analysis-setup-card"),
    historyToggle: () => document.getElementById("history-toggle"),
    historyPopup: () => document.getElementById("history-popup"),
    analysisName: () => document.getElementById("analysis-name"),
    configModeManual: () => document.getElementById("config-mode-manual"),
    configModeSplit: () => document.getElementById("config-mode-split"),
    manualConfigSection: () => document.getElementById("manual-config-section"),
    splitConfigSection: () => document.getElementById("split-config-section"),
    target: () => document.getElementById("ana-target"),
    compList: () => document.getElementById("comparisons-list"),
    splitGroup1Name: () => document.getElementById("split-group1-name"),
    splitGroup2Name: () => document.getElementById("split-group2-name"),
    splitTabGroup1: () => document.getElementById("split-tab-group1"),
    splitTabGroup2: () => document.getElementById("split-tab-group2"),
    splitSummary: () => document.getElementById("split-summary"),
    splitWorkspace: () => document.getElementById("split-workspace"),
    splitWorkspaceStatus: () => document.getElementById("split-workspace-status"),
    splitCol1: () => document.getElementById("split-col1"),
    splitCol2: () => document.getElementById("split-col2"),
    splitCol3: () => document.getElementById("split-col3"),
    splitCol1Subtitle: () => document.getElementById("split-col1-subtitle"),
    splitCol2Subtitle: () => document.getElementById("split-col2-subtitle"),
    splitCol3Subtitle: () => document.getElementById("split-col3-subtitle"),
    splitGroupsPanel: () => document.getElementById("split-groups-panel"),
    splitTreeSvg: () => document.getElementById("split-tree-svg"),
    splitTreeScroll: () => document.getElementById("split-tree-scroll"),
    splitRunInlineBtn: () => document.getElementById("split-run-dea-inline"),
    splitLevel1Column: () => document.getElementById("split-level-1-column"),
    splitLevel2Column: () => document.getElementById("split-level-2-column"),
    splitLevel3Column: () => document.getElementById("split-level-3-column"),
    splitSwap12: () => document.getElementById("split-swap-1-2"),
    splitSwap23: () => document.getElementById("split-swap-2-3"),
    pairedMode: () => document.getElementById("paired-mode"),
    pairIdCol: () => document.getElementById("pair-id-col"),
    normalityInfo: () => document.getElementById("normality-info"),
    runBtn: () => document.getElementById("btn-run-analysis"),
    runStatus: () => document.getElementById("run-analysis-status"),
    testType: () => document.getElementById("test-type"),
    sortFilter: () => document.getElementById("res-sort-filter"),
    minFilter: () => document.getElementById("res-min-filter"),
    searchInput: () => document.getElementById("res-search"),
    fcThresholdInput: () => document.getElementById("res-fc-threshold"),
    rowCount: () => document.getElementById("res-row-count"),
    csvBtn: () => document.getElementById("btn-dl-csv"),
    resultsContainer: () => document.getElementById("results-container"),
    resultTabOverview: () => document.getElementById("result-tab-overview"),
    resultTabEnrichment: () => document.getElementById("result-tab-enrichment"),
    resultTabNetwork: () => document.getElementById("result-tab-network"),
    overviewPanel: () => document.getElementById("overview-panel"),
    enrichmentPanel: () => document.getElementById("enrichment-panel"),
    networkPanel: () => document.getElementById("network-panel"),
    analysisCompareChip: () => document.getElementById("analysis-compare-chip"),
    enrichmentCurrentComparison: () => document.getElementById("enrichment-current-comparison"),
    enrichmentCurrentAnalysis: () => document.getElementById("enrichment-current-analysis"),
    enrichmentHistorySearch: () => document.getElementById("enrichment-history-search"),
    enrichmentHistoryList: () => document.getElementById("enrichment-history-list"),
    openEnrichmentModalBtn: () => document.getElementById("btn-open-enrichment-modal"),
    enrichmentModalEl: () => document.getElementById("run-enrichment-modal"),
    enrichmentMoleculeType: () => document.getElementById("enrichment-molecule-type"),
    enrichmentDbCol: () => document.getElementById("enrichment-db-col"),
    enrichmentCharCol: () => document.getElementById("enrichment-char-col"),
    enrichmentCharButton: () => document.getElementById("enrichment-char-button"),
    enrichmentCharMenu: () => document.getElementById("enrichment-char-menu"),
    enrichmentMappingNote: () => document.getElementById("enrichment-mapping-note"),
    enrichmentName: () => document.getElementById("enrichment-name"),
    enrichmentDbButton: () => document.getElementById("enrichment-db-button"),
    enrichmentDbMenu: () => document.getElementById("enrichment-db-menu"),
    enrichmentInputTypeCol: () => document.getElementById("enrichment-input-type-col"),
    enrichmentInputType: () => document.getElementById("enrichment-input-type"),
    enrichmentMethod: () => document.getElementById("enrichment-method"),
    enrichmentFeatureSourceCol: () => document.getElementById("enrichment-feature-source-col"),
    enrichmentFeatureSource: () => document.getElementById("enrichment-feature-source"),
    enrichmentRankingMetricRow: () => document.getElementById("enrichment-ranking-metric-row"),
    enrichmentRankingPreviewSection: () => document.getElementById("enrichment-ranking-preview-section"),
    enrichmentOraPreviewSection: () => document.getElementById("enrichment-ora-preview-section"),
    enrichmentOraFeatureBody: () => document.getElementById("enrichment-ora-feature-body"),
    enrichmentRankingMetric: () => document.getElementById("enrichment-ranking-metric"),
    enrichmentModalSource: () => document.getElementById("enrichment-modal-source"),
    enrichmentRankBody: () => document.getElementById("enrichment-rank-body"),
    runEnrichmentBtn: () => document.getElementById("btn-run-enrichment"),
    enrichmentInlineView: () => document.getElementById("enrichment-inline-view"),
    enrichmentInlineFrame: () => document.getElementById("enrichment-inline-frame"),
    enrichmentInlineTitle: () => document.getElementById("enrichment-inline-title"),
    enrichmentInlineLoading: () => document.getElementById("enrichment-inline-loading"),
    enrichmentBackBtn: () => document.getElementById("btn-enrichment-back"),
    networkCurrentComparison: () => document.getElementById("network-current-comparison"),
    networkCurrentAnalysis: () => document.getElementById("network-current-analysis"),
    networkHistorySearch: () => document.getElementById("network-history-search"),
    networkHistoryList: () => document.getElementById("network-history-list"),
    openNetworkModalBtn: () => document.getElementById("btn-open-network-modal"),
    networkModalEl: () => document.getElementById("run-network-modal"),
    networkType: () => document.getElementById("network-type"),
    networkOrganism: () => document.getElementById("network-organism"),
    networkRefGroup: () => document.getElementById("network-ref-group"),
    networkName: () => document.getElementById("network-name"),
    networkNLipidCol: () => document.getElementById("network-n-lipid-col"),
    networkNLipid: () => document.getElementById("network-n-lipid"),
    networkPCutoff: () => document.getElementById("network-p-cutoff"),
    networkFcCutoff: () => document.getElementById("network-fc-cutoff"),
    networkModalSource: () => document.getElementById("network-modal-source"),
    networkModalError: () => document.getElementById("network-modal-error"),
    runNetworkBtn: () => document.getElementById("btn-run-network"),
    sidebarPlaceholder: () => document.getElementById("sidebar-placeholder"),
    tableBody: () => document.querySelector("#res-table tbody"),
    volcano: () => document.getElementById("volcano-plot"),
    violinGrid: () => document.getElementById("violin-grid")
};

async function ensureSplitEngineMounted() {
    if (splitEngine) return splitEngine;
    splitEngine = await createSplitMetaEngine({
        mode: "ttest",
        configHost: dom.splitConfigSection(),
        workspaceHost: dom.splitWorkspace(),
        minGroups: 2,
        maxGroups: 2,
        defaultGroupNames: ["group1", "group2"],
        comparisonSeparator: " vs ",
        getEligibleColumns: () => getSplitEligibleColumns(),
        visible: false,
        onChange: () => {
            validateForm();
        },
    });
    return splitEngine;
}

async function syncSplitEngineMetadata(metaPathOverride = null) {
    const engine = await ensureSplitEngineMounted();
    await ensureViolinSourceLoaded(metaPathOverride);
    engine.setMetadata({
        metaHeader: violinSourceCache.metaHeader,
        sampleToMeta: violinSourceCache.sampleToMeta,
    });
    populateTargetMeta();
    if (dom.target().value) renderComparisonPairs();
}

let resizeTimeout;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (uniResultsGlobal.length > 0) renderVolcanoPlot(uniResultsGlobal);
        document.querySelectorAll(".violin-plot").forEach((el) => {
            if (window.Plotly && el?.data) Plotly.Plots.resize(el);
        });
        if (splitWorkspaceVisible && splitEngine) splitEngine.render();
    }, 180);
});

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) return;
    await injectSidebar(user.uid);
    await initUnivariateSetup();
    document.body.classList.add("loaded");
});

function setRunStatus(message = "", isError = false) {
    const status = dom.runStatus();
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
}

function setRunBusy(isBusy, message = "", isError = false) {
    setRunStatus(message, isError);
    if (dom.splitRunInlineBtn()) dom.splitRunInlineBtn().disabled = Boolean(isBusy) || isRunCoolingDown();
    if (!isBusy && !isRunCoolingDown()) {
        dom.runBtn().innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN ANALYSIS';
    }
}

function isRunCoolingDown() {
    return Date.now() < runCooldownUntil;
}

function getCooldownSecondsRemaining() {
    return Math.max(1, Math.ceil((runCooldownUntil - Date.now()) / 1000));
}

function refreshRunCooldownUi() {
    if (isRunCoolingDown()) {
        dom.runBtn().disabled = true;
        dom.runBtn().innerHTML = `<i class="fa-solid fa-hourglass-half me-2"></i>Wait ${getCooldownSecondsRemaining()}s`;
        if (dom.splitRunInlineBtn()) dom.splitRunInlineBtn().disabled = true;
        return;
    }

    runCooldownUntil = 0;
    dom.runBtn().innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN ANALYSIS';
    validateForm();
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

function getMetaDescriptorByName(columnName) {
    return (projectData?.meta_metadata || []).find((item) => item?.name === columnName) || null;
}

function normalizeGroupValue(value) {
    const text = String(value ?? "").trim();
    if (!text || text.toLowerCase() === "nan") return "";
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return String(numeric);
    return text;
}

function getCleanMetaGroupValues(meta) {
    return [...new Set((meta?.groups || [])
        .map((value) => normalizeGroupValue(value))
        .filter(Boolean))];
}

function getMetaGroupCountValues(meta) {
    if (!meta?.group_counts || typeof meta.group_counts !== "object") return [];
    return [...new Set(Object.keys(meta.group_counts)
        .map((value) => normalizeGroupValue(value))
        .filter(Boolean))];
}

function getObservedGroupCounts(columnName, sampleToMeta = violinSourceCache.sampleToMeta) {
    const counts = new Map();
    if (!(sampleToMeta instanceof Map) || !columnName) return counts;
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
    });
    return counts;
}

function getDistinctMetaValues(columnName, sampleToMeta = violinSourceCache.sampleToMeta) {
    if (!(sampleToMeta instanceof Map) || !columnName) return [];
    const values = new Set();
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        values.add(value);
    });
    return [...values];
}

function getEligibleGroupedMetaColumns(minGroups = 2) {
    const orderedNames = sortMetadataLabels(Array.isArray(violinSourceCache.metaHeader) && violinSourceCache.metaHeader.length
        ? violinSourceCache.metaHeader
        : (projectData?.meta_metadata || []).map((item) => item?.name).filter(Boolean));

    return orderedNames
        .map((name) => {
            const meta = getMetaDescriptorByName(name);
            const distinctValues = getDistinctMetaValues(name);
            const groups = getCleanMetaGroupValues(meta).length ? getCleanMetaGroupValues(meta) : distinctValues;
            return {
                ...(meta || {}),
                name,
                groups,
            };
        })
        .filter((item) => item.name && item.groups.length >= minGroups);
}

function getComparisonGroupValues(columnName) {
    const meta = getMetaDescriptorByName(columnName);
    const configuredGroups = getCleanMetaGroupValues(meta);
    if (configuredGroups.length >= 2) return configuredGroups;
    const countedGroups = getMetaGroupCountValues(meta);
    if (countedGroups.length >= 2) return countedGroups;
    return getDistinctMetaValues(columnName);
}

function getComparisonGroupEntries(columnName) {
    const labels = getComparisonGroupValues(columnName);
    const observedCounts = getObservedGroupCounts(columnName);
    const meta = getMetaDescriptorByName(columnName);
    const fallbackCounts = meta?.group_counts && typeof meta.group_counts === "object"
        ? new Map(Object.entries(meta.group_counts).map(([label, count]) => [normalizeGroupValue(label), Number(count) || 0]))
        : new Map();
    return labels.map((label) => ({
        label,
        count: observedCounts.get(normalizeGroupValue(label)) ?? fallbackCounts.get(normalizeGroupValue(label)) ?? 0,
    }));
}

function sanitizeBackendToken(value, fallback = "Value") {
    const normalized = String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9.]+/g, "")
        .replace(/^\.+|\.+$/g, "");
    return normalized || fallback;
}

function buildUniqueEncodedValueMap(labels = []) {
    const used = new Set();
    const encoded = new Map();
    labels.forEach((label, index) => {
        const base = sanitizeBackendToken(label, `Group${index + 1}`);
        let candidate = base;
        let suffix = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = `${base}${suffix}`;
            suffix += 1;
        }
        used.add(candidate.toLowerCase());
        encoded.set(label, candidate);
    });
    return encoded;
}

function getSplitEligibleColumns() {
    return getEligibleGroupedMetaColumns(1);
}

function cloneSplitState() {
    return {
        mode: splitState.mode,
        activeGroup: splitState.activeGroup,
        groupNames: { ...splitState.groupNames },
        levelConfigs: splitState.levelConfigs.map((level) => ({ column: level.column || "" })),
        selectedNodes: {
            group1: [...splitState.selectedNodes.group1],
            group2: [...splitState.selectedNodes.group2],
        },
        selectedBranchKeys: {
            group1: [...splitSelectedBranchKeys.group1],
            group2: [...splitSelectedBranchKeys.group2],
        },
    };
}

function createDefaultSplitSnapshot() {
    return {
        mode: "split",
        activeGroup: "group1",
        groupNames: { group1: "group1", group2: "group2" },
        levelConfigs: Array.from({ length: MAX_SPLIT_LEVELS }, () => DEFAULT_SPLIT_LEVEL()),
        selectedNodes: { group1: [], group2: [] },
        selectedBranchKeys: { group1: [], group2: [] },
    };
}

function resetSplitBuilderState() {
    const nextState = createDefaultSplitSnapshot();
    splitState.activeGroup = nextState.activeGroup;
    splitState.groupNames = nextState.groupNames;
    splitState.levelConfigs = nextState.levelConfigs;
    splitState.selectedNodes = nextState.selectedNodes;
    splitSelectedBranchKeys = nextState.selectedBranchKeys;
}

function applySplitSnapshot(snapshot) {
    const nextState = snapshot || createDefaultSplitSnapshot();
    splitState.activeGroup = nextState.activeGroup || "group1";
    splitState.groupNames = { ...nextState.groupNames };
    splitState.levelConfigs = nextState.levelConfigs.map((level) => ({ column: level.column || "" }));
    splitState.selectedNodes = {
        group1: [...(nextState.selectedNodes?.group1 || [])],
        group2: [...(nextState.selectedNodes?.group2 || [])],
    };
    splitSelectedBranchKeys = {
        group1: [...(nextState.selectedBranchKeys?.group1 || [])],
        group2: [...(nextState.selectedBranchKeys?.group2 || [])],
    };
}

function hydrateSplitStateFromConfig(splitConfig) {
    const nextState = createDefaultSplitSnapshot();
    if (!splitConfig || typeof splitConfig !== "object") return nextState;

    nextState.groupNames.group1 = splitConfig.group1_name || nextState.groupNames.group1;
    nextState.groupNames.group2 = splitConfig.group2_name || nextState.groupNames.group2;

    if (Array.isArray(splitConfig.levelConfigs)) {
        nextState.levelConfigs = Array.from({ length: MAX_SPLIT_LEVELS }, (_, index) => {
            const level = splitConfig.levelConfigs[index] || {};
            return {
                column: level.column || "",
            };
        });
    } else if (splitConfig.groups) {
        const legacyGroup1Levels = splitConfig.groups?.group1?.levels || [];
        const legacyGroup2Levels = splitConfig.groups?.group2?.levels || [];
        nextState.levelConfigs = Array.from({ length: MAX_SPLIT_LEVELS }, (_, index) => {
            const left = legacyGroup1Levels[index] || {};
            const right = legacyGroup2Levels[index] || {};
            return {
                column: left.column || right.column || "",
            };
        });
    }

    if (splitConfig.selectedNodes && typeof splitConfig.selectedNodes === "object") {
        nextState.selectedNodes = {
            group1: Array.isArray(splitConfig.selectedNodes.group1) ? [...splitConfig.selectedNodes.group1] : [],
            group2: Array.isArray(splitConfig.selectedNodes.group2) ? [...splitConfig.selectedNodes.group2] : [],
        };
    }

    if (splitConfig.selectedBranchKeys && typeof splitConfig.selectedBranchKeys === "object") {
        nextState.selectedBranchKeys = {
            group1: Array.isArray(splitConfig.selectedBranchKeys.group1) ? [...splitConfig.selectedBranchKeys.group1] : [],
            group2: Array.isArray(splitConfig.selectedBranchKeys.group2) ? [...splitConfig.selectedBranchKeys.group2] : [],
        };
    } else {
        const looksLikeBranchKey = (value) => typeof value === "string" && value.includes("__L");
        nextState.selectedBranchKeys = {
            group1: nextState.selectedNodes.group1.filter(looksLikeBranchKey),
            group2: nextState.selectedNodes.group2.filter(looksLikeBranchKey),
        };
        if (nextState.selectedBranchKeys.group1.length || nextState.selectedBranchKeys.group2.length) {
            nextState.selectedNodes = { group1: [], group2: [] };
        }
    }

    return nextState;
}

function getSplitGroupName(groupKey) {
    const fallback = groupKey === "group1" ? "group1" : "group2";
    const raw = String(splitState.groupNames[groupKey] || fallback).trim().replace(/\s+/g, " ");
    const cleaned = raw.replace(/\s+vs\s+/gi, " - ");
    return cleaned || fallback;
}

function getActiveSplitGroup() {
    return splitState.activeGroup === "group2" ? "group2" : "group1";
}

function getSplitLevelConfig(levelIndex) {
    return splitState.levelConfigs[levelIndex] || DEFAULT_SPLIT_LEVEL();
}

function getSplitSelectedNodeKeySet(groupKey) {
    return new Set(splitSelectedBranchKeys[groupKey] || []);
}

function getSplitSelectedSampleIds(groupKey) {
    return [...new Set(splitState.selectedNodes[groupKey] || [])];
}

function buildSplitNodeKey(parentKey, levelIndex, value) {
    return `${parentKey}__L${levelIndex + 1}__${value}`;
}

function getSplitHierarchyData() {
    splitNodeRegistry = new Map();
    const rows = [...violinSourceCache.sampleToMeta.entries()].map(([sampleId, meta]) => ({ sampleId, meta }));
    const totalSamples = rows.length;
    const columns = [];
    let parentNodes = [{ key: "root", label: "All", sampleIds: rows.map((row) => row.sampleId), count: totalSamples }];

    for (let levelIndex = 0; levelIndex < MAX_SPLIT_LEVELS; levelIndex += 1) {
        const config = getSplitLevelConfig(levelIndex);
        if (!config.column) {
            columns.push({ levelIndex, column: "", nodes: [] });
            parentNodes = [];
            continue;
        }

        const levelNodes = [];
        const nextParents = [];
        parentNodes.forEach((parentNode) => {
            const counts = new Map();
            parentNode.sampleIds.forEach((sampleId) => {
                const meta = violinSourceCache.sampleToMeta.get(sampleId) || {};
                const value = String(meta[config.column] ?? "").trim();
                if (!value || value.toLowerCase() === "nan") return;
                if (!counts.has(value)) counts.set(value, []);
                counts.get(value).push(sampleId);
            });

            const visibleNodes = [...counts.entries()]
                .sort((left, right) => {
                    // A-Z letters first, then numbers, NaN always last
                    const la = String(left[0] || ""), ra = String(right[0] || "");
                    const lNan = la.toLowerCase() === "nan", rNan = ra.toLowerCase() === "nan";
                    if (lNan !== rNan) return lNan ? 1 : -1;
                    const lNum = Number.isFinite(Number(la)), rNum = Number.isFinite(Number(ra));
                    if (lNum !== rNum) return lNum ? 1 : -1; // letters before numbers
                    return la.localeCompare(ra, undefined, { numeric: true, sensitivity: "base" });
                })
                .map(([value, sampleIds]) => {
                    const key = buildSplitNodeKey(parentNode.key, levelIndex, value);
                    const node = {
                        key,
                        label: value,
                        sampleIds,
                        count: sampleIds.length,
                        percentBase: levelIndex === 0 ? totalSamples : parentNode.count,
                        parentLabel: parentNode.label,
                        parentKey: parentNode.key,
                        levelIndex,
                        column: config.column,
                        childKeys: [],
                    };
                    splitNodeRegistry.set(key, node);
                    return node;
                });

            visibleNodes.forEach((node) => {
                const parentRegistryNode = splitNodeRegistry.get(parentNode.key);
                if (parentRegistryNode) parentRegistryNode.childKeys.push(node.key);
                levelNodes.push(node);
                nextParents.push(node);
            });
        });

        columns.push({ levelIndex, column: config.column, nodes: levelNodes });
        parentNodes = nextParents;
    }

    return columns;
}

function pruneSplitSelections() {
    ["group1", "group2"].forEach((groupKey) => {
        splitSelectedBranchKeys[groupKey] = (splitSelectedBranchKeys[groupKey] || []).filter((nodeKey) => splitNodeRegistry.has(nodeKey));
    });
    const hasExplicitBranches = splitSelectedBranchKeys.group1.length || splitSelectedBranchKeys.group2.length;
    const hasSampleSelections = splitState.selectedNodes.group1.length || splitState.selectedNodes.group2.length;
    if (hasExplicitBranches || !hasSampleSelections) syncSplitSelectedSamplesFromBranches();
}

function syncSplitSelectedSamplesFromBranches() {
    ["group1", "group2"].forEach((groupKey) => {
        const sampleIds = new Set();
        (splitSelectedBranchKeys[groupKey] || []).forEach((nodeKey) => {
            const node = splitNodeRegistry.get(nodeKey);
            (node?.sampleIds || []).forEach((sampleId) => sampleIds.add(sampleId));
        });
        splitState.selectedNodes[groupKey] = [...sampleIds];
    });
}

function getNodeAncestorKeys(nodeKey) {
    const ancestors = [];
    let cursor = splitNodeRegistry.get(nodeKey)?.parentKey;
    while (cursor && cursor !== "root") {
        ancestors.push(cursor);
        cursor = splitNodeRegistry.get(cursor)?.parentKey;
    }
    return ancestors;
}

function isNodeCoveredByGroup(groupKey, nodeKey) {
    const explicitKeys = getSplitSelectedNodeKeySet(groupKey);
    if (explicitKeys.has(nodeKey)) return true;
    if (getNodeAncestorKeys(nodeKey).some((ancestorKey) => explicitKeys.has(ancestorKey))) return true;
    if (explicitKeys.size) return false;
    const node = splitNodeRegistry.get(nodeKey);
    if (!node?.sampleIds?.length) return false;
    const selectedSamples = new Set(splitState.selectedNodes[groupKey] || []);
    return node.sampleIds.every((sampleId) => selectedSamples.has(sampleId));
}

function hasNodeOverlap(nodeKey) {
    const node = splitNodeRegistry.get(nodeKey);
    if (!node) return false;
    const group1Samples = new Set(splitState.selectedNodes.group1 || []);
    const group2Samples = new Set(splitState.selectedNodes.group2 || []);
    for (const sampleId of node.sampleIds || []) {
        if (group1Samples.has(sampleId) && group2Samples.has(sampleId)) return true;
    }
    return false;
}

function toggleSplitBranchSelection(groupKey, nodeKey) {
    const explicitKeys = getSplitSelectedNodeKeySet(groupKey);
    if (explicitKeys.has(nodeKey)) {
        splitSelectedBranchKeys[groupKey] = splitSelectedBranchKeys[groupKey].filter((key) => key !== nodeKey);
        syncSplitSelectedSamplesFromBranches();
        return;
    }

    const ancestorKeys = new Set(getNodeAncestorKeys(nodeKey));
    splitSelectedBranchKeys[groupKey] = (splitSelectedBranchKeys[groupKey] || []).filter((key) => !ancestorKeys.has(key) && key !== nodeKey);
    splitSelectedBranchKeys[groupKey] = [...splitSelectedBranchKeys[groupKey], nodeKey];
    syncSplitSelectedSamplesFromBranches();
}

function getSplitSummaryState() {
    const group1Name = getSplitGroupName("group1");
    const group2Name = getSplitGroupName("group2");
    const group1Samples = getSplitSelectedSampleIds("group1");
    const group2Samples = getSplitSelectedSampleIds("group2");
    const group2Set = new Set(group2Samples);
    const overlap = group1Samples.filter((sampleId) => group2Set.has(sampleId));
    const configuredColumns = splitState.levelConfigs.map((level) => level.column).filter(Boolean);
    const displayTarget = configuredColumns.length ? `Split: ${configuredColumns.join(" > ")}` : "Split";

    let error = "";
    if (!group1Samples.length || !group2Samples.length) {
        error = "Each group must include at least one selected node.";
    } else if (overlap.length) {
        error = `Groups overlap on ${overlap.length} sample(s). A node can belong to only one DEA group.`;
    } else if (group1Name === group2Name) {
        error = "Group names must be different.";
    }

    return {
        group1Name,
        group2Name,
        group1Samples,
        group2Samples,
        overlap,
        displayTarget,
        comparison: `${group1Name} vs ${group2Name}`,
        isValid: !error,
        error,
        unassignedCount: Math.max(0, violinSourceCache.sampleToMeta.size - new Set([...group1Samples, ...group2Samples]).size),
    };
}

function renderSplitSummary() {
    const container = dom.splitSummary();
    if (!container) return;
    if (!violinSourceCache.sampleToMeta.size) {
        container.innerHTML = '<div class="split-summary-line">Split summary will appear after metadata is loaded.</div>';
        return;
    }
    const summary = getSplitSummaryState();
    container.innerHTML = [
        `<div class="split-summary-line"><strong>${summary.group1Name}:</strong> ${summary.group1Samples.length} samples</div>`,
        `<div class="split-summary-line"><strong>${summary.group2Name}:</strong> ${summary.group2Samples.length} samples</div>`,
        `<div class="split-summary-line"><strong>Unassigned:</strong> ${summary.unassignedCount} samples</div>`,
        `<div class="split-summary-line"><strong>DEA target label:</strong> ${summary.displayTarget}</div>`,
        summary.error ? `<div class="split-summary-line error">${summary.error}</div>` : '<div class="split-summary-line"><strong>Status:</strong> Ready to run with derived groups.</div>'
    ].join("");
}

function populateSplitLevelSelectors() {
    const eligibleColumns = getSplitEligibleColumns();
    [dom.splitLevel1Column(), dom.splitLevel2Column(), dom.splitLevel3Column()].forEach((select, index) => {
        if (!select) return;
        const current = getSplitLevelConfig(index).column;
        select.innerHTML = '<option value="">-- Select metadata --</option>' + eligibleColumns.map((item) => `<option value="${item.name}" ${item.name === current ? "selected" : ""}>${item.name}</option>`).join("");
    });
}

function renderSplitConfigurator() {
    if (dom.splitGroup1Name()) dom.splitGroup1Name().value = splitState.groupNames.group1;
    if (dom.splitGroup2Name()) dom.splitGroup2Name().value = splitState.groupNames.group2;
    dom.splitTabGroup1()?.classList.toggle("active", getActiveSplitGroup() === "group1");
    dom.splitTabGroup2()?.classList.toggle("active", getActiveSplitGroup() === "group2");
    populateSplitLevelSelectors();
    renderSplitSummary();
    renderSplitWorkspace();
}

function formatSplitCount(count, denominator) {
    const percent = denominator > 0 ? ((count / denominator) * 100).toFixed(2) : "0.00";
    return `${count} samples - ${percent}%`;
}

function buildSplitVisualLayout(columns) {
    const configured = columns.filter((column) => column.column && column.nodes.length);
    const nodeHeight = 56;
    const rowGap = 10;
    const stagePadding = 8;
    const centerStep = nodeHeight + rowGap;
    const deepestColumn = configured.at(-1) || null;

    if (deepestColumn) {
        deepestColumn.nodes.forEach((node, index) => {
            node.centerY = stagePadding + (index * centerStep) + (nodeHeight / 2);
        });
    }

    for (let index = configured.length - 2; index >= 0; index -= 1) {
        const column = configured[index];
        let fallbackCursor = stagePadding + (nodeHeight / 2);
        column.nodes.forEach((node) => {
            const childCenters = (node.childKeys || [])
                .map((childKey) => splitNodeRegistry.get(childKey)?.centerY)
                .filter((value) => Number.isFinite(value));
            if (childCenters.length) {
                node.centerY = (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
            } else {
                node.centerY = fallbackCursor;
                fallbackCursor += centerStep;
            }
        });
    }

    const allNodes = columns.flatMap((column) => column.nodes || []);
    const maxCenter = allNodes.length ? Math.max(...allNodes.map((node) => node.centerY || (stagePadding + (nodeHeight / 2)))) : (stagePadding + (nodeHeight / 2));
    const stageHeight = Math.max(260, maxCenter + (nodeHeight / 2) + stagePadding);

    columns.forEach((column) => {
        (column.nodes || []).forEach((node, index) => {
            if (!Number.isFinite(node.centerY)) {
                node.centerY = stagePadding + (index * centerStep) + (nodeHeight / 2);
            }
            node.top = Math.max(0, node.centerY - (nodeHeight / 2));
            node.height = nodeHeight;
        });
        column.stageHeight = stageHeight;
    });

    return { columns, stageHeight };
}

function renderSplitColumn(container, subtitleEl, columnData, levelIndex) {
    if (!container || !subtitleEl) return;
    subtitleEl.textContent = columnData.column || "No column";
    if (!columnData.column) {
        container.innerHTML = '<div class="split-empty">Select a metadata column in this level to preview the branch hierarchy.</div>';
        return;
    }
    if (!columnData.nodes.length) {
        container.innerHTML = '<div class="split-empty">No matching branch is available for this level yet.</div>';
        return;
    }

    container.innerHTML = `<div class="split-level-stage" style="height:${columnData.stageHeight || 260}px;">${columnData.nodes.map((item) => {
        const group1Selected = isNodeCoveredByGroup("group1", item.key);
        const group2Selected = isNodeCoveredByGroup("group2", item.key);
        const overlap = hasNodeOverlap(item.key);
        const activeClass = overlap ? "overlap" : group1Selected ? "selected group1-selected" : group2Selected ? "selected group2-selected" : "";
        const badges = [
            group1Selected ? `<span class="split-node-badge group1">${getSplitGroupName("group1")}</span>` : "",
            group2Selected ? `<span class="split-node-badge group2">${getSplitGroupName("group2")}</span>` : "",
            overlap ? '<span class="split-node-badge overlap">Overlap</span>' : "",
        ].filter(Boolean).join("");
        return `
            <div class="split-node-card positioned clickable ${activeClass}" style="top:${item.top || 0}px; min-height:${item.height || 108}px;" data-node-key="${item.key}" data-parent-key="${item.parentKey || ""}" data-level-index="${levelIndex}">
                <div class="split-node-header">
                    <div>
                        <div class="split-node-name">${item.label}</div>
                        <div class="split-node-parent">${levelIndex === 0 ? "All samples" : item.parentLabel || "Inherited branch"}</div>
                    </div>
                    <div class="split-node-meta">${item.count}</div>
                </div>
                <div class="split-node-bar"><span style="width:${item.percentBase > 0 ? Math.max(2, (item.count / item.percentBase) * 100) : 0}%"></span></div>
                <div class="split-node-meta">${formatSplitCount(item.count, item.percentBase)}</div>
                ${badges ? `<div class="split-node-badge-row">${badges}</div>` : ""}
            </div>
        `;
    }).join("")}</div>`;

    container.querySelectorAll(".split-node-card").forEach((node) => {
        node.addEventListener("click", () => {
            const nodeKey = node.dataset.nodeKey;
            const activeGroup = getActiveSplitGroup();
            toggleSplitBranchSelection(activeGroup, nodeKey);
            renderSplitSummary();
            renderSplitWorkspace();
            validateForm();
        });
    });
}

function renderSplitGroupsPanel() {
    const panel = dom.splitGroupsPanel();
    if (!panel) return;
    if (!violinSourceCache.sampleToMeta.size) {
        panel.innerHTML = '<div class="split-empty">Metadata preview is not available yet.</div>';
        return;
    }
    const summary = getSplitSummaryState();
    const activeGroup = getActiveSplitGroup();
    panel.innerHTML = ["group1", "group2"].map((groupKey) => {
        const sampleIds = groupKey === "group1" ? summary.group1Samples : summary.group2Samples;
        const groupName = groupKey === "group1" ? summary.group1Name : summary.group2Name;
        return `
            <div class="split-group-summary-card ${activeGroup === groupKey ? "active" : ""}" data-group-key="${groupKey}" style="cursor:pointer;">
                <h6>${groupName}</h6>
                <div class="split-node-bar mb-2"><span style="width:${violinSourceCache.sampleToMeta.size ? Math.max(2, (sampleIds.length / violinSourceCache.sampleToMeta.size) * 100) : 0}%"></span></div>
                <div class="split-group-config-line"><strong>${sampleIds.length}</strong> / ${violinSourceCache.sampleToMeta.size} samples</div>
                <div class="split-group-config-line">${(splitSelectedBranchKeys[groupKey] || []).length} selected branch(es)</div>
                ${splitState.levelConfigs.filter((level) => level.column).length ? splitState.levelConfigs.filter((level) => level.column).map((level, index) => `<div class="split-group-config-line">L${index + 1}: ${level.column}</div>`).join("") : '<div class="split-group-config-line">No level configured yet.</div>'}
            </div>
        `;
    }).join("") + `<div class="split-group-summary-footer split-summary-line ${summary.error ? "error" : ""}">${summary.error || `Ready: ${summary.comparison}`}</div>`;

    panel.querySelectorAll(".split-group-summary-card").forEach((node) => {
        node.addEventListener("click", () => {
            splitState.activeGroup = node.dataset.groupKey === "group2" ? "group2" : "group1";
            renderSplitConfigurator();
        });
    });
}

function drawSplitConnectors() {
    const svg = dom.splitTreeSvg();
    const scrollStage = dom.splitTreeScroll();
    if (!svg || !scrollStage || splitState.mode !== "split" || !splitWorkspaceVisible) return;

    const stageRect = svg.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, stageRect.width)} ${Math.max(1, stageRect.height)}`);

    const connectors = [];
    [dom.splitCol2(), dom.splitCol3()].forEach((column) => {
        column?.querySelectorAll(".split-node-card[data-parent-key]").forEach((childNode) => {
            const parentKey = childNode.dataset.parentKey;
            if (!parentKey || parentKey === "root") return;
            const parentNode = scrollStage.querySelector(`.split-node-card[data-node-key="${CSS.escape(parentKey)}"]`);
            if (!parentNode) return;
            const parentRect = parentNode.getBoundingClientRect();
            const childRect = childNode.getBoundingClientRect();
            const startX = parentRect.right - stageRect.left;
            const startY = parentRect.top + parentRect.height / 2 - stageRect.top;
            const endX = childRect.left - stageRect.left;
            const endY = childRect.top + childRect.height / 2 - stageRect.top;
            const deltaX = Math.max(28, (endX - startX) * 0.45);
            connectors.push(`<path class="split-connector-path" d="M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}" />`);
        });
    });

    svg.innerHTML = connectors.join("");
}

function renderSplitWorkspace() {
    if (!dom.splitWorkspace()) return;
    if (!splitWorkspaceVisible || splitState.mode !== "split") {
        dom.splitWorkspace().classList.add("d-none");
        return;
    }
    dom.splitWorkspace().classList.remove("d-none");
    const activeGroup = getActiveSplitGroup();
    const statusEl = dom.splitWorkspaceStatus();
    if (statusEl) {
        const summary = getSplitSummaryState();
        statusEl.textContent = summary.overlap.length ? `Overlap detected: ${summary.overlap.length} sample(s)` : `Assigning nodes to ${getSplitGroupName(activeGroup)}`;
    }

    if (!violinSourceCache.sampleToMeta.size) {
        [dom.splitCol1(), dom.splitCol2(), dom.splitCol3()].forEach((node) => {
            if (node) node.innerHTML = '<div class="split-empty">Metadata preview is not loaded yet.</div>';
        });
        if (dom.splitTreeSvg()) dom.splitTreeSvg().innerHTML = "";
        return;
    }

    const layout = buildSplitVisualLayout(getSplitHierarchyData());
    const columns = layout.columns;
    pruneSplitSelections();
    renderSplitColumn(dom.splitCol1(), dom.splitCol1Subtitle(), columns[0] || { column: "", nodes: [] }, 0);
    renderSplitColumn(dom.splitCol2(), dom.splitCol2Subtitle(), columns[1] || { column: "", nodes: [] }, 1);
    renderSplitColumn(dom.splitCol3(), dom.splitCol3Subtitle(), columns[2] || { column: "", nodes: [] }, 2);
    renderSplitGroupsPanel();
    if (dom.splitTreeSvg()) dom.splitTreeSvg().style.height = `${layout.stageHeight || 260}px`;
    window.requestAnimationFrame(() => drawSplitConnectors());
}

function setSplitWorkspaceVisible(visible) {
    splitWorkspaceVisible = Boolean(visible);
    if (splitWorkspaceVisible) {
        dom.resultsContainer()?.classList.add("d-none");
    } else if (uniResultsGlobal.length > 0) {
        dom.resultsContainer()?.classList.remove("d-none");
    }
    splitEngine?.setVisible(splitWorkspaceVisible && splitState.mode === "split");
}

function setConfigMode(mode) {
    splitState.mode = mode === "split" ? "split" : "manual";
    dom.configModeManual()?.classList.toggle("active", splitState.mode === "manual");
    dom.configModeSplit()?.classList.toggle("active", splitState.mode === "split");
    dom.manualConfigSection()?.classList.toggle("d-none", splitState.mode !== "manual");
    dom.splitConfigSection()?.classList.toggle("d-none", splitState.mode !== "split");
    setSplitWorkspaceVisible(splitState.mode === "split");
    if (splitState.mode === "split") {
        if (pendingSplitHistorySnapshot && splitEngine) {
            splitEngine.applySnapshot(pendingSplitHistorySnapshot);
            pendingSplitHistorySnapshot = null;
        }
        splitEngine?.render();
    }
    validateForm();
}

function escapeCsvValue(value) {
    const text = String(value ?? "");
    if (!/[",\n\r]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function getAnalysisDisplayTarget(analysis) {
    return analysis?.display_target || analysis?.target || null;
}

function getAnalysisDisplayComparison(analysis) {
    return analysis?.display_comparison || analysis?.comparison || null;
}

function decorateAnalysisEntry(entry) {
    if (!entry?.run_id) return entry;
    const context = splitRunContext.get(entry.run_id);
    if (!context) return entry;
    const { persisted: _persisted, ...publicContext } = context;
    return { ...entry, ...publicContext };
}

async function buildSplitMetaSource() {
    await syncSplitEngineMetadata();
    if (!splitEngine) {
        throw new Error("Split engine is not ready.");
    }
    const derived = splitEngine.buildDerivedMetaCsv({ columnPrefix: "__ttest_split" });

    const metaPathOverride = `projects/${auth.currentUser.uid}/${projectId}/univariate_results/ttest_split_meta_${Date.now()}.csv`;
    await uploadString(ref(storage, metaPathOverride), derived.csvText, "raw", { contentType: "text/csv" });

    return {
        target: derived.targetColumn,
        comparison: derived.comparison,
        metaPathOverride,
        displayTarget: derived.displayTarget,
        displayComparison: derived.comparison,
        splitConfig: derived.splitConfig,
    };
}

async function buildManualMetaSource(targetColumn, comparison) {
    await ensureViolinSourceLoaded();
    if (!violinSourceCache.metaHeader.includes(targetColumn)) {
        throw new Error(`Target metadata '${targetColumn}' not found in parsed metadata.`);
    }

    const groupEntries = getComparisonGroupEntries(targetColumn);
    const selectedGroups = parseComparisonGroups(comparison);
    if (selectedGroups.length !== 2) {
        throw new Error("Manual comparison must contain exactly two groups.");
    }

    const backendGroupMap = new Map([
        [normalizeGroupValue(selectedGroups[0]), "group1"],
        [normalizeGroupValue(selectedGroups[1]), "group2"],
    ]);

    const derivedTarget = `manualttest.${sanitizeBackendToken(targetColumn, "target")}.${Date.now()}`;
    const header = ["sample_id", ...violinSourceCache.metaHeader, derivedTarget];
    const lines = [header.map(escapeCsvValue).join(",")];
    violinSourceCache.sampleToMeta.forEach((meta, sampleId) => {
        const rawValue = normalizeGroupValue(meta?.[targetColumn]);
        const encodedValue = backendGroupMap.get(rawValue) || "";
        const row = [sampleId, ...violinSourceCache.metaHeader.map((column) => meta?.[column] ?? ""), encodedValue];
        lines.push(row.map(escapeCsvValue).join(","));
    });

    const metaPathOverride = `projects/${auth.currentUser.uid}/${projectId}/univariate_results/ttest_manual_meta_${Date.now()}.csv`;
    await uploadString(ref(storage, metaPathOverride), lines.join("\n"), "raw", { contentType: "text/csv" });

    const countMap = new Map(groupEntries.map((entry) => [normalizeGroupValue(entry.label), entry.count]));
    const displayComparison = `${selectedGroups[0]} (${countMap.get(normalizeGroupValue(selectedGroups[0])) || 0}) vs ${selectedGroups[1]} (${countMap.get(normalizeGroupValue(selectedGroups[1])) || 0})`;

    return {
        target: derivedTarget,
        comparison: "group1 vs group2",
        metaPathOverride,
        displayTarget: targetColumn,
        displayComparison,
        displayGroupMap: {
            group1: selectedGroups[0],
            group2: selectedGroups[1],
        },
        manualTarget: targetColumn,
        manualComparison: comparison,
    };
}

async function persistSplitContextForRun(runId) {
    const context = splitRunContext.get(runId);
    if (!context || context.persisted !== false) return;
    const { persisted: _persisted, ...publicContext } = context;
    const nextHistory = deduplicateHistory((projectData?.ttest_history || analysisHistory).map((item) => item.run_id === runId ? { ...item, ...publicContext } : item));
    await updateDoc(doc(db, "projects", projectId), { ttest_history: nextHistory });
    analysisHistory = nextHistory.map(decorateAnalysisEntry);
    projectData = { ...projectData, ttest_history: nextHistory };
    context.persisted = true;
    splitRunContext.set(runId, context);
}

function setResultsLoading(message) {
    showResults();
    setActiveResultsTab("overview");
    selectedLipids.clear();
    selectedEnrichmentRunId = null;
    selectedNetworkRunId = null;
    currentCsvUrl = null;
    currentResultsUrl = null;
    dom.rowCount().innerText = "Loading...";
    dom.tableBody().innerHTML = `<tr><td colspan="4" class="text-muted py-3">${message}</td></tr>`;
    dom.volcano().innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center; color:#6c757d; font-size:0.9rem;">${message}</div>`;
    renderViolinEmpty(message);
}

function normalizeAnalysisStatus(status) {
    const value = String(status || "done").toLowerCase();
    if (value === "pending") return "pending";
    if (value === "running") return "running";
    if (value === "error") return "error";
    return "done";
}

function formatTaskId(item) {
    if (item?.task_id == null || item?.task_id === "") return "";
    return `ID ${item.task_id}`;
}

function getAnalysisStatusBadge(status) {
    if (status === "running") return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === "pending") return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === "error") return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

async function loadAnalysisPayload(url) {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load DEA results (HTTP ${response.status}).`);
    return response.json();
}

async function ensureAnalysisResultsLoaded(analysis) {
    if (Array.isArray(analysis?.results) && analysis.results.length) return analysis.results;

    const resultsUrl = analysis?.results_url || analysis?.data_url || analysis?.univariate_results_url || null;
    if (!resultsUrl) return [];

    const payload = await loadAnalysisPayload(resultsUrl);
    const resolvedResults = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];

    analysis.results = resolvedResults;
    if (!analysis.results_url) analysis.results_url = resultsUrl;
    return resolvedResults;
}

function buildTaskFallbackEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        name: task.name || "Untitled",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        target: task.target || null,
        comparison: task.comparison || null,
        paired: !!task.paired,
        pair_id_col: task.pair_id_col || null,
        csv_url: task.csv_url || null,
        results_url: task.results_url || task.data_url || null,
        data_url: task.data_url || task.results_url || null,
        result_count: task.result_count || 0,
        results: Array.isArray(task.results) ? task.results : [],
        status: normalizeAnalysisStatus(task.status),
        message: task.message || "",
    };
}

function getTaskActivityTime(task) {
    const raw = task?.heartbeat_at || task?.updated_at || task?.started_at || task?.date || null;
    const ts = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ts) ? ts : null;
}

function isTaskStale(task) {
    const status = normalizeAnalysisStatus(task?.status);
    if (status !== "pending" && status !== "running") return false;
    const activityTs = getTaskActivityTime(task);
    if (!activityTs) return false;
    return (Date.now() - activityTs) >= TASK_STALE_TIMEOUT_MS;
}

async function expireStaleAnalysisTask(task) {
    if (!task?.run_id || !isTaskStale(task) || staleAnalysisRunId === task.run_id) return false;

    staleAnalysisRunId = task.run_id;
    const message = "Task timed out after 180 minutes without backend heartbeat.";
    const nowIso = new Date().toISOString();
    const nextTask = {
        ...task,
        status: "error",
        message,
        completed_at: nowIso,
        updated_at: nowIso,
    };
    const fallbackEntry = analysisHistory.find((item) => item.run_id === task.run_id) || buildTaskFallbackEntry(task) || {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        name: task.name || "Untitled",
        date: task.started_at || nowIso,
        target: task.target || null,
        comparison: task.comparison || null,
        paired: !!task.paired,
        pair_id_col: task.pair_id_col || null,
    };
    const errorEntry = {
        ...fallbackEntry,
        status: "error",
        message,
        date: fallbackEntry.date || task.started_at || nowIso,
    };
    const nextHistory = deduplicateHistory([
        errorEntry,
        ...analysisHistory.filter((item) => item.run_id !== task.run_id),
    ]);

    try {
        await updateDoc(doc(db, "projects", projectId), {
            status: "ttest_error",
            error_msg: message,
            ttest_task: nextTask,
            ttest_history: nextHistory,
        });
        analysisHistory = nextHistory;
        renderAnalysisHistoryPopup();
    } catch (error) {
        console.error("Failed to expire stale task:", error);
    } finally {
        staleAnalysisRunId = null;
    }

    return true;
}

async function syncRunTaskState(task) {
    if (!task?.run_id) {
        if (!currentRunId) setRunBusy(false, "", false);
        return;
    }

    const normalizedStatus = normalizeAnalysisStatus(task.status);

    if (normalizedStatus === "pending" || normalizedStatus === "running") {
        currentRunId = task.run_id;
        setRunBusy(true, `${task.name || "Analysis"} is ${normalizedStatus}...`);
        return;
    }

    if (normalizedStatus === "error") {
        if (!currentRunId || currentRunId === task.run_id) {
            currentRunId = null;
            setRunBusy(false, task.message || "Analysis failed.", true);
        }
        return;
    }

    if (normalizedStatus === "done") {
        const shouldAutoload = Boolean(currentRunId && currentRunId === task.run_id);
        currentRunId = null;
        if (shouldAutoload) selectedHistoryRunId = task.run_id;
        setRunBusy(false, shouldAutoload ? `Done: ${task.name || task.run_id}` : "");
        if (splitRunContext.has(task.run_id)) {
            try {
                await persistSplitContextForRun(task.run_id);
            } catch (error) {
                console.warn("Unable to persist split context for completed analysis run:", error);
            }
        }

        if (!shouldAutoload) return;

        const entry = decorateAnalysisEntry(analysisHistory.find((item) => item.run_id === task.run_id) || buildTaskFallbackEntry(task));
        if (entry) {
            await loadAnalysisResults(entry, { preferredTab: "overview" });
        }
    }
}

async function refreshAnalysisStateFromSnapshot(nextData) {
    if (await expireStaleAnalysisTask(nextData.ttest_task || null)) return;

    const historyChanged = JSON.stringify(nextData.ttest_history || []) !== JSON.stringify(projectData.ttest_history || []);
    const enrichmentChanged = JSON.stringify(nextData.ttest_enrichment_history || []) !== JSON.stringify(projectData.ttest_enrichment_history || []);
    const networkChanged = JSON.stringify(nextData.network_history || []) !== JSON.stringify(projectData.network_history || []);
    if (historyChanged) {
        analysisHistory = deduplicateHistory(nextData.ttest_history || []);
        renderAnalysisHistoryPopup();
    }

    if (enrichmentChanged) {
        enrichmentHistory = deduplicateEnrichmentHistory(nextData.ttest_enrichment_history || []);
        renderEnrichmentHistory();
    }

    if (networkChanged) {
        networkHistory = deduplicateEnrichmentHistory(nextData.network_history || []);
        renderNetworkHistory();
    }

    projectData = {
        ...projectData,
        ...nextData,
        ttest_enrichment_history: enrichmentHistory,
        ttest_enrichment_task: nextData.ttest_enrichment_task || null,
        network_history: networkHistory,
        network_task: nextData.network_task || null,
    };

    await syncRunTaskState(nextData.ttest_task || null);
    syncEnrichmentTaskState(nextData.ttest_enrichment_task || null);
    syncNetworkTaskState(nextData.network_task || null);
}

function scrollToLipidRow(lipid) {
    const row = dom.tableBody().querySelector(`tr[data-lipid="${CSS.escape(lipid)}"]`);
    row?.scrollIntoView({ block: "nearest" });
}

async function refreshSelectionViews(focusLipid = null) {
    renderUnivariateTable(uniResultsGlobal);
    updateVolcanoLabelsOnly();
    await renderSelectedViolinPlots();
    if (focusLipid) scrollToLipidRow(focusLipid);
}

async function initUnivariateSetup() {
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(projectData.norm_settings, projectData.normality_stat);
    analysisHistory = deduplicateHistory(projectData.ttest_history || []);
    enrichmentHistory = deduplicateEnrichmentHistory(projectData.ttest_enrichment_history || []);
    networkHistory = deduplicateEnrichmentHistory(projectData.network_history || []);

    renderAnalysisHistoryPopup();
    renderEnrichmentHistory();
    renderNetworkHistory();
    dom.normalityInfo().innerHTML = "Normality is evaluated per feature. Unpaired mode tests each group separately; paired mode tests within-pair differences.";

    populateTargetMeta();
    populatePairIdColumns();
    bindEvents();
    initEnrichmentModal();
    initNetworkModal();
    try {
        await syncSplitEngineMetadata();
    } catch (error) {
        console.warn("Unable to preload metadata for split mode:", error);
    }
    await ensureSplitEngineMounted();
    setConfigMode(splitState.mode);
    validateForm();
    updateAnalysisSummary();
    setRunStatus("");

    if (requestedRunId) {
        const requestedEntry = analysisHistory.find((item) => item.run_id === requestedRunId);
        if (requestedEntry) await loadAnalysisResults(requestedEntry, { preferredTab: requestedTab === "enrichment" ? "enrichment" : "overview" });
        updateEnrichmentAvailability();
    }

    await syncRunTaskState(projectData.ttest_task || null);

    onSnapshot(doc(db, "projects", projectId), async (snapshot) => {
        const nextData = snapshot.data() || {};
        if (JSON.stringify(nextData.meta_metadata || []) !== JSON.stringify(projectData.meta_metadata || [])) {
            projectData = { ...projectData, meta_metadata: nextData.meta_metadata || [] };
            populateTargetMeta();
            populatePairIdColumns();
            try {
                await syncSplitEngineMetadata();
            } catch (error) {
                console.warn("Unable to refresh metadata for split mode:", error);
            }
        }
        await refreshAnalysisStateFromSnapshot(nextData);
    });
}

function bindEvents() {
    const volcanoAnchor = document.getElementById("volcano-config-anchor");
    if (volcanoAnchor) {
        mountPlotConfigPanel({
            anchor: volcanoAnchor,
            defaults: volcanoPlotConfig,
            options: {
                showLabelSize: false,
                showEllipseOpacity: false,
            },
            onUpdate: (key, value, allCfg) => {
                Object.assign(volcanoPlotConfig, allCfg);
                if (uniResultsGlobal.length > 0) renderVolcanoPlot(uniResultsGlobal, { preserveRanges: true });
            },
            onDownload: (cfg) => {
                const el = dom.volcano();
                if (!el || !el.layout) return;
                Plotly.downloadImage(el, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "volcano" });
            },
        });
    }
    dom.target().onchange = renderComparisonPairs;
    dom.analysisName().oninput = validateForm;
    dom.configModeManual().onclick = () => {
        if (!pendingSplitHistorySnapshot) {
            splitEngine?.reset();
        }
        setConfigMode("manual");
    };
    dom.configModeSplit().onclick = async () => {
        try {
            await syncSplitEngineMetadata();
        } catch (error) {
            setRunStatus(error.message || "Unable to load metadata for split mode.", true);
            return;
        }
        setConfigMode("split");
    };
    dom.sortFilter().onchange = () => renderUnivariateTable(uniResultsGlobal);
    dom.minFilter().onchange = () => {
        const value = Number(dom.minFilter().value);
        const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.05;
        dom.minFilter().value = String(normalized);
        updateEnrichmentAvailability();
        renderUnivariateTable(uniResultsGlobal);
        if (uniResultsGlobal.length > 0) renderVolcanoPlot(uniResultsGlobal);
    };
    dom.searchInput().oninput = () => renderUnivariateTable(uniResultsGlobal);
    dom.fcThresholdInput()?.addEventListener("input", () => {
        renderUnivariateTable(uniResultsGlobal);
        if (uniResultsGlobal.length > 0) renderVolcanoPlot(uniResultsGlobal);
    });
    dom.pairedMode().onchange = () => {
        updateEnrichmentAvailability();
        dom.pairIdCol().disabled = !dom.pairedMode().checked;
        validateForm();
    };
    dom.pairIdCol().onchange = validateForm;
    const ttHints = {
        auto: "Auto: per-feature normality test decides.",
        student: "Student forced: equal-variance t-test (unpaired). Effect: Cohen's d.",
        welch: "Welch forced: unequal-variance t-test (unpaired). Effect: Cohen's d.",
        wilcoxon: "Non-parametric forced: Mann-Whitney U (unpaired) or Wilcoxon signed-rank (paired). Effect: rank-biserial r.",
    };
    const ttSelect = document.getElementById("test-type");
    if (ttSelect) {
        ttSelect.addEventListener("change", () => {
            const hint = document.getElementById("tt-type-hint");
            if (hint) hint.textContent = ttHints[ttSelect.value] || "";
        });
    }
    document.addEventListener("change", (event) => {
        if (event.target.classList.contains("comp-check")) validateForm();
    });
    dom.historyToggle().onclick = () => dom.historyPopup().classList.toggle("open");
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".history-anchor")) dom.historyPopup().classList.remove("open");
    });

    dom.runBtn().onclick = runUnivariateAnalysis;
    if (dom.splitRunInlineBtn()) dom.splitRunInlineBtn().onclick = runUnivariateAnalysis;
    dom.csvBtn().onclick = () => {
        if (!currentCsvUrl) {
            alert("Please run analysis first.");
            return;
        }
        downloadFilteredUnivariateCsv(currentCsvUrl, "univariate_results.csv");
    };
    dom.resultTabOverview().onclick = () => setActiveResultsTab("overview");
    dom.resultTabEnrichment().onclick = () => setActiveResultsTab("enrichment");
    dom.resultTabNetwork().onclick = () => setActiveResultsTab("network");
    dom.enrichmentHistorySearch().oninput = renderEnrichmentHistory;
    dom.networkHistorySearch().oninput = renderNetworkHistory;
    dom.openEnrichmentModalBtn().onclick = openEnrichmentModal;
    dom.openNetworkModalBtn().onclick = openNetworkModal;
    dom.runEnrichmentBtn().onclick = runEnrichmentAnalysis;
    dom.runNetworkBtn().onclick = runNetworkAnalysis;
    dom.enrichmentBackBtn().onclick = closeInlineEnrichmentView;

    window.addEventListener("message", (event) => {
        if (event.data?.type === "enrichment-ready") {
            const loading = dom.enrichmentInlineLoading();
            if (loading) loading.style.display = "none";
        }
    });
}

function deduplicateHistory(history) {
    const seen = new Set();
    return (history || []).map((item) => {
        const sanitized = { ...item };
        delete sanitized.results;
        sanitized.status = normalizeAnalysisStatus(sanitized.status);
        return decorateAnalysisEntry(sanitized);
    }).filter((item) => {
        const key = item.run_id || `${item.name}_${item.target}_${item.comparison}_${item.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function deduplicateEnrichmentHistory(history) {
    const seen = new Set();
    return (history || []).map((item) => ({
        ...item,
        status: normalizeEnrichmentStatus(item.status),
    })).filter((item) => {
        const key = item.run_id || `${item.title}_${item.source_run_id}_${item.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function escapeHtmlAttr(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildHistoryTooltip(item) {
    return [
        formatTaskId(item) || null,
        `Analysis: ${item.name || "-"}`,
        `Target: ${getAnalysisDisplayTarget(item) || "-"}`,
        `Comparison: ${getAnalysisDisplayComparison(item) || "-"}`,
        `Paired: ${item.paired ? "Yes" : "No"}`,
        `Status: ${normalizeAnalysisStatus(item.status)}`,
        `Date: ${item.date ? new Date(item.date).toLocaleString() : "-"}`
    ].filter(Boolean).join("\n");
}

function buildEnrichmentTooltip(item) {
    return [
        `Run: ${item.title || "-"}`,
        `Status: ${normalizeEnrichmentStatus(item.status)}`,
        `Source DAL: ${item.source_name || "-"}`,
        `Comparison: ${item.comparison || "-"}`,
        `Method: ${item.method || "GSEA"}`,
        `Databases: ${(item.databases || []).join(", ") || "-"}`,
        `Message: ${item.message || "-"}`,
        `Date: ${item.date ? new Date(item.date).toLocaleString() : "-"}`
    ].join("\n");
}

function normalizeEnrichmentStatus(status) {
    const value = String(status || "done").toLowerCase();
    if (value === "pending") return "pending";
    if (value === "running") return "running";
    if (value === "error") return "error";
    return "done";
}

function buildEnrichmentTaskEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        title: task.title || "Untitled enrichment",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        source_run_id: task.source_run_id || null,
        source_name: task.source_name || null,
        target: task.target || null,
        comparison: task.comparison || null,
        method: task.method || "GSEA",
        ranking_metric: task.ranking_metric || null,
        databases: Array.isArray(task.databases) ? task.databases : [],
        term_count: task.term_count || 0,
        significant_count: task.significant_count || 0,
        csv_url: task.csv_url || null,
        data_url: task.data_url || null,
        message: task.message || "",
        status: normalizeEnrichmentStatus(task.status),
        isTask: true,
    };
}

function getCurrentEnrichmentEntries() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) return [];

    const historyItems = deduplicateEnrichmentHistory(enrichmentHistory)
        .filter((item) => item.source_run_id === analysis.run_id)
        .map((item) => ({ ...item, status: normalizeEnrichmentStatus(item.status) }));

    const taskEntry = buildEnrichmentTaskEntry(projectData?.ttest_enrichment_task || null);
    if (!taskEntry || taskEntry.source_run_id !== analysis.run_id) {
        return historyItems;
    }

    const combined = taskEntry.status === "done"
        ? [...historyItems, taskEntry]
        : [taskEntry, ...historyItems];

    return deduplicateEnrichmentHistory(combined).map((item) => ({
        ...item,
        status: normalizeEnrichmentStatus(item.status),
    }));
}

function getEnrichmentStatusBadge(status) {
    if (status === "running") return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === "pending") return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === "error") return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

function canDeleteEnrichmentEntry(item) {
    return item?.status !== "pending" && item?.status !== "running";
}

function syncEnrichmentTaskState(task) {
    const taskEntry = buildEnrichmentTaskEntry(task);
    if (taskEntry?.run_id) {
        selectedEnrichmentRunId = taskEntry.run_id;
    }
    renderEnrichmentHistory();
}

async function deleteStorageArtifacts(urls) {
    const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
    if (!uniqueUrls.length) return;
    try {
        await fetch(`${vpsUrl}/storage/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: uniqueUrls })
        });
    } catch (error) {
        console.error("Failed to delete storage artifacts:", error);
    }
}

function buildProjectStateFromHistory() {
    const latest = analysisHistory.find((item) => normalizeAnalysisStatus(item.status) === "done") || null;
    return {
        ttest_history: analysisHistory.length ? analysisHistory : null,
        univariate_results: null,
        univariate_results_url: latest?.results_url || latest?.data_url || null,
        univariate_csv_url: latest?.csv_url || null,
        ttest_task: latest ? {
            run_id: latest.run_id,
            task_id: latest.task_id ?? null,
            name: latest.name,
            target: latest.target,
            comparison: latest.comparison,
            paired: !!latest.paired,
            pair_id_col: latest.pair_id_col || null,
            status: "done",
            results_url: latest.results_url || latest.data_url || null,
            data_url: latest.data_url || latest.results_url || null,
            csv_url: latest.csv_url || null,
            result_count: latest.result_count || (Array.isArray(latest.results) ? latest.results.length : 0),
            completed_at: latest.date || null
        } : null
    };
}

function clearLoadedAnalysis() {
    selectedHistoryRunId = null;
    selectedEnrichmentRunId = null;
    selectedNetworkRunId = null;
    currentCsvUrl = null;
    uniResultsGlobal = [];
    selectedLipids.clear();
    renderUnivariateTable([]);
    renderViolinEmpty("Load an analysis result first, then select features.");
    setAnalysisContext(null, null);
    renderEnrichmentHistory();
    renderNetworkHistory();
    dom.volcano().innerHTML = "";
    dom.resultsContainer().classList.add("d-none");
    currentResultsUrl = null;
    if (splitState.mode === "split") setSplitWorkspaceVisible(true);
    updateEnrichmentAvailability();
}

function renderAnalysisHistoryPopup() {
    const popup = dom.historyPopup();
    analysisHistory = deduplicateHistory(analysisHistory);
    if (!analysisHistory.length) {
        popup.innerHTML = '<div class="history-meta p-2 text-center">No runs yet.</div>';
        return;
    }

    popup.innerHTML = analysisHistory.map((item) => `
        <div class="history-item d-flex align-items-start gap-2 ${selectedHistoryRunId && item.run_id === selectedHistoryRunId ? "active" : ""}" data-run-id="${item.run_id || ""}" title="${escapeHtmlAttr(buildHistoryTooltip(item))}">
            <div class="history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">${item.name || "Untitled"}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getAnalysisStatusBadge(normalizeAnalysisStatus(item.status))}<span>${formatTaskId(item) || "No ID"}</span></div>
                <div class="history-meta">${getAnalysisDisplayTarget(item) || "-"} | ${getAnalysisDisplayComparison(item) || "-"}</div>
                <div class="history-meta">${item.message || (normalizeAnalysisStatus(item.status) === "done" ? "Ready to open." : normalizeAnalysisStatus(item.status) === "running" ? "Analysis is still running..." : normalizeAnalysisStatus(item.status) === "pending" ? "Queued for processing..." : "Run failed.")}</div>
                <div class="history-meta">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete" data-run-id="${item.run_id || ""}" title="Delete this run" style="font-size:0.65rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `).join("");

    popup.querySelectorAll(".history-info").forEach((node) => {
        node.onclick = () => {
            const runId = node.parentElement.dataset.runId;
            const entry = analysisHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            const status = normalizeAnalysisStatus(entry.status);
            if (status === "pending" || status === "running") return;
            if (status === "error") {
                setRunStatus(entry.message || "Analysis failed.", true);
                return;
            }
            selectedHistoryRunId = runId || null;
            popup.querySelectorAll(".history-item").forEach((el) => el.classList.remove("active"));
            node.parentElement.classList.add("active");
            loadAnalysisResults(entry, { preferredTab: "overview" });
            popup.classList.remove("open");
        };
    });

    popup.querySelectorAll(".history-delete").forEach((button) => {
        button.onclick = async (event) => {
            event.stopPropagation();
            const runId = button.dataset.runId;
            const entry = analysisHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            const status = normalizeAnalysisStatus(entry.status);
            if (status === "pending" || status === "running") {
                setRunStatus("This task is still processing and cannot be deleted yet.", true);
                return;
            }
            if (!confirm(`Delete "${entry.name}"?`)) return;
            const urlsToDelete = [entry.csv_url, entry.results_url || entry.data_url, entry.metaPathOverride || entry.meta_path_override].filter(Boolean);
            await deleteStorageArtifacts(urlsToDelete);
            analysisHistory = analysisHistory.filter((item) => item.run_id !== runId);
            const projectState = buildProjectStateFromHistory();
            await updateDoc(doc(db, "projects", projectId), projectState);
            projectData = { ...projectData, ...projectState };
            if (selectedHistoryRunId === runId) {
                const fallbackEntry = analysisHistory[0] || null;
                if (fallbackEntry) await loadAnalysisResults(fallbackEntry, { preferredTab: "overview" });
                else clearLoadedAnalysis();
            }
            renderAnalysisHistoryPopup();
        };
    });
}

function populateTargetMeta() {
    const target = dom.target();
    const previousValue = target.value;
    const eligibleColumns = getEligibleGroupedMetaColumns(2);
    target.innerHTML = '<option value="">-- Select --</option>' + eligibleColumns.map((item) => `<option value="${item.name}">${item.name}</option>`).join("");
    if (previousValue && eligibleColumns.some((item) => item.name === previousValue)) {
        target.value = previousValue;
    }
}

function populatePairIdColumns() {
    const targetName = dom.target().value;
    const options = (projectData.meta_metadata || [])
        .filter((item) => item.name !== targetName)
        .map((item) => `<option value="${item.name}">${item.name}</option>`)
        .join("");
    dom.pairIdCol().innerHTML = `<option value="">-- Select Pair ID column --</option>${options}`;
}

function renderComparisonPairs() {
    const target = dom.target().value;
    populatePairIdColumns();
    if (!target) {
        dom.compList().innerHTML = "";
        validateForm();
        return;
    }
    const groupEntries = getComparisonGroupEntries(target);
    if (groupEntries.length < 2) {
        dom.compList().innerHTML = '<div class="text-muted extra-small">No valid comparison pairs found for this metadata column.</div>';
        validateForm();
        return;
    }
    let html = "";
    for (let i = 0; i < groupEntries.length; i++) {
        for (let j = i + 1; j < groupEntries.length; j++) {
            const left = groupEntries[i];
            const right = groupEntries[j];
            const pairValue = `${left.label} vs ${right.label}`;
            const pairLabel = `${left.label} (${left.count}) vs ${right.label} (${right.count})`;
            html += `<div class="form-check"><input class="form-check-input comp-check" type="radio" name="comparison" value="${pairValue}" id="p-${i}-${j}"><label class="form-check-label extra-small" for="p-${i}-${j}">${pairLabel}</label></div>`;
        }
    }
    dom.compList().innerHTML = html;
    validateForm();
}

function validateForm() {
    const paired = dom.pairedMode().checked;
    const pairIdCol = dom.pairIdCol().value;
    const manualReady = Boolean(dom.target().value && document.querySelector(".comp-check:checked"));
    const splitReady = violinSourceCache.sampleToMeta.size ? Boolean(splitEngine?.isValid()) : false;
    const baseReady = splitState.mode === "split" ? splitReady : manualReady;
    const disabled = !baseReady || (paired && !pairIdCol) || isRunCoolingDown();
    dom.runBtn().disabled = disabled;
    if (dom.splitRunInlineBtn()) dom.splitRunInlineBtn().disabled = disabled;
    if (!isRunCoolingDown()) {
        dom.runBtn().innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN ANALYSIS';
    }
}

function updateNormalityInfoFromResults(results) {
    if (!results || !results.length) return;
    const isPaired = !!results[0]?.paired;
    const normalCount = results.filter((row) => {
        if (isPaired) return (row.normality_p_diff || 0) > 0.05;
        return (row.normality_p_group1 || 0) > 0.05 && (row.normality_p_group2 || 0) > 0.05;
    }).length;
    const pct = ((normalCount / results.length) * 100).toFixed(2);
    const strategy = pct > 95 ? (isPaired ? "Paired T-test" : "Student/Welch T-test") : pct < 20 ? (isPaired ? "Wilcoxon Signed-Rank" : "Mann-Whitney U") : "Hybrid (Auto T-test/MWU)";
    dom.normalityInfo().innerHTML = `<b>Data Normality:</b> ${pct}% Features are normal.<br>`; 
    // <b>Suggested Strategy:</b> ${strategy}
}

function parseComparisonGroups(comparison) {
    return String(comparison || "").split(" vs ").map((value) => value.trim()).filter(Boolean);
}

function normalizeComparisonLabel(value) {
    return String(value || "")
        .trim()
        .replace(/\s*\(\d+\)\s*$/, "")
        .trim();
}

function buildViolinColorMap(stages, comparison, displayGroupMap = null) {
    const stageLabels = (stages || []).map((stage) => String(stage?.label || "").trim());
    const normalizedToStage = new Map(stageLabels.map((label) => [normalizeComparisonLabel(label), label]));
    const comparisonOrder = parseComparisonGroups(comparison)
        .map((label) => displayGroupMap?.[label] || label)
        .map((label) => String(label || "").trim());

    const colorMap = new Map();
    if (comparisonOrder.length >= 2) {
        const groupAStageLabel = stageLabels.includes(comparisonOrder[0])
            ? comparisonOrder[0]
            : normalizedToStage.get(normalizeComparisonLabel(comparisonOrder[0]));
        const groupBStageLabel = stageLabels.includes(comparisonOrder[1])
            ? comparisonOrder[1]
            : normalizedToStage.get(normalizeComparisonLabel(comparisonOrder[1]));
        if (groupAStageLabel) colorMap.set(groupAStageLabel, "#ff000d"); // A -> red
        if (groupBStageLabel) colorMap.set(groupBStageLabel, "#000dff"); // B -> blue
    }

    stages.forEach((stage, index) => {
        if (!colorMap.has(stage.label)) {
            colorMap.set(stage.label, index % 2 === 0 ? "#ff000d" : "#000dff");
        }
    });

    return colorMap;
}

function parseCsvRow(line) {
    const row = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index++) {
        const ch = line[index];
        if (ch === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === "," && !inQuotes) {
            row.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    row.push(current);
    return row;
}

function scoreReconciledMetaValue(columnName, rawValue) {
    const value = String(rawValue ?? "").trim();
    if (!value || value.toLowerCase() === "nan") return 0;

    const meta = getMetaDescriptorByName(columnName);
    if (!meta) return value.includes(",") ? 0.5 : 0.25;

    const groups = getCleanMetaGroupValues(meta);
    if (groups.includes(value)) return 6;
    if (String(meta.type || "").toLowerCase() === "continuous" && Number.isFinite(Number(value))) return 4;
    if (groups.length) return -1;
    return value.includes(",") ? 0.5 : 0.25;
}

function reconcileMetaCsvRow(row, header) {
    const expectedLength = Array.isArray(header) ? header.length : 0;
    if (!expectedLength || row.length === expectedLength) return row;
    if (row.length < expectedLength) return [...row, ...Array(expectedLength - row.length).fill("")];
    if (expectedLength < 2) return row.slice(0, expectedLength);

    const overflow = row.length - expectedLength;
    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let mergeStart = 1; mergeStart <= row.length - (overflow + 1); mergeStart += 1) {
        const candidate = [
            ...row.slice(0, mergeStart),
            row.slice(mergeStart, mergeStart + overflow + 1).join(","),
            ...row.slice(mergeStart + overflow + 1),
        ];
        if (candidate.length !== expectedLength) continue;
        const score = header.slice(1).reduce((total, columnName, index) => total + scoreReconciledMetaValue(columnName, candidate[index + 1]), 0);
        if (score > bestScore) {
            bestScore = score;
            bestCandidate = candidate;
        }
    }

    return bestCandidate || [...row.slice(0, expectedLength - 1), row.slice(expectedLength - 1).join(",")];
}

async function getStorageCsvText(path) {
    if (!path) throw new Error("Missing data file path in project settings.");
    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(url);
    if (!response.ok) throw new Error("Cannot load data file from local storage.");
    return response.text();
}

function parseMatrixCsv(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length < 2) throw new Error("Matrix file is empty.");
    const header = parseCsvRow(lines[0]);
    const sampleIds = header.slice(1).map((value) => String(value || "").trim());
    const lipidToValues = new Map();
    for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
        const row = parseCsvRow(lines[rowIndex]);
        const lipid = String(row[0] || "").trim();
        if (!lipid) continue;
        const values = new Array(sampleIds.length);
        for (let sampleIndex = 0; sampleIndex < sampleIds.length; sampleIndex++) {
            const num = Number(row[sampleIndex + 1]);
            values[sampleIndex] = Number.isFinite(num) ? num : null;
        }
        lipidToValues.set(lipid, values);
    }
    return { sampleIds, lipidToValues };
}

function parseMetaCsv(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length < 2) throw new Error("Metadata file is empty.");
    const header = parseCsvRow(lines[0]).map((value) => String(value || "").trim());
    const metaHeader = header.slice(1);
    const sampleToMeta = new Map();
    for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
        const row = reconcileMetaCsvRow(parseCsvRow(lines[rowIndex]), header);
        const sample = String(row[0] || "").trim();
        if (!sample) continue;
        const values = {};
        for (let columnIndex = 0; columnIndex < metaHeader.length; columnIndex++) {
            values[metaHeader[columnIndex]] = row[columnIndex + 1] ?? "";
        }
        sampleToMeta.set(sample, values);
    }
    return { metaHeader, sampleToMeta };
}

async function ensureViolinSourceLoaded(metaPathOverride = null) {
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath || null;
    const metaPath = metaPathOverride || projectData?.metaCheckedPath || null;
    if (!matrixPath || !metaPath) throw new Error("Project is missing normalized matrix or checked metadata path.");
    const sameSource = violinSourceCache.matrixPath === matrixPath && violinSourceCache.metaPath === metaPath;
    if (sameSource && violinSourceCache.lipidToValues.size > 0 && violinSourceCache.sampleToMeta.size > 0) return;
    const [matrixText, metaText] = await Promise.all([getStorageCsvText(matrixPath), getStorageCsvText(metaPath)]);
    const matrixParsed = parseMatrixCsv(matrixText);
    const metaParsed = parseMetaCsv(metaText);
    violinSourceCache = {
        matrixPath,
        metaPath,
        matrixHeader: matrixParsed.sampleIds,
        lipidToValues: matrixParsed.lipidToValues,
        metaHeader: metaParsed.metaHeader,
        sampleToMeta: metaParsed.sampleToMeta
    };
}

function buildViolinCacheKey(lipid, target, comparison, metaPathOverride = null) {
    return `${metaPathOverride || projectData?.metaCheckedPath || "-"}__${target || "-"}__${comparison || "-"}__${lipid || "-"}`;
}

function setAnalysisContext(target, comparison, options = {}) {
    const nextTarget = target || null;
    const nextComparison = comparison || null;
    const nextDisplayTarget = options.displayTarget || nextTarget;
    const nextDisplayComparison = options.displayComparison || nextComparison;
    const nextDisplayGroupMap = options.displayGroupMap || null;
    const nextMetaPathOverride = options.metaPathOverride || null;
    if (currentAnalysisContext.target !== nextTarget || currentAnalysisContext.comparison !== nextComparison || currentAnalysisContext.metaPathOverride !== nextMetaPathOverride) {
        violinDataCache = new Map();
    }
    currentAnalysisContext = {
        target: nextTarget,
        comparison: nextComparison,
        displayTarget: nextDisplayTarget || null,
        displayComparison: nextDisplayComparison || null,
        displayGroupMap: nextDisplayGroupMap || null,
        metaPathOverride: nextMetaPathOverride,
    };
    document.getElementById("volcano-title").textContent = nextDisplayTarget && nextDisplayComparison ? `Volcano Plot (${nextDisplayTarget} - DEA ${nextDisplayComparison})` : "Volcano Plot";
    updateAnalysisSummary();
}

function updateAnalysisSummary() {
    const analysis = getCurrentAnalysisEntry();
    const comparisonText = currentAnalysisContext.displayTarget && (currentAnalysisContext.displayComparison || currentAnalysisContext.comparison)
        ? `${currentAnalysisContext.displayTarget} | ${currentAnalysisContext.displayComparison || currentAnalysisContext.comparison}`
        : "No DEA loaded";
    dom.analysisCompareChip().textContent = comparisonText;
    dom.enrichmentCurrentComparison().textContent = comparisonText;
    dom.networkCurrentComparison().textContent = comparisonText;
    dom.enrichmentCurrentAnalysis().textContent = analysis ? `${analysis.name || "Untitled"}${analysis.paired ? ` | Paired by ${analysis.pair_id_col || "-"}` : " | Unpaired"}` : "Load a DEA result from history or run a new one.";
    dom.networkCurrentAnalysis().textContent = dom.enrichmentCurrentAnalysis().textContent;
    updateEnrichmentAvailability();
}

function hasLoadedAnalysisResults() {
    return Array.isArray(uniResultsGlobal) && uniResultsGlobal.length > 0;
}

function updateEnrichmentAvailability() {
    const enabled = hasLoadedAnalysisResults();
    dom.resultTabEnrichment().disabled = !enabled;
    dom.resultTabEnrichment().classList.toggle("disabled", !enabled);
    dom.openEnrichmentModalBtn().disabled = !enabled;
    dom.resultTabNetwork().disabled = !enabled;
    dom.resultTabNetwork().classList.toggle("disabled", !enabled);
    dom.openNetworkModalBtn().disabled = !enabled;
}

function setActiveResultsTab(tabName) {
    if (tabName !== "overview" && !hasLoadedAnalysisResults()) {
        return;
    }
    if (!["overview", "enrichment", "network"].includes(tabName)) tabName = "overview";
    dom.resultTabOverview().classList.toggle("active", tabName === "overview");
    dom.resultTabEnrichment().classList.toggle("active", tabName === "enrichment");
    dom.resultTabNetwork().classList.toggle("active", tabName === "network");
    dom.overviewPanel().classList.toggle("d-none", tabName !== "overview");
    dom.enrichmentPanel().classList.toggle("d-none", tabName !== "enrichment");
    dom.networkPanel().classList.toggle("d-none", tabName !== "network");
}

function getCurrentAnalysisEntry() {
    if (selectedHistoryRunId) {
        const historyEntry = analysisHistory.find((item) => item.run_id === selectedHistoryRunId);
        if (historyEntry) return historyEntry;
    }
    if (!uniResultsGlobal.length) return null;
    return {
        run_id: selectedHistoryRunId || currentRunId || "adhoc",
        name: dom.analysisName().value || "Current DAL",
        target: currentAnalysisContext.target,
        display_target: currentAnalysisContext.displayTarget || currentAnalysisContext.target,
        comparison: currentAnalysisContext.displayComparison || currentAnalysisContext.comparison,
        display_comparison: currentAnalysisContext.displayComparison || currentAnalysisContext.comparison,
        display_group_map: currentAnalysisContext.displayGroupMap || null,
        backend_target: currentAnalysisContext.target,
        backend_comparison: currentAnalysisContext.comparison,
        meta_path_override: currentAnalysisContext.metaPathOverride || null,
        paired: dom.pairedMode().checked,
        pair_id_col: dom.pairIdCol().value || null,
        results: uniResultsGlobal,
        csv_url: currentCsvUrl || null
    };
}

function renderViolinEmpty(message) {
    dom.violinGrid().innerHTML = `<div class="violin-item empty">${message}</div>`;
}

async function fetchViolinData(lipid, target, comparison, metaPathOverride = null) {
    const cacheKey = buildViolinCacheKey(lipid, target, comparison, metaPathOverride);
    if (violinDataCache.has(cacheKey)) return violinDataCache.get(cacheKey);
    await ensureViolinSourceLoaded(metaPathOverride);
    const lipidValues = violinSourceCache.lipidToValues.get(lipid);
    if (!lipidValues) throw new Error(`Lipid '${lipid}' not found in normalized matrix.`);
    if (!violinSourceCache.metaHeader.includes(target)) throw new Error(`Target metadata '${target}' not found.`);

    const displayGroupMap = currentAnalysisContext.displayGroupMap || null;
    const allowedGroups = new Set(parseComparisonGroups(comparison).map(String));
    const points = [];
    violinSourceCache.matrixHeader.forEach((sample, index) => {
        const abundance = lipidValues[index];
        if (!Number.isFinite(abundance)) return;
        const metaRow = violinSourceCache.sampleToMeta.get(sample);
        if (!metaRow) return;
        const stageLabel = String(metaRow[target] ?? "").trim();
        if (!stageLabel) return;
        if (allowedGroups.size && !allowedGroups.has(stageLabel)) return;
        points.push({ sample, stage_label: displayGroupMap?.[stageLabel] || stageLabel, abundance });
    });
    if (!points.length) throw new Error("No overlap samples after filtering selected groups.");

    // For violin orientation, keep B on the left and A on the right for "A vs B".
    const stageOrder = parseComparisonGroups(comparison).map((label) => displayGroupMap?.[label] || label).reverse();
    const labels = [...new Set(points.map((point) => point.stage_label))];
    const orderedLabels = stageOrder.length ? stageOrder.filter((label) => labels.includes(label)) : labels;
    if (!orderedLabels.length) throw new Error("No valid stage labels for violin plot.");

    const labelToCode = new Map(orderedLabels.map((label, index) => [label, index]));
    const stageCounts = new Map();
    const normalizedPoints = points.filter((point) => labelToCode.has(point.stage_label)).map((point) => {
        const count = stageCounts.get(point.stage_label) || 0;
        stageCounts.set(point.stage_label, count + 1);
        return { sample: point.sample, stage_code: labelToCode.get(point.stage_label), stage_label: point.stage_label, abundance: point.abundance };
    });
    const data = {
        lipid,
        target_meta: target,
        points: normalizedPoints,
        stages: orderedLabels.map((label) => ({ code: labelToCode.get(label), label, n: stageCounts.get(label) || 0 }))
    };
    violinDataCache.set(cacheKey, data);
    return data;
}

function renderSingleViolinPlot(container, trend) {
    const stages = (trend.stages || []).sort((left, right) => left.code - right.code);
    const violinTitle = `<b>${escapeHtmlAttr(trend?.lipid || "")}</b>`;
    const colorMap = buildViolinColorMap(stages, currentAnalysisContext.comparison, currentAnalysisContext.displayGroupMap || null);
    const traces = stages.map((stage, index) => {
        const stagePoints = (trend.points || []).filter((point) => Number(point.stage_code) === Number(stage.code));
        // fallback: stages sorted by code; code 0 = group2 (blue), code 1 = group1 (red)
        const color = colorMap.get(stage.label) || ["#ff000d","#000dff", "#20c997"][index % 3];
        return {
            type: "violin",
            name: stage.label,
            x: new Array(stagePoints.length).fill(stage.label),
            y: stagePoints.map((point) => Number(point.abundance)),
            points: false,
            fillcolor: color,
            line: { color, width: 1 },
            box: { visible: true },
            meanline: { visible: true },
            opacity: 0.72,
            hovertemplate: `${stage.label}<br>Abundance: %{y:.4f}<extra></extra>`,
            showlegend: false
        };
    });
    Plotly.newPlot(container, traces, {
        title: {
            text: violinTitle,
            x: 0.5,
            xanchor: "center",
            yanchor: "top",
            font: { size: violinPlotConfig.titleFontSize },
        },
        height: container.clientHeight > 0 ? container.clientHeight : 165,
        width: container.clientWidth > 0 ? container.clientWidth : undefined,
        margin: { t: 40, b: 36, l: 38, r: 6 },
        autosize: false,
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        yaxis: { title: "Norm_Abundance", automargin: true, tickfont: { size: violinPlotConfig.tickFontSize }, titlefont: { size: violinPlotConfig.titleFontSize } },
        xaxis: { tickfont: { size: violinPlotConfig.tickFontSize } }
    }, {
        responsive: false,
        displayModeBar: "hover",
        scrollZoom: false,
        displaylogo: false,
        staticPlot: false,
        toImageButtonOptions: { format: violinPlotConfig.imgFormat, width: violinPlotConfig.imgWidth, height: violinPlotConfig.imgHeight, scale: violinPlotConfig.imgScale }
    });
}

function getRankingPreviewRows() {
    return [...(uniResultsGlobal || [])]
        .map((row) => {
            const feature = String(row.lipid || row.gene || row.feature || row.Lipid || row.Gene || row.Feature || "").trim();
            const logfc = Number(row.log2fc ?? row.Log2FC ?? row.log_fc ?? row.LogFC ?? 0);
            const fdr = Math.max(Number(row.fdr ?? row.FDR ?? 1), 1e-300);
            return { feature, rank: Math.sign(logfc) * -Math.log10(fdr), logfc, fdr };
        })
        .filter((row) => row.feature)
        .sort((left, right) => {
            if (right.rank !== left.rank) return right.rank - left.rank;
            if (right.logfc !== left.logfc) return right.logfc - left.logfc;
            return left.feature.localeCompare(right.feature);
        });
}

function renderEnrichmentRankingPreview() {
    const rows = getRankingPreviewRows();
    if (!rows.length) {
        dom.enrichmentRankBody().innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Load a DEA result first.</td></tr>';
        return;
    }
    dom.enrichmentRankBody().innerHTML = rows.map((row) => `
        <tr>
            <td class="text-start">${row.feature}</td>
            <td>${row.rank.toFixed(4)}</td>
            <td class="${row.logfc > 0 ? "text-danger" : "text-primary"}">${row.logfc.toFixed(4)}</td>
            <td>${row.fdr.toExponential(3)}</td>
        </tr>
    `).join("");
}

function getSelectedEnrichmentDatabases() {
    return Array.from(document.querySelectorAll(".enrichment-db-check:checked")).map((input) => input.value);
}

function hasHpaDatabaseSelected() {
    return getSelectedEnrichmentDatabases().some((db) => db.startsWith(HPA_DATABASE_PREFIX));
}

function updateEnrichmentDatabaseLabel() {
    const selected = getSelectedEnrichmentDatabases();
    dom.enrichmentDbButton().textContent = !selected.length ? "Select database(s)" : selected.length === 1 ? selected[0] : `${selected.length} databases selected`;
    dom.enrichmentInputTypeCol().style.display = hasHpaDatabaseSelected() ? "" : "none";
}

function renderEnrichmentDatabaseMenu() {
    dom.enrichmentDbMenu().innerHTML = FALLBACK_ENRICHMENT_DATABASES.map((name) => `
        <div class="form-check">
            <input class="form-check-input enrichment-db-check" type="checkbox" value="${name}" id="db-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}">
            <label class="form-check-label small" for="db-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}">${name}</label>
        </div>
    `).join("");
    dom.enrichmentDbMenu().querySelectorAll(".enrichment-db-check").forEach((input) => {
        input.onchange = updateEnrichmentDatabaseLabel;
    });
    dom.enrichmentInputTypeCol().style.display = "none";
    updateEnrichmentDatabaseLabel();
}

async function ensureEnrichmentDatabasesLoaded() {
    // Databases are now fixed — no server fetch needed
}

function getEnrichmentInputType() {
    return dom.enrichmentInputType()?.value || "Gene";
}

function isEnrichmentOraMethod() {
    return dom.enrichmentMethod()?.value === "ORA";
}

    // ─── Lipid-mode enrichment (lipid ORA / LSEA) ───────────────────

const LIPID_METHOD_OPTIONS = [
    { value: "LSEA", label: "LSEA (Lipid Set Enrichment Analysis)" },
    { value: "ORA", label: "ORA (Over-Representation Analysis)" },
];
const GENE_METHOD_OPTIONS = [
    { value: "GSEA", label: "GSEA (Gene Set Enrichment Analysis)" },
    { value: "ORA", label: "ORA (Over-Representation Analysis)" },
];
let lipidCharacteristicsCache = null;
let lipidMappingStatus = null;  // last pre-flight result for the current DEA run

function isLipidMode() {
    return dom.enrichmentMoleculeType()?.value === "Lipid";
}

function getSelectedCharacteristics() {
    return Array.from(document.querySelectorAll(".enrichment-char-check:checked")).map((input) => input.value);
}

function updateCharacteristicLabel() {
    const btn = dom.enrichmentCharButton();
    if (!btn) return;
    const selected = getSelectedCharacteristics();
    btn.textContent = !selected.length
        ? "Select characteristic(s)…"
        : selected.length === 1 ? selected[0] : `${selected.length} characteristics selected`;
}

async function ensureLipidCharacteristicsLoaded() {
    if (lipidCharacteristicsCache) return lipidCharacteristicsCache;
    const res = await fetch(`${vpsUrl}/lipidref/characteristics`);
    if (!res.ok) throw new Error("Unable to load lipid characteristics.");
    const data = await res.json();
    lipidCharacteristicsCache = data.characteristics || [];
    return lipidCharacteristicsCache;
}

function renderEnrichmentCharacteristicMenu() {
    const menu = dom.enrichmentCharMenu();
    if (!menu) return;
    const items = lipidCharacteristicsCache || [];
    menu.innerHTML = items.map((item) => `
        <div class="form-check">
            <input class="form-check-input enrichment-char-check" type="checkbox" value="${item.key}" id="char-${item.key.replace(/[^a-zA-Z0-9_-]/g, "_")}">
            <label class="form-check-label small" for="char-${item.key.replace(/[^a-zA-Z0-9_-]/g, "_")}">${item.label}</label>
        </div>
    `).join("");
    menu.querySelectorAll(".enrichment-char-check").forEach((input) => {
        input.onchange = updateCharacteristicLabel;
    });
    // sensible defaults
    ["main_class", "LION.Category"].forEach((key) => {
        const el = menu.querySelector(`.enrichment-char-check[value="${key}"]`);
        if (el) el.checked = true;
    });
    updateCharacteristicLabel();
}

function swapEnrichmentMethodOptions() {
    const select = dom.enrichmentMethod();
    if (!select) return;
    const options = isLipidMode() ? LIPID_METHOD_OPTIONS : GENE_METHOD_OPTIONS;
    const prev = select.value;
    select.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    select.value = options.some((o) => o.value === prev) ? prev : options[0].value;
}

async function runLipidMappingPreflight() {
    const note = dom.enrichmentMappingNote();
    if (!note) return;
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) {
        note.style.display = "none";
        return;
    }
    lipidMappingStatus = null;
    note.style.display = "";
    note.innerHTML = `<div class="alert alert-secondary small mb-0"><i class="fa-solid fa-spinner fa-spin me-2"></i>Checking how many features map to lipid IDs…</div>`;
    try {
        const res = await fetch(`${vpsUrl}/lipidref/check-mapping`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_id: projectId, source_run_id: analysis.run_id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Mapping check failed.");
        lipidMappingStatus = data;
        const pct = Math.round((data.fraction || 0) * 100);
        if (!data.ok) {
            note.innerHTML = `<div class="alert alert-danger small mb-0">
                <i class="fa-solid fa-triangle-exclamation me-2"></i>
                Only <b>${data.mapped}/${data.total}</b> features (${pct}%) map to lipid IDs — at least 50% is required.
                Lipid enrichment is blocked. Fix feature names (lipid names) via the <b>ID Conversion</b> page first.<br>
                <span class="text-muted">Unmapped examples: ${(data.unmapped_examples || []).slice(0, 10).join(", ")}</span>
            </div>`;
        } else {
            note.innerHTML = `<div class="alert alert-${pct < 100 ? "warning" : "success"} small mb-0">
                <i class="fa-solid fa-circle-info me-2"></i>
                <b>${data.mapped}/${data.total}</b> features (${pct}%) map to lipid IDs.
                ${pct < 100 ? `Unmapped examples: ${(data.unmapped_examples || []).slice(0, 10).join(", ")}` : "All features mapped."}
            </div>`;
        }
    } catch (err) {
        console.error(err);
        note.innerHTML = `<div class="alert alert-warning small mb-0">Mapping pre-flight failed: ${err.message}</div>`;
    }
}

function updateEnrichmentMethodSections() {
    const lipid = isLipidMode();
    const isOra = isEnrichmentOraMethod();
    const featureSourceCol = dom.enrichmentFeatureSourceCol();
    const rankingMetricRow = dom.enrichmentRankingMetricRow();
    const rankPreviewSection = dom.enrichmentRankingPreviewSection();
    const oraPreviewSection = dom.enrichmentOraPreviewSection();
    const dbCol = dom.enrichmentDbCol();
    const charCol = dom.enrichmentCharCol();
    const inputTypeCol = dom.enrichmentInputTypeCol();
    const mappingNote = dom.enrichmentMappingNote();
    if (dbCol) dbCol.style.display = lipid ? "none" : "";
    if (charCol) charCol.style.display = lipid ? "" : "none";
    if (inputTypeCol && lipid) inputTypeCol.style.display = "none";  // identifier type is gene-only
    if (mappingNote) mappingNote.style.display = lipid ? "" : "none";
    if (featureSourceCol) featureSourceCol.style.display = isOra ? "" : "none";
    if (rankingMetricRow) {
        rankingMetricRow.style.display = isOra ? "none" : "";
        const metricInput = dom.enrichmentRankingMetric?.();
        if (metricInput) metricInput.value = lipid ? "log2FC (lipid LSEA)" : "sign(Log2FC) x -Log10FDR";
    }
    if (rankPreviewSection) rankPreviewSection.style.display = isOra ? "none" : "";
    if (oraPreviewSection) oraPreviewSection.style.display = isOra ? "" : "none";
    if (isOra) renderEnrichmentOraFeaturePreview();
    else renderEnrichmentRankingPreview();
}

function renderEnrichmentOraFeaturePreview() {
    const featureSource = dom.enrichmentFeatureSource()?.value || "all";
    const rows = (uniResultsGlobal || []).map((row) => {
        const feature = String(row.lipid || row.gene || row.feature || row.Lipid || row.Gene || row.Feature || "").trim();
        const logfc = Number(row.log2fc ?? row.Log2FC ?? row.log_fc ?? row.LogFC ?? 0);
        const fdr = Math.max(Number(row.fdr ?? row.FDR ?? 1), 1e-300);
        return { feature, logfc, fdr };
    }).filter((row) => {
        if (!row.feature) return false;
        if (featureSource === "up" && row.logfc <= 0) return false;
        if (featureSource === "down" && row.logfc >= 0) return false;
        return true;
    });
    const bodyEl = dom.enrichmentOraFeatureBody();
    if (!bodyEl) return;
    if (!rows.length) {
        bodyEl.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-3">No features match the selection.</td></tr>';
        return;
    }
    bodyEl.innerHTML = rows.slice(0, 50).map((row) => `
        <tr>
            <td class="text-start">${row.feature}</td>
            <td class="${row.logfc > 0 ? "text-danger" : "text-primary"}">${row.logfc.toFixed(4)}</td>
            <td>${row.fdr.toExponential(3)}</td>
        </tr>
    `).join("") + (rows.length > 50 ? `<tr><td colspan="3" class="text-center text-muted small py-1">...${rows.length - 50} more features</td></tr>` : "");
}

function initEnrichmentModal() {
    if (window.bootstrap) enrichmentModal = new window.bootstrap.Modal(dom.enrichmentModalEl());
    const methodSelect = dom.enrichmentMethod();
    if (methodSelect) {
        methodSelect.onchange = updateEnrichmentMethodSections;
    }
    const featureSourceSelect = dom.enrichmentFeatureSource();
    if (featureSourceSelect) {
        featureSourceSelect.onchange = () => {
            if (isEnrichmentOraMethod()) renderEnrichmentOraFeaturePreview();
        };
    }
    const moleculeSelect = dom.enrichmentMoleculeType();
    if (moleculeSelect) {
        moleculeSelect.onchange = async () => {
            if (isLipidMode()) {
                try {
                    await ensureLipidCharacteristicsLoaded();
                    renderEnrichmentCharacteristicMenu();
                } catch (err) {
                    console.error(err);
                    alert(err.message || "Unable to load lipid characteristics.");
                }
                runLipidMappingPreflight();
            }
            swapEnrichmentMethodOptions();
            updateEnrichmentMethodSections();
        };
    }
}

async function openEnrichmentModal() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis || !uniResultsGlobal.length) {
        alert("Load a DEA result first.");
        return;
    }
    await ensureEnrichmentDatabasesLoaded();
    renderEnrichmentDatabaseMenu();
    lipidMappingStatus = null;
    if (isLipidMode()) {
        try {
            await ensureLipidCharacteristicsLoaded();
            renderEnrichmentCharacteristicMenu();
        } catch (err) { console.error(err); }
        runLipidMappingPreflight();
    }
    updateEnrichmentMethodSections();
    dom.enrichmentName().value = `${analysis.name || "DEA"} | Enrichment ${new Date().toLocaleString()}`;
    dom.enrichmentModalSource().textContent = `${getAnalysisDisplayTarget(analysis) || "-"} | ${analysis.comparison || "-"}`;
    enrichmentModal?.show();
}

function buildEnrichmentHistoryQuery(item) {
    const sourceRun = item.source_run_id ? `&sourceRun=${encodeURIComponent(item.source_run_id)}` : "";
    return `enrichment.html?id=${encodeURIComponent(projectId)}&run=${encodeURIComponent(item.run_id)}${sourceRun}`;
}

function openInlineEnrichmentView(entry) {
    const url = buildEnrichmentHistoryQuery(entry);
    const titleText = entry.title || entry.run_id || "Enrichment Results";
    dom.enrichmentInlineTitle().textContent = titleText;

    // Show loading overlay
    const loading = dom.enrichmentInlineLoading();
    if (loading) {
        loading.style.display = "flex";
        const label = loading.querySelector(".small");
        if (label) label.textContent = "Loading enrichment…";
    }

    const frame = dom.enrichmentInlineFrame();
    frame.onload = null;
    frame.removeAttribute("srcdoc");
    frame.src = url;

    // Hide sidebar
    const sidebar = dom.sidebarPlaceholder();
    if (sidebar) sidebar.style.display = "none";

    dom.enrichmentInlineView().classList.add("open");
}

function closeInlineEnrichmentView() {
    // Restore sidebar
    const sidebar = dom.sidebarPlaceholder();
    if (sidebar) sidebar.style.display = "";

    dom.enrichmentInlineView().classList.remove("open");
    const frame = dom.enrichmentInlineFrame();
    frame.onload = null;
    frame.removeAttribute("srcdoc");
    frame.src = "";

    const loading = dom.enrichmentInlineLoading();
    if (loading) loading.style.display = "flex";
}

function renderEnrichmentHistory() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) {
        dom.enrichmentHistoryList().innerHTML = '<div class="enrichment-history-empty">Load a DEA result first to see related enrichment history.</div>';
        return;
    }
    const searchText = (dom.enrichmentHistorySearch().value || "").trim().toLowerCase();
    const visibleHistory = getCurrentEnrichmentEntries()
        .filter((item) => {
            const haystack = [item.title, item.comparison, getAnalysisDisplayTarget(item), item.status, item.message, ...(item.databases || [])].join(" ").toLowerCase();
            return !searchText || haystack.includes(searchText);
        });

    if (!visibleHistory.length) {
        dom.enrichmentHistoryList().innerHTML = '<div class="enrichment-history-empty">No enrichment history for this DEA yet.</div>';
        return;
    }
    dom.enrichmentHistoryList().innerHTML = visibleHistory.map((item) => `
        <div class="enrichment-history-item ${selectedEnrichmentRunId === item.run_id ? "active" : ""}" data-run-id="${item.run_id}" title="${escapeHtmlAttr(buildEnrichmentTooltip(item))}">
            <div class="d-flex justify-content-between align-items-start gap-2">
                <div>
                    <div class="d-flex align-items-center gap-2 flex-wrap">
                        <div class="enrichment-history-title">${item.title || "Untitled enrichment"}</div>
                        ${getEnrichmentStatusBadge(item.status)}
                    </div>
                    <div class="enrichment-history-meta">${formatTaskId(item) || "No ID"}</div>
                    <div class="enrichment-history-meta">${item.comparison || "-"}</div>
                    <div class="enrichment-history-meta">${(item.databases || []).join(", ") || "-"}</div>
                    <div class="enrichment-history-meta">${item.message || (item.status === "done" ? "Ready to open." : item.status === "running" ? "Enrichment is still running..." : item.status === "pending" ? "Queued for processing..." : "Run failed.")}</div>
                </div>
                <div class="text-end d-flex flex-column align-items-end gap-2">
                    <div class="enrichment-history-meta">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
                    <div class="enrichment-history-meta">${item.term_count || 0} terms</div>
                    ${canDeleteEnrichmentEntry(item) ? `
                        <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2 enrichment-history-delete" data-run-id="${item.run_id}" title="Delete this enrichment run">
                            <i class="fa-solid fa-trash-can me-1"></i>
                        </button>
                    ` : ""}
                </div>
            </div>
        </div>
    `).join("");

    dom.enrichmentHistoryList().querySelectorAll(".enrichment-history-item").forEach((node) => {
        node.onclick = () => {
            const runId = node.dataset.runId;
            const entry = visibleHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            selectedEnrichmentRunId = runId;
            renderEnrichmentHistory();
            if (entry.status === "error") {
                alert(entry.message || "Enrichment run failed.");
                return;
            }
            if (entry.status !== "done") return;
            openInlineEnrichmentView(entry);
        };
    });

    dom.enrichmentHistoryList().querySelectorAll(".enrichment-history-delete").forEach((button) => {
        button.onclick = async (event) => {
            event.stopPropagation();
            const runId = button.dataset.runId;
            const entry = visibleHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            if (!confirm(`Delete enrichment run "${entry.title || runId}"?`)) return;
            await deleteEnrichmentHistoryEntry(entry);
        };
    });
}

async function deleteEnrichmentHistoryEntry(entry) {
    if (!entry?.run_id) return;

    if (entry.status === "pending" || entry.status === "running") {
        alert("This enrichment run is still processing and cannot be deleted yet.");
        return;
    }

    const urlsToDelete = [entry.csv_url, entry.data_url, entry.metaPathOverride || entry.meta_path_override].filter(Boolean);
    await deleteStorageArtifacts(urlsToDelete);

    enrichmentHistory = deduplicateEnrichmentHistory(
        enrichmentHistory.filter((item) => item.run_id !== entry.run_id)
    );

    const currentTask = projectData?.ttest_enrichment_task || null;
    const nextTask = currentTask?.run_id === entry.run_id ? null : currentTask;

    await updateDoc(doc(db, "projects", projectId), {
        ttest_enrichment_history: enrichmentHistory,
        ttest_enrichment_task: nextTask,
    });

    projectData = {
        ...projectData,
        ttest_enrichment_history: enrichmentHistory,
        ttest_enrichment_task: nextTask,
    };

    if (selectedEnrichmentRunId === entry.run_id) {
        selectedEnrichmentRunId = null;
    }

    renderEnrichmentHistory();
}

async function runEnrichmentAnalysis() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) {
        alert("Load a DEA result first.");
        return;
    }
    const lipid = isLipidMode();
    const databases = lipid ? getSelectedCharacteristics() : getSelectedEnrichmentDatabases();
    if (!databases.length) {
        alert(lipid ? "Select at least one lipid characteristic." : "Select at least one database.");
        return;
    }
    const runName = dom.enrichmentName().value.trim();
    if (!runName) {
        alert("Please enter a run name.");
        return;
    }

    if (lipid) {
        // Hard gate: mirror the backend rule (>50 % unmappable ⇒ blocked).
        if (!lipidMappingStatus) await runLipidMappingPreflight();
        if (lipidMappingStatus && !lipidMappingStatus.ok) {
            alert(
                `Only ${lipidMappingStatus.mapped}/${lipidMappingStatus.total} features ` +
                `(${Math.round((lipidMappingStatus.fraction || 0) * 100)}%) map to lipid IDs. ` +
                "Lipid enrichment requires at least 50% mappable features — fix names via the ID Conversion page first."
            );
            return;
        }
        if (lipidMappingStatus && lipidMappingStatus.fraction < 1) {
            const pct = Math.round((lipidMappingStatus.fraction || 0) * 100);
            if (!confirm(`${lipidMappingStatus.mapped}/${lipidMappingStatus.total} features (${pct}%) map to lipid IDs. Unmapped features are excluded from lipid enrichment. Continue?`)) {
                return;
            }
        }
    }

    const isOra = isEnrichmentOraMethod();
    const originalLabel = dom.runEnrichmentBtn().innerHTML;
    dom.runEnrichmentBtn().disabled = true;
    dom.runEnrichmentBtn().innerHTML = '<i class="fa-solid fa-sync fa-spin me-2"></i>Running...';
    try {
        const inputType = lipid ? "Lipid" : getEnrichmentInputType();
        const method = isOra ? "ORA" : (dom.enrichmentMethod()?.value || "GSEA");
        const featureSource = isOra ? (dom.enrichmentFeatureSource()?.value || "all") : null;

        const queuedTask = {
            run_id: null,
            task_id: null,
            title: runName,
            source_run_id: analysis.run_id,
            source_name: analysis.name || "DAL",
            target: getAnalysisDisplayTarget(analysis),
            comparison: analysis.comparison,
            method,
            ranking_metric: isOra ? null : dom.enrichmentRankingMetric().value,
            databases,
            input_type: inputType,
            status: "pending",
            message: "Queued for enrichment processing.",
            started_at: new Date().toISOString(),
        };
        projectData = { ...projectData, ttest_enrichment_task: queuedTask };
        renderEnrichmentHistory();

        const endpoint = lipid
            ? `${vpsUrl}/ttest/enrichment/run-lipid`
            : isOra ? `${vpsUrl}/ttest/enrichment/run-ora` : `${vpsUrl}/ttest/enrichment/run`;
        const settingsPayload = lipid
            ? {
                source_run_id: analysis.run_id,
                title: runName,
                target_meta: getAnalysisDisplayTarget(analysis),
                comparison: analysis.comparison,
                input_type: "Lipid",
                method,                                   // LSEA | ORA
                characteristics: databases,               // selected lipid characteristics
                feature_source: isOra ? featureSource : "all",
                rank_by: "log2fc",
                significant: "fdr",
                p_cutoff: 0.05,
            }
            : isOra
            ? {
                source_run_id: analysis.run_id,
                title: runName,
                target_meta: getAnalysisDisplayTarget(analysis),
                comparison: analysis.comparison,
                databases,
                input_type: inputType,
                method: "ORA",
                feature_source: featureSource,
            }
            : {
                source_run_id: analysis.run_id,
                title: runName,
                target_meta: getAnalysisDisplayTarget(analysis),
                comparison: analysis.comparison,
                databases,
                input_type: inputType,
                method: dom.enrichmentMethod()?.value || "GSEA",
                ranking_metric: dom.enrichmentRankingMetric().value
            };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                settings: settingsPayload
            })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || payload.message || "Enrichment run failed.");
        selectedEnrichmentRunId = payload.run_id || null;
        projectData = {
            ...projectData,
            ttest_enrichment_task: {
                ...queuedTask,
                run_id: payload.run_id || null,
                task_id: payload.task_id ?? null,
                status: "pending",
                message: "Queued for enrichment processing.",
            },
        };
        renderEnrichmentHistory();
        enrichmentModal?.hide();
    } catch (error) {
        projectData = {
            ...projectData,
            ttest_enrichment_task: {
                ...(projectData?.ttest_enrichment_task || {}),
                status: "error",
                message: error.message || String(error),
                completed_at: new Date().toISOString(),
            },
        };
        renderEnrichmentHistory();
        console.error("Enrichment run error:", error);
        alert(error.message || String(error));
    } finally {
        dom.runEnrichmentBtn().disabled = false;
        dom.runEnrichmentBtn().innerHTML = originalLabel;
    }
}

function getNetworkTypeLabel(type) {
    if (type === "gatom") return "GATOM Network";
    if (type === "lipid_reaction") return "Lipid Reaction Network";
    return "Pathway Activity Network";
}

function buildNetworkTaskEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        title: task.title || "Untitled network",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        source_run_id: task.source_run_id || null,
        target: task.target || null,
        comparison: task.comparison || null,
        network_type: task.network_type || "pathway",
        organism: task.organism || "human",
        ref_group: task.ref_group || null,
        node_count: task.node_count || 0,
        edge_count: task.edge_count || 0,
        html_url: task.html_url || null,
        message: task.message || "",
        status: normalizeEnrichmentStatus(task.status),
        isTask: true,
    };
}

function getCurrentNetworkEntries() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) return [];

    const historyItems = deduplicateEnrichmentHistory(networkHistory)
        .filter((item) => item.source_run_id === analysis.run_id);

    const taskEntry = buildNetworkTaskEntry(projectData?.network_task || null);
    if (!taskEntry || taskEntry.source_run_id !== analysis.run_id) {
        return historyItems;
    }

    const combined = taskEntry.status === "done"
        ? [...historyItems, taskEntry]
        : [taskEntry, ...historyItems];

    return deduplicateEnrichmentHistory(combined);
}

function syncNetworkTaskState(task) {
    const entry = buildNetworkTaskEntry(task);
    if (entry?.run_id) selectedNetworkRunId = entry.run_id;
    renderNetworkHistory();
}

function initNetworkModal() {
    if (window.bootstrap) networkModal = new window.bootstrap.Modal(dom.networkModalEl());
    const typeSelect = dom.networkType();
    if (typeSelect) {
        typeSelect.onchange = () => {
            const gatom = typeSelect.value === "gatom";
            dom.networkNLipidCol().classList.toggle("d-none", !gatom);
        };
        typeSelect.onchange();
    }
}

function fillNetworkRefGroupOptions(analysis) {
    const select = dom.networkRefGroup();
    const groups = parseComparisonGroups(analysis?.comparison);
    if (groups.length !== 2) {
        select.innerHTML = `<option value="">${escapeHtmlAttr(analysis?.comparison || "No comparison")}</option>`;
        return;
    }
    const map = analysis.display_group_map || {};
    select.innerHTML = groups
        .map((group) => `<option value="${escapeHtmlAttr(group)}">${escapeHtmlAttr(map[group] || group)} (reference)</option>`)
        .join("");
    // group2 is the reference: the DE table computes log2FC as group1 - group2.
    select.value = groups[1];
}

async function openNetworkModal() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis || !uniResultsGlobal.length) {
        alert("Load a DEA result first.");
        return;
    }
    dom.networkModalError().textContent = "";
    dom.runNetworkBtn().disabled = false;
    fillNetworkRefGroupOptions(analysis);
    dom.networkName().value = `${analysis.name || "DEA"} | ${getNetworkTypeLabel(dom.networkType().value)} ${new Date().toLocaleString()}`;
    dom.networkModalSource().textContent = `${getAnalysisDisplayTarget(analysis) || "-"} | ${getAnalysisDisplayComparison(analysis) || analysis.comparison || "-"}`;
    networkModal?.show();

    try {
        const response = await fetch(`${vpsUrl}/network/availability`);
        const payload = await response.json();
        if (!payload.available) {
            dom.networkModalError().textContent = "R/LipidSigR was not found on this server, so networks cannot run. Set RSCRIPT_PATH on the backend and restart.";
            dom.runNetworkBtn().disabled = true;
        }
    } catch (error) {
        dom.networkModalError().textContent = error.message || "Unable to check R availability on the server.";
    }
}

function openInlineNetworkView(entry) {
    const titleText = entry.title || entry.run_id || "Network";
    dom.enrichmentInlineTitle().textContent = titleText;

    const loading = dom.enrichmentInlineLoading();
    if (loading) {
        loading.style.display = "flex";
        const label = loading.querySelector(".small");
        if (label) label.textContent = "Loading network…";
    }

    const frame = dom.enrichmentInlineFrame();
    frame.onload = null;
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";

    const sidebar = dom.sidebarPlaceholder();
    if (sidebar) sidebar.style.display = "none";
    dom.enrichmentInlineView().classList.add("open");

    (async () => {
        try {
            if (!entry.html_url) throw new Error("This network run has no stored HTML report.");
            const fullUrl = entry.html_url.startsWith("http") ? entry.html_url : `${vpsUrl}${entry.html_url}`;
            // /files is auth-gated by the HttpOnly session cookie.
            const response = await fetch(fullUrl, { credentials: "include" });
            if (!response.ok) throw new Error(`Failed to load the network report (HTTP ${response.status}).`);
            const html = await response.text();
            frame.onload = () => {
                if (loading) loading.style.display = "none";
            };
            frame.srcdoc = html;
        } catch (error) {
            frame.srcdoc = `<div style="font-family:system-ui,sans-serif;padding:24px;color:#b42318">${escapeHtmlAttr(error.message || "Failed to load the network report.")}</div>`;
            if (loading) loading.style.display = "none";
        }
    })();
}

function renderNetworkHistory() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) {
        dom.networkHistoryList().innerHTML = '<div class="enrichment-history-empty">Load a DEA result first to see related network history.</div>';
        return;
    }
    const searchText = (dom.networkHistorySearch().value || "").trim().toLowerCase();
    const visibleHistory = getCurrentNetworkEntries().filter((item) => {
        const haystack = [item.title, item.comparison, getNetworkTypeLabel(item.network_type), item.organism, item.status, item.message]
            .join(" ").toLowerCase();
        return !searchText || haystack.includes(searchText);
    });

    if (!visibleHistory.length) {
        dom.networkHistoryList().innerHTML = '<div class="enrichment-history-empty">No network history for this DEA yet.</div>';
        return;
    }
    dom.networkHistoryList().innerHTML = visibleHistory.map((item) => `
        <div class="enrichment-history-item ${selectedNetworkRunId === item.run_id ? "active" : ""}" data-run-id="${item.run_id}">
            <div class="d-flex justify-content-between align-items-start gap-2">
                <div>
                    <div class="d-flex align-items-center gap-2 flex-wrap">
                        <div class="enrichment-history-title">${item.title || "Untitled network"}</div>
                        ${getEnrichmentStatusBadge(item.status)}
                    </div>
                    <div class="enrichment-history-meta">${formatTaskId(item) || "No ID"}</div>
                    <div class="enrichment-history-meta">${item.comparison || "-"}</div>
                    <div class="enrichment-history-meta">${getNetworkTypeLabel(item.network_type)} | ${item.organism || "human"}${item.ref_group ? ` | ref ${item.ref_group}` : ""}</div>
                    <div class="enrichment-history-meta">${item.message || (item.status === "done" ? "Ready to open." : item.status === "running" ? "Network is still running..." : item.status === "pending" ? "Queued for processing..." : "Run failed.")}</div>
                </div>
                <div class="text-end d-flex flex-column align-items-end gap-2">
                    <div class="enrichment-history-meta">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
                    <div class="enrichment-history-meta">${item.node_count || 0} nodes | ${item.edge_count || 0} edges</div>
                    ${canDeleteEnrichmentEntry(item) ? `
                        <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2 network-history-delete" data-run-id="${item.run_id}" title="Delete this network run">
                            <i class="fa-solid fa-trash-can me-1"></i>
                        </button>
                    ` : ""}
                </div>
            </div>
        </div>
    `).join("");

    dom.networkHistoryList().querySelectorAll(".enrichment-history-item").forEach((node) => {
        node.onclick = () => {
            const runId = node.dataset.runId;
            const entry = visibleHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            selectedNetworkRunId = runId;
            renderNetworkHistory();
            if (entry.status === "error") {
                alert(entry.message || "Network run failed.");
                return;
            }
            if (entry.status !== "done") return;
            openInlineNetworkView(entry);
        };
    });

    dom.networkHistoryList().querySelectorAll(".network-history-delete").forEach((button) => {
        button.onclick = async (event) => {
            event.stopPropagation();
            const runId = button.dataset.runId;
            const entry = visibleHistory.find((item) => item.run_id === runId);
            if (!entry) return;
            if (!confirm(`Delete network run "${entry.title || runId}"?`)) return;
            await deleteNetworkHistoryEntry(entry);
        };
    });
}

async function deleteNetworkHistoryEntry(entry) {
    if (!entry?.run_id) return;
    if (entry.status === "pending" || entry.status === "running") {
        alert("This network run is still processing and cannot be deleted yet.");
        return;
    }

    await deleteStorageArtifacts([entry.html_url]);

    networkHistory = deduplicateEnrichmentHistory(
        networkHistory.filter((item) => item.run_id !== entry.run_id)
    );

    const currentTask = projectData?.network_task || null;
    const nextTask = currentTask?.run_id === entry.run_id ? null : currentTask;

    await updateDoc(doc(db, "projects", projectId), {
        network_history: networkHistory,
        network_task: nextTask,
    });

    projectData = {
        ...projectData,
        network_history: networkHistory,
        network_task: nextTask,
    };

    if (selectedNetworkRunId === entry.run_id) {
        selectedNetworkRunId = null;
    }

    renderNetworkHistory();
}

async function runNetworkAnalysis() {
    const analysis = getCurrentAnalysisEntry();
    if (!analysis?.run_id) {
        alert("Load a DEA result first.");
        return;
    }
    const networkType = dom.networkType().value;
    const refGroup = dom.networkRefGroup().value;
    const runName = dom.networkName().value.trim();
    const nLipid = Number(dom.networkNLipid().value);
    const pCutoff = Number(dom.networkPCutoff().value);
    const fcCutoff = Number(dom.networkFcCutoff().value);

    if (!refGroup) {
        alert("Select the control (reference) group.");
        return;
    }
    if (!runName) {
        alert("Please enter a run name.");
        return;
    }
    if (!Number.isInteger(nLipid) || nLipid < 2) {
        alert("n_lipid must be an integer of at least 2.");
        return;
    }
    if (!(pCutoff > 0 && pCutoff <= 1)) {
        alert("P cutoff must be greater than 0 and at most 1.");
        return;
    }
    if (!(fcCutoff > 0)) {
        alert("Fold change cutoff must be greater than 0.");
        return;
    }
    if (networkType !== "pathway" && fcCutoff < 1) {
        alert("Fold change cutoff must be at least 1 for GATOM and lipid reaction networks.");
        return;
    }

    // LipidSigR works on raw positive abundances (class-level means), so prefer
    // the checked matrix over the log-transformed normalized matrix.
    const matrixPath = projectData?.matrixCheckedPath || projectData?.matrixPreScalePath || projectData?.matrixNormPath || null;
    const metaPath = analysis.meta_path_override || projectData?.metaCheckedPath || null;
    if (!matrixPath || !metaPath) {
        alert("Project is missing a checked matrix or metadata path.");
        return;
    }

    const originalLabel = dom.runNetworkBtn().innerHTML;
    dom.runNetworkBtn().disabled = true;
    dom.runNetworkBtn().innerHTML = '<i class="fa-solid fa-sync fa-spin me-2"></i>Running...';
    dom.networkModalError().textContent = "";

    try {
        const queuedTask = {
            run_id: null,
            task_id: null,
            title: runName,
            source_run_id: analysis.run_id,
            target: getAnalysisDisplayTarget(analysis),
            comparison: analysis.comparison,
            network_type: networkType,
            organism: dom.networkOrganism().value,
            ref_group: refGroup,
            status: "pending",
            message: "Queued for network processing.",
            started_at: new Date().toISOString(),
        };
        projectData = { ...projectData, network_task: queuedTask };
        renderNetworkHistory();

        const response = await fetch(`${vpsUrl}/network/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
            body: JSON.stringify({
                project_id: projectId,
                settings: {
                    source_run_id: analysis.run_id,
                    title: runName,
                    target_meta: getAnalysisDisplayTarget(analysis),
                    group_column: analysis.target || "group",
                    comparison: analysis.comparison,
                    network_type: networkType,
                    organism: dom.networkOrganism().value,
                    ref_group: refGroup,
                    n_lipid: nLipid,
                    p_cutoff: pCutoff,
                    fc_cutoff: fcCutoff,
                    matrix_path: matrixPath,
                    meta_path: metaPath,
                },
            }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || payload.message || "Network run failed.");

        selectedNetworkRunId = payload.run_id || null;
        projectData = {
            ...projectData,
            network_task: {
                ...queuedTask,
                run_id: payload.run_id || null,
                task_id: payload.task_id ?? null,
                status: "pending",
                message: "Queued for network processing.",
            },
        };
        renderNetworkHistory();
        networkModal?.hide();
    } catch (error) {
        projectData = {
            ...projectData,
            network_task: {
                ...(projectData?.network_task || {}),
                status: "error",
                message: error.message || String(error),
                completed_at: new Date().toISOString(),
            },
        };
        renderNetworkHistory();
        console.error("Network run error:", error);
        dom.networkModalError().textContent = error.message || String(error);
    } finally {
        dom.runNetworkBtn().disabled = false;
        dom.runNetworkBtn().innerHTML = originalLabel;
    }
}

async function renderSelectedViolinPlots() {
    const lipids = Array.from(selectedLipids);
    if (!lipids.length) {
        renderViolinEmpty("Select features from the table to load violin plots.");
        return;
    }
    const { target, comparison } = currentAnalysisContext;
    if (!target || !comparison) {
        renderViolinEmpty("Load an analysis result first, then select features.");
        return;
    }
    const requestId = ++currentViolinRequestId;
    dom.violinGrid().innerHTML = lipids.map((lipid, index) => `
        <div class="violin-item" data-lipid="${lipid}">
            <div class="violin-item-title">${index + 1}. ${lipid}</div>
            <div id="violin-plot-${index}" class="violin-plot d-flex align-items-center justify-content-center text-muted small">Loading...</div>
        </div>
    `).join("");

    await Promise.all(lipids.map(async (lipid, index) => {
        const container = document.getElementById(`violin-plot-${index}`);
        if (!container) return;
        try {
            const trend = await fetchViolinData(lipid, target, comparison, currentAnalysisContext.metaPathOverride || null);
            if (requestId !== currentViolinRequestId) return;
            container.className = "violin-plot";
            container.textContent = "";
            renderSingleViolinPlot(container, trend);
        } catch (error) {
            if (requestId !== currentViolinRequestId) return;
            container.className = "violin-plot d-flex align-items-center justify-content-center text-danger small";
            container.textContent = error.message || String(error);
        }
    }));
}

async function runUnivariateAnalysis() {
    if (isRunCoolingDown()) return;

    currentRunId = null;
    const paired = dom.pairedMode().checked;
    const pairIdCol = dom.pairIdCol().value;
    const analysisName = dom.analysisName().value.trim() || `Analysis ${new Date().toLocaleString()}`;
    let target = null;
    let comparison = null;
    let metaPath = projectData.metaCheckedPath;
    let displayTarget = null;
    let splitContext = null;

    if (splitState.mode === "split") {
        try {
            const splitSource = await buildSplitMetaSource();
            target = splitSource.target;
            comparison = splitSource.comparison;
            metaPath = splitSource.metaPathOverride;
            displayTarget = splitSource.displayTarget;
            splitContext = {
                input_mode: "split",
                display_target: splitSource.displayTarget,
                display_comparison: splitSource.displayComparison,
                meta_path_override: splitSource.metaPathOverride,
                backend_target: splitSource.target,
                backend_comparison: splitSource.comparison,
                split_config: splitSource.splitConfig,
                persisted: false,
            };
        } catch (error) {
            setRunBusy(false, error.message || String(error), true);
            return;
        }
    } else {
        const selectedComp = document.querySelector(".comp-check:checked");
        if (!selectedComp) return;
        try {
            const manualSource = await buildManualMetaSource(dom.target().value, selectedComp.value);
            target = manualSource.target;
            comparison = manualSource.comparison;
            metaPath = manualSource.metaPathOverride;
            displayTarget = manualSource.displayTarget;
            splitContext = {
                input_mode: "manual-derived",
                target: manualSource.manualTarget,
                manual_target: manualSource.manualTarget,
                comparison: manualSource.manualComparison,
                manual_comparison: manualSource.manualComparison,
                display_target: manualSource.displayTarget,
                display_comparison: manualSource.displayComparison,
                display_group_map: manualSource.displayGroupMap,
                meta_path_override: manualSource.metaPathOverride,
                backend_target: manualSource.target,
                backend_comparison: manualSource.comparison,
                persisted: false,
            };
        } catch (error) {
            setRunBusy(false, error.message || String(error), true);
            return;
        }
    }

    setAnalysisContext(target, comparison, {
        displayTarget,
        displayComparison: splitContext?.display_comparison || comparison,
        displayGroupMap: splitContext?.display_group_map || null,
        metaPathOverride: metaPath !== projectData.metaCheckedPath ? metaPath : null,
    });
    setSplitWorkspaceVisible(false);
    setResultsLoading("Waiting for result...");
    dom.historyPopup().classList.remove("open");
    setRunBusy(true, "Submitting task...");
    startRunCooldown();

    try {
        const response = await fetch(`${vpsUrl}/biomarker-univariate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                matrix_path: projectData.matrixPreScalePath || projectData.matrixNormPath,
                meta_path: metaPath,
                settings: {
                    analysis_name: analysisName,
                    target_meta: target,
                    comparison,
                    paired,
                    pair_id_col: paired ? pairIdCol : null,
                    log_base: 2,
                    test_type: dom.testType()?.value || "auto"
                }
            })
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || payload.message || "Failed to start analysis.");
        }

        currentRunId = payload.run_id || currentRunId;
        selectedHistoryRunId = payload.run_id || null;
        if (splitContext && payload.run_id) {
            splitRunContext.set(payload.run_id, splitContext);
        }
        analysisHistory = deduplicateHistory([
            {
                run_id: payload.run_id || null,
                task_id: payload.task_id ?? null,
                name: analysisName,
                date: new Date().toISOString(),
                target: splitContext?.target || target,
                display_target: displayTarget,
                comparison: splitContext?.comparison || comparison,
                display_comparison: splitContext?.display_comparison || comparison,
                paired,
                pair_id_col: paired ? pairIdCol : null,
                status: "pending",
                message: "Queued for processing.",
                ...(splitContext ? {
                    input_mode: splitContext.input_mode,
                    meta_path_override: splitContext.meta_path_override,
                    backend_target: splitContext.backend_target,
                    backend_comparison: splitContext.backend_comparison,
                    display_group_map: splitContext.display_group_map,
                    manual_target: splitContext.manual_target,
                    manual_comparison: splitContext.manual_comparison,
                    split_config: splitContext.split_config,
                } : {}),
            },
            ...analysisHistory.filter((item) => item.run_id !== payload.run_id),
        ]);
        renderAnalysisHistoryPopup();
        dom.historyPopup().classList.add("open");
        dom.historyToggle()?.scrollIntoView({ behavior: "smooth", block: "center" });
        setRunBusy(true, `${analysisName} is pending...`);
    } catch (error) {
        currentRunId = null;
        setRunBusy(false, error.message || String(error), true);
        console.error("Analysis run error:", error);
    }
}

async function loadAnalysisResults(analysis, options = {}) {
    analysis = decorateAnalysisEntry(analysis);
    selectedHistoryRunId = analysis?.run_id || null;
    selectedEnrichmentRunId = null;
    setResultsLoading("Loading...");
    try {
        uniResultsGlobal = await ensureAnalysisResultsLoaded(analysis);
    } catch (error) {
        uniResultsGlobal = [];
        setRunStatus(error.message || "Unable to load DEA result.", true);
        dom.tableBody().innerHTML = `<tr><td colspan="4" class="text-danger py-3">${error.message || "Unable to load DEA result."}</td></tr>`;
        return;
    }
    currentCsvUrl = analysis.csv_url || null;
    currentResultsUrl = analysis.results_url || analysis.data_url || null;
    selectedLipids.clear();
    setAnalysisContext(analysis.backend_target || analysis.target || null, analysis.backend_comparison || analysis.comparison || null, {
        displayTarget: getAnalysisDisplayTarget(analysis),
        displayComparison: getAnalysisDisplayComparison(analysis),
        displayGroupMap: analysis.display_group_map || null,
        metaPathOverride: analysis.meta_path_override || null,
    });

    showResults();
    renderUnivariateTable(uniResultsGlobal);
    updateNormalityInfoFromResults(uniResultsGlobal);
    renderViolinEmpty("Select features from the table to load violin plots.");
    setTimeout(() => renderVolcanoPlot(uniResultsGlobal), 50);
    setActiveResultsTab(["enrichment", "network"].includes(options.preferredTab) ? options.preferredTab : "overview");
    renderEnrichmentHistory();
    renderNetworkHistory();

    dom.analysisName().value = analysis.name || "";
    if (analysis.input_mode === "split" && analysis.split_config) {
        pendingSplitHistorySnapshot = analysis.split_config;
        splitEngine?.reset();
        setConfigMode("manual");
    } else if (analysis.target) {
        pendingSplitHistorySnapshot = null;
        splitEngine?.reset();
        setConfigMode("manual");
        dom.target().value = analysis.manual_target || analysis.target;
        renderComparisonPairs();
        const radio = [...document.querySelectorAll(".comp-check")].find((item) => item.value === (analysis.manual_comparison || analysis.comparison));
        if (radio) radio.checked = true;
    } else {
        pendingSplitHistorySnapshot = null;
        splitEngine?.reset();
        setConfigMode("manual");
    }
    dom.pairedMode().checked = !!analysis.paired;
    dom.pairIdCol().disabled = !dom.pairedMode().checked;
    if (analysis.pair_id_col) dom.pairIdCol().value = analysis.pair_id_col;
    validateForm();
}

function showResults() {
    if (splitWorkspaceVisible) {
        splitWorkspaceVisible = false;
        dom.splitWorkspace()?.classList.add("d-none");
    }
    dom.resultsContainer().classList.remove("d-none");
    updateEnrichmentAvailability();
}

function renderUnivariateTable(results) {
    const sortVal = dom.sortFilter().value;
    const maxFdr = Math.min(1, Math.max(0, Number(dom.minFilter().value) || 0.05));
    const fcThreshold = Math.max(0, Number(dom.fcThresholdInput()?.value) || 0);
    const searchText = dom.searchInput().value.trim().toLowerCase();
    let data = [...(results || [])];
    if (sortVal === "fdr_asc") data.sort((left, right) => left.fdr - right.fdr);
    else if (sortVal === "fc_desc") data.sort((left, right) => right.log2fc - left.log2fc);
    else if (sortVal === "fc_asc") data.sort((left, right) => left.log2fc - right.log2fc);
    else if (sortVal === "abs_fc_desc") data.sort((left, right) => Math.abs(right.log2fc) - Math.abs(left.log2fc));
    data = data.filter((row) => {
        const passFdr = Number(row.fdr) <= maxFdr;
        const passFc = fcThreshold <= 0 || Math.abs(Number(row.log2fc)) >= fcThreshold;
        const passSearch = !searchText || String(row.lipid || "").toLowerCase().includes(searchText);
        return passFdr && passFc && passSearch;
    });
    dom.rowCount().innerText = `${data.length} rows`;

    if (!data.length) {
        dom.tableBody().innerHTML = '<tr><td colspan="4" class="text-muted py-3">No features match current filter.</td></tr>';
        return;
    }
    dom.tableBody().innerHTML = data.map((row) => `
        <tr style="cursor:pointer;" data-lipid="${row.lipid}" class="${selectedLipids.has(row.lipid) ? "table-active" : ""}">
            <td><input type="checkbox" class="lipid-label-check" value="${row.lipid}" ${selectedLipids.has(row.lipid) ? "checked" : ""}></td>
            <td class="text-start fw-bold">${row.lipid}</td>
            <td class="${row.log2fc > 0 ? "text-danger" : "text-primary"}">${Number(row.log2fc).toFixed(2)}</td>
            <td>${Number(row.fdr).toFixed(3)}</td>
        </tr>
    `).join("");

    dom.tableBody().querySelectorAll("tr").forEach((row) => {
        row.onclick = async (event) => {
            if (event.target.type === "checkbox") return;
            const checkbox = row.querySelector(".lipid-label-check");
            checkbox.checked = !checkbox.checked;
            if (checkbox.checked) selectedLipids.add(checkbox.value);
            else selectedLipids.delete(checkbox.value);
            await refreshSelectionViews(checkbox.value);
        };
    });
    dom.tableBody().querySelectorAll(".lipid-label-check").forEach((checkbox) => {
        checkbox.onchange = async () => {
            if (checkbox.checked) selectedLipids.add(checkbox.value);
            else selectedLipids.delete(checkbox.value);
            await refreshSelectionViews(checkbox.value);
        };
    });
}

function buildVolcanoAnnotations() {
    const safeResults = Array.isArray(uniResultsGlobal) ? uniResultsGlobal : [];
    return safeResults
        .filter((row) => selectedLipids.has(row.lipid))
        .map((row) => {
            const yVal = -Math.log10(Math.max(row.fdr, 1e-300));
            const saved = volcanoLabelPositions.get(row.lipid);
            return {
                // Arrowhead tip: always locked to the data point
                x: row.log2fc,
                y: yVal,
                xref: "x", yref: "y",
                // Text box: absolute data coordinates — user drags this part
                ax: saved ? saved.ax : row.log2fc,
                ay: saved ? saved.ay : yVal + 0.6,
                axref: "x", ayref: "y",
                text: row.lipid,
                showarrow: true,
                arrowhead: 2,
                arrowsize: 1,
                arrowwidth: 1,
                arrowcolor: "#000000",
                font: { size: 11, color: "#000000" },
                bgcolor: "rgba(255, 255, 255, 0.8)",
                borderpad: 2,
            };
        });
}

function updateVolcanoLabelsOnly() {
    const volcanoEl = dom.volcano();
    if (!volcanoEl || !volcanoEl.data || volcanoEl.data.length < 3) {
        renderVolcanoPlot(uniResultsGlobal);
        return;
    }
    Plotly.relayout(volcanoEl, { annotations: buildVolcanoAnnotations() });
}

function renderVolcanoPlot(results, { preserveRanges = false } = {}) {
    const safeResults = Array.isArray(results) ? results : [];
    const nextDisplayComparison = currentAnalysisContext.displayComparison || currentAnalysisContext.comparison || "";
    const fcThreshold = Math.max(0, Number(document.getElementById("res-fc-threshold")?.value) || 0.5);
    const fdrThreshold = Math.min(1, Math.max(0, Number(dom.minFilter()?.value) || 0.05));
    const volcanoEl = dom.volcano();
    const savedRanges = preserveRanges ? (() => {
        const xRange = volcanoEl?.layout?.xaxis?.range;
        const yRange = volcanoEl?.layout?.yaxis?.range;
        if (!Array.isArray(xRange) || !Array.isArray(yRange) || xRange.length !== 2 || yRange.length !== 2) return null;
        return { xRange: [...xRange], yRange: [...yRange] };
    })() : null;
    const traceMarkers = (data, name, color, opacity) => ({
        x: data.map((row) => row.log2fc),
        y: data.map((row) => -Math.log10(Math.max(row.fdr, 1e-300))),
        customdata: data.map((row) => row.lipid),
        mode: "markers",
        name,
        marker: { color, size: volcanoPlotConfig.markerSize, opacity, line: { color: "white", width: 0.5 } },
        hoverinfo: "text",
        hovertext: data.map((row) => `${row.lipid}<br>Log2FC: ${Number(row.log2fc).toFixed(2)}<br>FDR: ${Number(row.fdr).toExponential(2)}`),
        legendgroup: name,
    });
    const up = safeResults.filter((row) => row.fdr < fdrThreshold && row.log2fc > fcThreshold);
    const down = safeResults.filter((row) => row.fdr < fdrThreshold && row.log2fc < -fcThreshold);
    const ns = safeResults.filter((row) => row.fdr >= fdrThreshold || Math.abs(row.log2fc) <= fcThreshold);
    if (typeof volcanoEl.removeAllListeners === "function") {
        volcanoEl.removeAllListeners("plotly_click");
        volcanoEl.removeAllListeners("plotly_relayout");
    }
    Plotly.newPlot(volcanoEl, [
        traceMarkers(ns, "N.S", "#989898", 0.5),
        traceMarkers(up, "Up", "#ff000d", volcanoPlotConfig.markerOpacity),
        traceMarkers(down, "Down", "#000dff", volcanoPlotConfig.markerOpacity),
    ], {
        title: {
            text: `<b>${escapeHtmlAttr(nextDisplayComparison || "")}</b>`,
            x: 0.5,
            xanchor: "center",
            yanchor: "top",
            font: { size: volcanoPlotConfig.axisFontSize },
        },
        xaxis: { title: "Log(Fold Change)", titlefont: { size: volcanoPlotConfig.axisFontSize }, tickfont: { size: volcanoPlotConfig.axisFontSize }, ...(savedRanges ? { autorange: false, range: savedRanges.xRange } : {}) },
        yaxis: { title: "-Log10(FDR)", titlefont: { size: volcanoPlotConfig.axisFontSize }, tickfont: { size: volcanoPlotConfig.axisFontSize }, ...(savedRanges ? { autorange: false, range: savedRanges.yRange } : {}) },
        hovermode: "closest",
        legend: { y: 0.95, yanchor: "top", font: { size: volcanoPlotConfig.legendFontSize } },
        margin: { t: 40, b: 45, l: 55, r: 15 },
        autosize: true,
        annotations: buildVolcanoAnnotations(),
        shapes: [
            { type: "line", x0: -fcThreshold, x1: -fcThreshold, y0: 0, y1: 1, yref: "paper", line: { dash: "dash", width: 1, color: "#828282" } },
            { type: "line", x0: fcThreshold, x1: fcThreshold, y0: 0, y1: 1, yref: "paper", line: { dash: "dash", width: 1, color: "#828282" } },
            { type: "line", x0: -10, x1: 10, y0: -Math.log10(fdrThreshold), y1: -Math.log10(fdrThreshold), line: { dash: "dash", width: 1, color: "#828282" } },
        ],
    }, {
        responsive: true,
        displayModeBar: "hover",
        scrollZoom: true,
        displaylogo: false,
        toImageButtonOptions: {
            format: volcanoPlotConfig.imgFormat,
            width: volcanoPlotConfig.imgWidth,
            height: volcanoPlotConfig.imgHeight,
            scale: volcanoPlotConfig.imgFormat === "svg" ? 1 : 6
        },
        edits: {
            annotationPosition: false, // keep arrowhead locked to data point
            annotationTail: true,      // allow dragging the text box (ax, ay in data coords)
            annotationText: false,     // disable text editing
            legendPosition: true,      // allow dragging the legend box
        },
    }).then(() => {
        volcanoEl.on("plotly_click", async (event) => {
            const lipid = event?.points?.find((point) => point.customdata)?.customdata;
            if (!lipid) return;
            selectedLipids.add(String(lipid));
            await refreshSelectionViews(String(lipid));
        });

        // Save dragged text-box positions so they survive any re-render
        volcanoEl.on("plotly_relayout", (eventdata) => {
            const keys = Object.keys(eventdata || {});
            if (!keys.some((k) => /^annotations\[/.test(k))) return;
            const current = volcanoEl.layout?.annotations || [];
            keys.filter((k) => /^annotations\[/.test(k)).forEach((k) => {
                const m = k.match(/annotations\[(\d+)\]/);
                if (!m) return;
                const ann = current[Number(m[1])];
                if (ann?.text) volcanoLabelPositions.set(ann.text, { ax: ann.ax, ay: ann.ay });
            });
        });
    });
}

async function forceDownload(url, filename) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const link = document.createElement("a");
        link.href = window.URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        window.open(url, "_blank");
    }
}

async function injectSidebar(uid) {
    const response = await fetch("sidebar.html");
    const html = await response.text();
    document.getElementById("sidebar-placeholder").innerHTML = html;
    document.getElementById("sidebar-placeholder").querySelectorAll("script").forEach(old => { const s = document.createElement("script"); s.textContent = old.textContent; document.head.appendChild(s); });
    document.querySelectorAll("#analysis-nav a").forEach((link) => {
        const href = link.getAttribute("href");
        if (href && href !== "#") link.href = `${href}?id=${projectId}&uid=${uid}`;
    });
    const activeLink = document.querySelector('#analysis-nav a[href^="t-test.html"]');
    if (activeLink) {
        document.querySelectorAll("#analysis-nav .nav-link").forEach((link) => link.classList.remove("active"));
        activeLink.classList.add("active");
    }
    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

function stripCsvColumns(csvText, columnsToRemove = []) {
    const lines = String(csvText || "").split(/\r?\n/);
    if (!lines.length) return "";

    const firstNonEmptyIndex = lines.findIndex((line) => String(line).trim() !== "");
    if (firstNonEmptyIndex < 0) return String(csvText || "");

    const header = parseCsvRow(lines[firstNonEmptyIndex]);
    const removeSet = new Set(columnsToRemove.map((name) => String(name || "").trim().toLowerCase()));
    const keepIndices = header
        .map((name, index) => ({ name: String(name || "").trim().toLowerCase(), index }))
        .filter((item) => !removeSet.has(item.name))
        .map((item) => item.index);

    if (!keepIndices.length) return "";
    if (keepIndices.length === header.length) return String(csvText || "");

    const rebuiltLines = lines.map((line, lineIndex) => {
        if (lineIndex !== firstNonEmptyIndex && String(line).trim() === "") return "";
        const cells = parseCsvRow(line);
        const nextRow = keepIndices.map((index) => cells[index] ?? "");
        return nextRow.map(escapeCsvValue).join(",");
    });

    return rebuiltLines.join("\n");
}

async function downloadFilteredUnivariateCsv(url, filename) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load CSV (HTTP ${response.status}).`);
        const csvText = await response.text();
        const filteredCsv = stripCsvColumns(csvText, ["log2fc"]);
        const blob = new Blob([filteredCsv], { type: "text/csv;charset=utf-8;" });
        const link = document.createElement("a");
        link.href = window.URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
    } catch (error) {
        console.error("Failed to download filtered CSV:", error);
        window.open(url, "_blank");
    }
}