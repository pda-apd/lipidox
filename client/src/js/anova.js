import "./auth-gate.js";
import { storage, db, auth } from "./firebase-config.js";
import { createSplitMetaEngine } from "./splitmeta.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { sortMetadataLabels } from "./meta-label-utils.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, updateDoc, onSnapshot } from "./firebase-config.js";
import { getDownloadURL, ref, uploadString, deleteObject } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS, TASK_STALE_TIMEOUT_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");

let projectData = null;
let resultsGlobal = [];
let selectedLabels = new Set();
let activeLipid = null;
let plotConfig = { ...PLOT_CONFIG_DEFAULTS };
let boxplotDownloadConfig = {
    imgWidth: PLOT_CONFIG_DEFAULTS.imgWidth,
    imgHeight: PLOT_CONFIG_DEFAULTS.imgHeight,
    imgFormat: PLOT_CONFIG_DEFAULTS.imgFormat,
};
let manhattanDownloadConfig = {
    imgWidth: PLOT_CONFIG_DEFAULTS.imgWidth,
    imgHeight: PLOT_CONFIG_DEFAULTS.imgHeight,
    imgFormat: PLOT_CONFIG_DEFAULTS.imgFormat,
};
let analysisHistory = [];
let currentRunId = null;
let currentCsvUrl = null;
let selectedHistoryRunId = null;
let staleResolutionRunId = null;
let runCooldownUntil = 0;
let runCooldownTimer = null;
let splitMode = "manual";
let splitEngine = null;
let pendingSplitHistorySnapshot = null;
const splitRunContext = new Map();
let metaPreviewCache = {
    metaPath: null,
    metaHeader: [],
    sampleToMeta: new Map(),
};

// Tune this block to control how much Manhattan plot uses bottom space.
const PLOT_TUNING = {
    MANHATTAN_MARGIN_TOP: 18,
    MANHATTAN_MARGIN_BOTTOM: 64,
    MANHATTAN_MARGIN_LEFT: 78,
    MANHATTAN_MARGIN_RIGHT: 24,
    MANHATTAN_MARGIN_PAD: 4,
    MANHATTAN_X_TITLE_STANDOFF: 10,
    // Increase this to pull the plot lower (crop more white space at bottom).
    MANHATTAN_BOTTOM_TRIM_PX: 0,

    BOXPLOT_MARGIN_TOP: 18,
    BOXPLOT_MARGIN_BOTTOM: 62,
    BOXPLOT_MARGIN_LEFT: 74,
    BOXPLOT_MARGIN_RIGHT: 24,
    BOXPLOT_MARGIN_PAD: 4
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
    splitWorkspace: () => document.getElementById("split-workspace"),
    target: () => document.getElementById("ana-target"),
    testType: () => document.getElementById("test-type"),
    normalityInfo: () => document.getElementById("normality-info"),
    runBtn: () => document.getElementById("btn-run-analysis"),
    runStatus: () => document.getElementById("run-analysis-status"),
    sortFilter: () => document.getElementById("res-sort-filter"),
    maxFdrFilter: () => document.getElementById("res-min-filter"),
    searchInput: () => document.getElementById("res-search"),
    rowCount: () => document.getElementById("res-row-count"),
    csvBtn: () => document.getElementById("btn-dl-csv"),
    resultsContainer: () => document.getElementById("results-container"),
    tableBody: () => document.querySelector("#res-table tbody"),
    boxplotTitle: () => document.getElementById("boxplot-lipid-title"),
    boxplot: () => document.getElementById("boxplot-detail"),
    manhattanTitle: () => document.getElementById("manhattan-plot-title"),
    manhattan: () => document.getElementById("manhattan-plot")
};

function parseCsvRow(line) {
    const row = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
        const ch = line[index];
        if (ch === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
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

function getObservedGroupCounts(columnName, sampleToMeta = metaPreviewCache.sampleToMeta) {
    const counts = new Map();
    if (!(sampleToMeta instanceof Map) || !columnName) return counts;
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
    });
    return counts;
}

function getDistinctMetaValues(columnName, sampleToMeta = metaPreviewCache.sampleToMeta) {
    if (!(sampleToMeta instanceof Map) || !columnName) return [];
    const values = new Set();
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        values.add(value);
    });
    return [...values];
}

function getEligibleGroupedMetaColumns(minGroups = 3) {
    const orderedNames = sortMetadataLabels(Array.isArray(metaPreviewCache.metaHeader) && metaPreviewCache.metaHeader.length
        ? metaPreviewCache.metaHeader
        : (projectData?.meta_metadata || []).map((item) => item?.name).filter(Boolean));

    return orderedNames
        .map((name) => {
            const meta = getMetaDescriptorByName(name);
            const distinctValues = getDistinctMetaValues(name);
            const configuredGroups = getCleanMetaGroupValues(meta);
            const countedGroups = getMetaGroupCountValues(meta);
            const groups = configuredGroups.length ? configuredGroups : (countedGroups.length ? countedGroups : distinctValues);
            return {
                ...(meta || {}),
                name,
                groups,
            };
        })
        .filter((item) => item.name && item.groups.length >= minGroups);
}

function getManualAnovaGroups(columnName) {
    const meta = getMetaDescriptorByName(columnName);
    const configuredGroups = getCleanMetaGroupValues(meta);
    if (configuredGroups.length >= 3) return configuredGroups;
    const countedGroups = getMetaGroupCountValues(meta);
    if (countedGroups.length >= 3) return countedGroups;
    return getDistinctMetaValues(columnName);
}

function getManualAnovaGroupEntries(columnName) {
    const labels = getManualAnovaGroups(columnName);
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

function escapeCsvValue(value) {
    const text = String(value ?? "");
    if (!/[",\n\r]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

async function buildManualAnovaMetaSource(targetColumn) {
    await ensureSplitMetaLoaded();
    if (!metaPreviewCache.metaHeader.includes(targetColumn)) {
        throw new Error(`Target metadata '${targetColumn}' not found in parsed metadata.`);
    }

    const groupEntries = getManualAnovaGroupEntries(targetColumn);
    if (groupEntries.length < 3) {
        throw new Error("Manual ANOVA requires at least 3 valid groups.");
    }

    const encodedValueMap = buildUniqueEncodedValueMap(groupEntries.map((entry) => entry.label));
    const encodedValueByCanonicalLabel = new Map(groupEntries.map((entry) => [normalizeGroupValue(entry.label), encodedValueMap.get(entry.label)]));
    const derivedTarget = `manualanova.${sanitizeBackendToken(targetColumn, "target")}.${Date.now()}`;
    const header = ["sample_id", ...metaPreviewCache.metaHeader, derivedTarget];
    const lines = [header.map(escapeCsvValue).join(",")];

    metaPreviewCache.sampleToMeta.forEach((meta, sampleId) => {
        const rawValue = normalizeGroupValue(meta?.[targetColumn]);
        const encodedValue = encodedValueByCanonicalLabel.get(rawValue) || "";
        const row = [sampleId, ...metaPreviewCache.metaHeader.map((column) => meta?.[column] ?? ""), encodedValue];
        lines.push(row.map(escapeCsvValue).join(","));
    });

    const metaPathOverride = `projects/${auth.currentUser.uid}/${projectId}/mutilgroup/anova_manual_meta_${Date.now()}.csv`;
    await uploadString(ref(storage, metaPathOverride), lines.join("\n"), "raw", { contentType: "text/csv" });

    return {
        target: derivedTarget,
        metaPathOverride,
        displayTarget: targetColumn,
        manualTarget: targetColumn,
        groupSummary: groupEntries.map((entry) => `${entry.label} (${entry.count})`).join(" | "),
    };
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
    if (!path) throw new Error("Missing metadata file path in project settings.");
    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load metadata file from local storage.");
    return response.text();
}

function parseMetaCsv(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length < 2) throw new Error("Metadata file is empty.");
    const header = parseCsvRow(lines[0]).map((value) => String(value || "").trim());
    const metaHeader = header.slice(1);
    const sampleToMeta = new Map();
    for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
        const row = reconcileMetaCsvRow(parseCsvRow(lines[rowIndex]), header);
        const sample = String(row[0] || "").trim();
        if (!sample) continue;
        const values = {};
        for (let columnIndex = 0; columnIndex < metaHeader.length; columnIndex += 1) {
            values[metaHeader[columnIndex]] = row[columnIndex + 1] ?? "";
        }
        sampleToMeta.set(sample, values);
    }
    return { metaHeader, sampleToMeta };
}

async function ensureSplitMetaLoaded(metaPathOverride = null) {
    const metaPath = metaPathOverride || projectData?.metaCheckedPath || null;
    if (!metaPath) throw new Error("Project is missing checked metadata path.");
    if (metaPreviewCache.metaPath === metaPath && metaPreviewCache.sampleToMeta.size) return;
    const text = await getStorageCsvText(metaPath);
    const parsed = parseMetaCsv(text);
    metaPreviewCache = {
        metaPath,
        metaHeader: parsed.metaHeader,
        sampleToMeta: parsed.sampleToMeta,
    };
}

async function ensureSplitEngineMounted() {
    if (splitEngine) return splitEngine;
    splitEngine = await createSplitMetaEngine({
        mode: "anova",
        configHost: dom.splitConfigSection(),
        workspaceHost: dom.splitWorkspace(),
        minGroups: 3,
        maxGroups: 8,
        defaultGroupNames: ["group1", "group2", "group3"],
        comparisonSeparator: " | ",
        getEligibleColumns: () => getEligibleGroupedMetaColumns(1),
        visible: false,
        onChange: (summary) => {
            if (splitMode === "split") {
                dom.normalityInfo().innerHTML = summary.error
                    ? summary.error
                    : `Split groups ready: ${summary.filledGroups.length} groups selected. Backend will run ANOVA/KW on the derived metadata column.`;
            }
            validateForm();
        },
    });
    return splitEngine;
}

async function syncSplitEngineMetadata(metaPathOverride = null) {
    const engine = await ensureSplitEngineMounted();
    await ensureSplitMetaLoaded(metaPathOverride);
    engine.setMetadata({ metaHeader: metaPreviewCache.metaHeader, sampleToMeta: metaPreviewCache.sampleToMeta });
    populateTargetMeta();
    updateNormalityInfo();
}

function setConfigMode(mode) {
    splitMode = mode === "split" ? "split" : "manual";
    dom.configModeManual()?.classList.toggle("active", splitMode === "manual");
    dom.configModeSplit()?.classList.toggle("active", splitMode === "split");
    dom.manualConfigSection()?.classList.toggle("d-none", splitMode !== "manual");
    dom.splitConfigSection()?.classList.toggle("d-none", splitMode !== "split");
    dom.splitWorkspace()?.classList.toggle("d-none", splitMode !== "split");
    if (splitMode === "split") {
        dom.resultsContainer()?.classList.add("d-none");
        if (pendingSplitHistorySnapshot && splitEngine) {
            splitEngine.applySnapshot(pendingSplitHistorySnapshot);
            pendingSplitHistorySnapshot = null;
        }
        splitEngine?.setVisible(true);
    } else {
        splitEngine?.setVisible(false);
        if (resultsGlobal.length > 0) {
            dom.resultsContainer()?.classList.remove("d-none");
            safeResizePlot("boxplot-detail");
            safeResizePlot("manhattan-plot");
        }
    }
    validateForm();
}

let resizeTimeout;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (resultsGlobal.length > 0) {
            renderManhattanPlot(resultsGlobal);
            if (activeLipid) renderBoxplot(activeLipid);
        }
        if (splitMode === "split" && splitEngine) splitEngine.render();
    }, 180);
});

function safeResizePlot(targetId) {
    try {
        if (!document.getElementById(targetId)) return;
        requestAnimationFrame(() => {
            try { Plotly.Plots.resize(targetId); } catch {}
            setTimeout(() => {
                try { Plotly.Plots.resize(targetId); } catch {}
            }, 80);
        });
    } catch {}
}

function extractDownloadConfig(cfg = {}) {
    return {
        imgWidth: Number(cfg.imgWidth) || PLOT_CONFIG_DEFAULTS.imgWidth,
        imgHeight: Number(cfg.imgHeight) || PLOT_CONFIG_DEFAULTS.imgHeight,
        imgFormat: cfg.imgFormat || PLOT_CONFIG_DEFAULTS.imgFormat,
    };
}

function applySharedPlotConfig(cfg = {}) {
    plotConfig = {
        ...plotConfig,
        ...Object.fromEntries(Object.entries(cfg).filter(([key]) => !["imgWidth", "imgHeight", "imgFormat"].includes(key))),
    };
}

function getPlotDownloadOptions(cfg = {}, filename) {
    const downloadCfg = extractDownloadConfig(cfg);
    return {
        format: downloadCfg.imgFormat,
        width: downloadCfg.imgWidth,
        height: downloadCfg.imgHeight,
        scale: downloadCfg.imgFormat === "svg" ? 1 : 6,
        filename,
    };
}

function normalizeTaskStatus(status) {
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

function getTaskStatusBadge(status) {
    if (status === "running") return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === "pending") return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === "error") return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

function setRunStatus(message = "", isError = false) {
    const status = dom.runStatus();
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
}

function setRunBusy(isBusy, message = "", isError = false) {
    setRunStatus(message, isError);
    if (!isBusy && !isRunCoolingDown()) {
        dom.runBtn().innerHTML = 'RUN ANOVA/KW';
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
        return;
    }

    runCooldownUntil = 0;
    dom.runBtn().innerHTML = 'RUN ANOVA/KW';
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

function getTaskActivityTime(task) {
    const raw = task?.heartbeat_at || task?.updated_at || task?.started_at || task?.date || null;
    const ts = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ts) ? ts : null;
}

function isTaskStale(task) {
    const status = normalizeTaskStatus(task?.status);
    if (status !== "pending" && status !== "running") return false;
    const activityTs = getTaskActivityTime(task);
    if (!activityTs) return false;
    return (Date.now() - activityTs) >= TASK_STALE_TIMEOUT_MS;
}

async function expireStaleAnovaTask(task) {
    if (!task?.run_id || !isTaskStale(task) || staleResolutionRunId === task.run_id) return false;

    staleResolutionRunId = task.run_id;
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
            status: "anova_error",
            error_msg: message,
            anova_task: nextTask,
            anova_history: nextHistory,
        });
        analysisHistory = nextHistory;
        renderAnalysisHistoryPopup();
    } catch (error) {
        console.error("Failed to expire stale ANOVA task:", error);
    } finally {
        staleResolutionRunId = null;
    }

    return true;
}

function buildTaskFallbackEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        name: task.name || "Untitled",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        target: task.target || null,
        results_url: task.results_url || null,
        csv_url: task.csv_url || null,
        status: normalizeTaskStatus(task.status),
        message: task.message || "",
    };
}

function decorateAnalysisEntry(entry) {
    if (!entry?.run_id) return entry;
    const context = splitRunContext.get(entry.run_id);
    if (!context) return entry;
    const { persisted: _persisted, ...publicContext } = context;
    return { ...entry, ...publicContext };
}

async function persistSplitContextForRun(runId) {
    const context = splitRunContext.get(runId);
    if (!context || context.persisted !== false) return;
    const { persisted: _persisted, ...publicContext } = context;
    const nextHistory = deduplicateHistory((projectData?.anova_history || analysisHistory).map((item) => item.run_id === runId ? { ...item, ...publicContext } : item));
    await updateDoc(doc(db, "projects", projectId), { anova_history: nextHistory });
    analysisHistory = nextHistory.map(decorateAnalysisEntry);
    projectData = { ...projectData, anova_history: nextHistory };
    context.persisted = true;
    splitRunContext.set(runId, context);
}

function setResultsLoading(message) {
    const boxplot = dom.boxplot();
    const manhattan = dom.manhattan();
    const tbody = dom.tableBody();

    showResults();
    selectedLabels.clear();
    activeLipid = null;

    if (tbody) tbody.innerHTML = "";
    if (dom.boxplotTitle()) dom.boxplotTitle().innerText = message;
    if (dom.manhattanTitle()) dom.manhattanTitle().innerText = message;

    if (boxplot) {
        boxplot.innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center; color:#6c757d; font-size:0.9rem;">${message}</div>`;
    }

    if (manhattan) {
        manhattan.style.marginBottom = `${-Math.max(PLOT_TUNING.MANHATTAN_BOTTOM_TRIM_PX, 0)}px`;
        manhattan.innerHTML = `<div style="height:100%; display:flex; align-items:center; justify-content:center; color:#6c757d; font-size:0.9rem;">${message}</div>`;
    }
}

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) return;
    await injectSidebar(user.uid);
    await initSetup();
    document.body.classList.add("loaded");
});

async function initSetup() {
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(projectData.norm_settings, projectData.normality_stat);

    analysisHistory = deduplicateHistory(projectData.anova_history || []);
    renderAnalysisHistoryPopup();

    populateTargetMeta();
    try {
        await syncSplitEngineMetadata();
    } catch (error) {
        console.warn("Unable to preload metadata for ANOVA split mode:", error);
    }
    bindEvents();
    setConfigMode(splitMode);
    validateForm();
    setRunStatus("");
    await syncRunTaskState(projectData.anova_task || null);

    // Live-update meta selector when another page saves a new metadata column
    onSnapshot(doc(db, "projects", projectId), async (s) => {
        const d = s.data() || {};
        if (JSON.stringify(d.meta_metadata) !== JSON.stringify(projectData.meta_metadata)) {
            projectData = { ...projectData, meta_metadata: d.meta_metadata || [] };
            populateTargetMeta();
            try {
                await syncSplitEngineMetadata();
            } catch (error) {
                console.warn("Unable to refresh ANOVA split metadata:", error);
            }
        }
        await refreshAnalysisStateFromSnapshot(d);
    });
}

function bindEvents() {
    dom.target().onchange = updateNormalityInfo;
    dom.analysisName().oninput = validateForm;
    dom.configModeManual().onclick = () => {
        if (!pendingSplitHistorySnapshot) splitEngine?.reset();
        setConfigMode("manual");
        updateNormalityInfo();
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
    dom.sortFilter().onchange = () => renderTable(resultsGlobal);
    if (dom.maxFdrFilter()) {
        dom.maxFdrFilter().onchange = () => {
            const raw = Number(dom.maxFdrFilter().value);
            const val = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
            dom.maxFdrFilter().value = String(val);
            renderTable(resultsGlobal);
        };
    }
    if (dom.searchInput()) {
        dom.searchInput().oninput = () => renderTable(resultsGlobal);
    }

    dom.historyToggle().onclick = () => {
        dom.historyPopup().classList.toggle("open");
    };

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".history-anchor")) {
            dom.historyPopup().classList.remove("open");
        }
    });

    dom.runBtn().onclick = runAnovaAnalysis;
    dom.csvBtn().onclick = () => {
        const url = currentCsvUrl;
        if (!url) {
            alert("Please run analysis first.");
            return;
        }
        forceDownload(url, "anova_multi_group_results.csv");
    };
}

function deduplicateHistory(history) {
    const seen = new Set();
    return (history || []).map((item) => ({
        ...item,
        status: normalizeTaskStatus(item?.status),
    })).map(decorateAnalysisEntry).filter((item) => {
        const key = item.run_id || `${item.name}_${item.target}_${item.date}`;
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
        `Target: ${item.display_target || item.target || "-"}`,
        item.group_summary ? `Groups: ${item.group_summary}` : null,
        `Status: ${normalizeTaskStatus(item.status)}`,
        `Date: ${item.date ? new Date(item.date).toLocaleString() : "-"}`
    ].filter(Boolean).join("\n");
}

async function syncRunTaskState(task) {
    if (!task?.run_id) {
        if (!currentRunId) setRunBusy(false, "", false);
        return;
    }

    const normalizedStatus = normalizeTaskStatus(task.status);
    if (normalizedStatus === "pending" || normalizedStatus === "running") {
        currentRunId = task.run_id;
        renderAnalysisHistoryPopup();
        setRunBusy(true, `${task.name || "ANOVA"} is ${normalizedStatus}...`);
        return;
    }

    if (normalizedStatus === "error") {
        if (!currentRunId || currentRunId === task.run_id) {
            currentRunId = null;
            setRunBusy(false, task.message || "ANOVA failed.", true);
        }
        renderAnalysisHistoryPopup();
        return;
    }

    const shouldAutoload = Boolean(currentRunId && currentRunId === task.run_id);
    currentRunId = null;
    selectedHistoryRunId = task.run_id;
    setRunBusy(false, `Done: ${task.name || task.run_id}`);
    renderAnalysisHistoryPopup();

    if (splitRunContext.has(task.run_id)) {
        try {
            await persistSplitContextForRun(task.run_id);
        } catch (error) {
            console.warn("Unable to persist split context for completed ANOVA run:", error);
        }
    }

    if (!shouldAutoload) return;

    const entry = decorateAnalysisEntry(analysisHistory.find((item) => item.run_id === task.run_id) || buildTaskFallbackEntry(task));
    if (entry?.results_url) {
        await loadAnalysisResults(entry);
    }
}

async function refreshAnalysisStateFromSnapshot(nextData) {
    if (await expireStaleAnovaTask(nextData.anova_task || null)) return;

    const historyChanged = JSON.stringify(nextData.anova_history || []) !== JSON.stringify(projectData.anova_history || []);
    if (historyChanged) {
        analysisHistory = deduplicateHistory(nextData.anova_history || []);
        renderAnalysisHistoryPopup();
    }

    projectData = {
        ...projectData,
        ...nextData,
    };

    await syncRunTaskState(nextData.anova_task || null);
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
    const latest = analysisHistory.find((item) => normalizeTaskStatus(item.status) === "done") || null;
    return {
        anova_history: analysisHistory.length ? analysisHistory : null,
        anova_results: latest?.results_url || null,
        anova_csv_url: latest?.csv_url || null
    };
}

function clearLoadedAnalysis() {
    selectedHistoryRunId = null;
    currentCsvUrl = null;
    resultsGlobal = [];
    selectedLabels.clear();
    activeLipid = null;
    const container = dom.resultsContainer();
    if (container) container.classList.add("d-none");
    if (dom.tableBody()) dom.tableBody().innerHTML = "";
    if (dom.boxplot()) dom.boxplot().innerHTML = "";
    if (dom.manhattan()) dom.manhattan().innerHTML = "";
}

function renderAnalysisHistoryPopup() {
    const popup = dom.historyPopup();
    if (!popup) return;

    analysisHistory = deduplicateHistory(analysisHistory);
    if (!analysisHistory.length) {
        popup.innerHTML = '<div class="history-meta p-2 text-center">No runs yet.</div>';
        return;
    }

    popup.innerHTML = analysisHistory.map((item) => `
        <div class="history-item d-flex align-items-start gap-2 ${selectedHistoryRunId && item.run_id === selectedHistoryRunId ? "active" : ""}" data-run-id="${item.run_id || ""}" title="${escapeHtmlAttr(buildHistoryTooltip(item))}">
            <div class="history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">${item.name || "Untitled"}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getTaskStatusBadge(normalizeTaskStatus(item.status))}<span>${formatTaskId(item) || "No ID"}</span></div>
                <div class="history-meta">${item.display_target || item.target || "-"}</div>
                ${item.group_summary ? `<div class="history-meta">${item.group_summary}</div>` : ""}
                <div class="history-meta">${item.message || (normalizeTaskStatus(item.status) === "done" ? "Ready to open." : normalizeTaskStatus(item.status) === "running" ? "Task is running..." : normalizeTaskStatus(item.status) === "pending" ? "Queued for processing..." : "Task failed.")}</div>
                <div class="history-meta">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete" data-run-id="${item.run_id || ""}" title="Delete this run" style="font-size:0.65rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `).join("");

    popup.querySelectorAll(".history-info").forEach((node) => {
        node.onclick = async () => {
            const runId = node.parentElement.dataset.runId;
            const entry = analysisHistory.find((h) => h.run_id === runId);
            if (!entry) return;
            const status = normalizeTaskStatus(entry.status);
            if (status === "pending" || status === "running") return;
            if (status === "error") {
                setRunStatus(entry.message || "ANOVA task failed.", true);
                return;
            }
            selectedHistoryRunId = runId || null;
            popup.querySelectorAll(".history-item").forEach((el) => el.classList.remove("active"));
            node.parentElement.classList.add("active");
            await loadAnalysisResults(entry);
            popup.classList.remove("open");
        };
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
            await deleteStorageArtifacts([entry.results_url, entry.csv_url, entry.meta_path_override]);
            analysisHistory = analysisHistory.filter((h) => h.run_id !== runId);
            const projectState = buildProjectStateFromHistory();
            await updateDoc(doc(db, "projects", projectId), projectState);
            projectData = { ...projectData, ...projectState };
            if (selectedHistoryRunId === runId) {
                const fallbackEntry = analysisHistory[0] || null;
                if (fallbackEntry) await loadAnalysisResults(fallbackEntry);
                else clearLoadedAnalysis();
            }
            renderAnalysisHistoryPopup();
        };
    });
}

function populateTargetMeta() {
    const targetSelect = dom.target();
    const previousValue = targetSelect.value;
    const validCols = getEligibleGroupedMetaColumns(3);
    targetSelect.innerHTML = '<option value="">-- Select --</option>' + validCols.map((m) => `<option value="${m.name}">${m.name}</option>`).join("");
    if (previousValue && validCols.some((item) => item.name === previousValue)) {
        targetSelect.value = previousValue;
    }
}

function updateNormalityInfo() {
    if (splitMode === "split") {
        const summary = splitEngine?.getSummary();
        dom.normalityInfo().innerHTML = summary?.error
            ? summary.error
            : "Build at least 3 non-overlapping groups in Split mode. The derived metadata column will be analyzed with the same backend ANOVA/KW route.";
        validateForm();
        return;
    }

    const val = dom.target().value;
    const info = dom.normalityInfo();
    if (!val) {
        info.innerHTML = "Select a meta column to view groups and statistical decision rules.";
        validateForm();
        return;
    }

    const groups = getManualAnovaGroups(val);
    if (groups.length < 3) {
        info.innerHTML = "Metadata not found or fewer than 3 valid groups are available for this column.";
        validateForm();
        return;
    }

    info.innerHTML = `
        <b>Groups (${groups.length}):</b> ${groups.join(", ")}<br>
        <b>Decision Rule:</b> Per feature, test normality on each group + Levene variance check.<br>
        <b>Pipeline:</b> All groups normal + equal var → ANOVA; all groups normal + unequal var → Welch ANOVA; otherwise → Kruskal-Wallis.
    `;
    validateForm();
}

function validateForm() {
    const manualReady = Boolean(dom.target().value);
    const splitReady = metaPreviewCache.sampleToMeta.size ? Boolean(splitEngine?.isValid()) : false;
    dom.runBtn().disabled = !(splitMode === "split" ? splitReady : manualReady) || isRunCoolingDown();
    if (!isRunCoolingDown()) {
        dom.runBtn().innerHTML = 'RUN ANOVA/KW';
    }
}

async function runAnovaAnalysis() {
    if (isRunCoolingDown()) return;
    currentRunId = null;
    dom.historyPopup().classList.remove("open");
    const analysisName = dom.analysisName().value.trim() || `ANOVA ${new Date().toLocaleString()}`;
    let targetMeta = dom.target().value;
    let metaPath = projectData.metaCheckedPath;
    let displayTarget = targetMeta;
    let splitContext = null;

    if (splitMode === "split") {
        try {
            await syncSplitEngineMetadata();
            const derived = splitEngine.buildDerivedMetaCsv({ columnPrefix: "__anova_split" });
            const metaPathOverride = `projects/${auth.currentUser.uid}/${projectId}/mutilgroup/anova_split_meta_${Date.now()}.csv`;
            await uploadString(ref(storage, metaPathOverride), derived.csvText, "raw", { contentType: "text/csv" });
            targetMeta = derived.targetColumn;
            metaPath = metaPathOverride;
            displayTarget = derived.displayTarget;
            splitContext = {
                input_mode: "split",
                display_target: derived.displayTarget,
                meta_path_override: metaPathOverride,
                split_config: derived.splitConfig,
                group_summary: derived.comparison,
                persisted: false,
            };
        } catch (error) {
            setRunBusy(false, error.message || String(error), true);
            return;
        }
    } else {
        try {
            const manualSource = await buildManualAnovaMetaSource(targetMeta);
            targetMeta = manualSource.target;
            metaPath = manualSource.metaPathOverride;
            displayTarget = manualSource.displayTarget;
            splitContext = {
                input_mode: "manual-derived",
                target: manualSource.manualTarget,
                manual_target: manualSource.manualTarget,
                display_target: manualSource.displayTarget,
                meta_path_override: manualSource.metaPathOverride,
                backend_target: manualSource.target,
                group_summary: manualSource.groupSummary,
                persisted: false,
            };
        } catch (error) {
            setRunBusy(false, error.message || String(error), true);
            return;
        }
    }

    setRunBusy(true, "Submitting ANOVA task...");
    startRunCooldown();

    try {
        const response = await fetch(`${vpsUrl}/biomarker-anova`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                matrix_path: projectData.matrixPreScalePath || projectData.matrixNormPath,
                meta_path: metaPath,
                settings: {
                    analysis_name: analysisName,
                    target_meta: targetMeta,
                    test_type: dom.testType()?.value || "auto"
                }
            })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || payload.message || "Failed to start ANOVA analysis.");
        currentRunId = payload.run_id || null;
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
                target: splitContext?.target || targetMeta,
                display_target: displayTarget,
                status: "pending",
                message: "Queued for processing.",
                ...(splitContext ? {
                    input_mode: splitContext.input_mode,
                    meta_path_override: splitContext.meta_path_override,
                    backend_target: splitContext.backend_target,
                    manual_target: splitContext.manual_target,
                    split_config: splitContext.split_config,
                    group_summary: splitContext.group_summary,
                } : {}),
            },
            ...analysisHistory.filter((item) => item.run_id !== payload.run_id),
        ]);
        renderAnalysisHistoryPopup();
        dom.historyPopup().classList.add("open");
        dom.historyToggle()?.scrollIntoView({ behavior: "smooth", block: "center" });
        setRunBusy(true, `${analysisName} is pending...`);
    } catch (e) {
        console.error(e);
        currentRunId = null;
        setRunBusy(false, e.message || "Failed to connect to server", true);
    }
}

async function loadAnalysisResults(analysis) {
    analysis = decorateAnalysisEntry(analysis);
    selectedHistoryRunId = analysis?.run_id || null;
    setResultsLoading("Loading...");
    try {
        const url = `${analysis.results_url}${analysis.results_url.includes("?") ? "&" : "?"}_=${Date.now()}`;
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        resultsGlobal = await resp.json();
    } catch (e) {
        console.error("Error loading results:", e);
        alert("Error loading analysis results.");
        return;
    }

    currentCsvUrl = analysis.csv_url || null;
    dom.analysisName().value = analysis.name || "";
    if (analysis.input_mode === "split" && analysis.split_config) {
        pendingSplitHistorySnapshot = analysis.split_config;
        splitEngine?.reset();
        setConfigMode("manual");
        dom.target().value = "";
    } else {
        pendingSplitHistorySnapshot = null;
        splitEngine?.reset();
        setConfigMode("manual");
        dom.target().value = analysis.manual_target || analysis.display_target || analysis.target || "";
    }
    updateNormalityInfo();

    selectedLabels.clear();
    activeLipid = null;
    showResults();
    renderTable(resultsGlobal);

    setTimeout(() => renderManhattanPlot(resultsGlobal), 80);
    setTimeout(() => {
        if (resultsGlobal.length) {
            activeLipid = resultsGlobal[0].lipid;
            renderBoxplot(activeLipid);
        }
    }, 120);
}

function showResults() {
    const container = dom.resultsContainer();
    if (container) {
        if (splitMode === "split") {
            splitMode = "manual";
            splitEngine?.setVisible(false);
            dom.splitWorkspace()?.classList.add("d-none");
            dom.configModeManual()?.classList.add("active");
            dom.configModeSplit()?.classList.remove("active");
            dom.manualConfigSection()?.classList.remove("d-none");
            dom.splitConfigSection()?.classList.add("d-none");
        }
        container.classList.remove("d-none");
        safeResizePlot("boxplot-detail");
        safeResizePlot("manhattan-plot");
    }
}

function renderTable(results) {
    const tbody = dom.tableBody();
    if (!tbody) return;

    const sort = dom.sortFilter().value;
    const maxFdr = dom.maxFdrFilter() ? Math.min(1, Math.max(0, Number(dom.maxFdrFilter().value) || 1)) : 1;
    const searchText = (dom.searchInput()?.value || "").trim().toLowerCase();
    let data = [...(results || [])];
    if (sort === "fdr_asc") data.sort((a, b) => a.fdr - b.fdr);
    else if (sort === "fdr_desc") data.sort((a, b) => b.fdr - a.fdr);
    else data.sort((a, b) => String(a.lipid).localeCompare(String(b.lipid)));

    data = data.filter((r) => {
        const passFdr = Number(r.fdr) <= maxFdr;
        const passSearch = !searchText || String(r.lipid || "").toLowerCase().includes(searchText);
        return passFdr && passSearch;
    });

    if (dom.rowCount()) dom.rowCount().innerText = `${data.length} rows`;

    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3">No features match current filter.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map((r) => `
        <tr class="lipid-row" style="cursor:pointer" data-lipid="${r.lipid}">
            <td><input type="checkbox" class="label-check" value="${r.lipid}" ${selectedLabels.has(r.lipid) ? "checked" : ""}></td>
            <td class="text-start fw-bold">${r.lipid}</td>
            <td>${Number(r.fdr).toFixed(3)}</td>
            <td class="extra-small text-muted">${String(r.method || "").split(" ")[0]}</td>
        </tr>
    `).join("");

    tbody.querySelectorAll(".lipid-row").forEach((row) => {
        row.onclick = (e) => {
            if (e.target.type === "checkbox") return;
            tbody.querySelectorAll(".lipid-row").forEach((r) => r.classList.remove("table-primary"));
            row.classList.add("table-primary");
            activeLipid = row.dataset.lipid;
            renderBoxplot(activeLipid);
        };
    });

    tbody.querySelectorAll(".label-check").forEach((cb) => {
        cb.onchange = () => {
            if (cb.checked) selectedLabels.add(cb.value);
            else selectedLabels.delete(cb.value);
            renderManhattanPlot(resultsGlobal);
        };
    });
}

function renderManhattanPlot(results) {
    const plotEl = dom.manhattan();
    if (!plotEl) return;

    const safeResults = Array.isArray(results) ? results : [];
    const sigCount = safeResults.filter((r) => r.fdr < 0.05).length;
    if (dom.manhattanTitle()) {
        dom.manhattanTitle().innerText = `Significant: ${sigCount}/${safeResults.length} | Labels: ${selectedLabels.size}`;
    }

    const trace = {
        x: safeResults.map((_, i) => i),
        y: safeResults.map((r) => -Math.log10(Math.max(r.fdr, 1e-300))),
        mode: "markers+text",
        name: "Lipids",
        text: safeResults.map((r) => (selectedLabels.has(r.lipid) ? r.lipid : "")),
        textposition: "top center",
        textfont: { size: 9 },
        marker: {
            color: safeResults.map((r) => (r.fdr < 0.05 ? "#198754" : "#dee2e6")),
            size: plotConfig.markerSize,
            opacity: plotConfig.markerOpacity
        },
        hovertext: safeResults.map((r) => `${r.lipid}<br>FDR: ${Number(r.fdr).toExponential(2)}`),
        hoverinfo: "text"
    };

    const layout = {
        xaxis: {
            title: { text: "Feature Index", standoff: PLOT_TUNING.MANHATTAN_X_TITLE_STANDOFF, font: { size: plotConfig.axisFontSize } },
            showticklabels: false,
            zeroline: false,
            automargin: true
        },
        yaxis: {
            title: { text: "-Log10(FDR)", standoff: 10, font: { size: plotConfig.axisFontSize } },
            tickfont: { size: plotConfig.axisFontSize },
            zeroline: false,
            automargin: true
        },
        margin: {
            t: PLOT_TUNING.MANHATTAN_MARGIN_TOP,
            b: PLOT_TUNING.MANHATTAN_MARGIN_BOTTOM,
            l: PLOT_TUNING.MANHATTAN_MARGIN_LEFT,
            r: PLOT_TUNING.MANHATTAN_MARGIN_RIGHT,
            pad: PLOT_TUNING.MANHATTAN_MARGIN_PAD
        },
        hovermode: "closest",
        autosize: true,
        shapes: [
            {
                type: "line",
                x0: 0,
                x1: Math.max(safeResults.length, 1),
                y0: -Math.log10(0.05),
                y1: -Math.log10(0.05),
                line: { dash: "dash", color: "red", width: 1 }
            }
        ]
    };

    try {
        plotEl.style.marginBottom = `${-Math.max(PLOT_TUNING.MANHATTAN_BOTTOM_TRIM_PX, 50)}px`;
        Plotly.newPlot("manhattan-plot", [trace], layout, {
            responsive: true,
            displayModeBar: "hover",
            scrollZoom: true,
            displaylogo: false,
            toImageButtonOptions: getPlotDownloadOptions(manhattanDownloadConfig, "manhattan_plot")
        });
        plotEl.on('plotly_click', function(data) {
            if (!data.points?.length) return;
            const pt = data.points[0];
            const lipid = safeResults[pt.pointIndex]?.lipid;
            if (!lipid) return;
            if (selectedLabels.has(lipid)) selectedLabels.delete(lipid);
            else selectedLabels.add(lipid);
            const cb = dom.tableBody()?.querySelector(`.label-check[value="${CSS.escape(lipid)}"]`);
            if (cb) cb.checked = selectedLabels.has(lipid);
            renderManhattanPlot(resultsGlobal);
        });
        safeResizePlot("manhattan-plot");
    } catch (e) {
        console.error("Manhattan plot error:", e);
    }
}

function renderBoxplot(lipidName) {
    const res = (resultsGlobal || []).find((r) => r.lipid === lipidName);
    if (!res || !res.box_data) return;

    if (dom.boxplotTitle()) {
        dom.boxplotTitle().innerText = `Visualizing: ${lipidName}`;
    }

    let groups = res.group_names || Object.keys(res.box_data);
    groups = groups.sort((a, b) => {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        return !isNaN(numA) && !isNaN(numB) ? numA - numB : String(a).localeCompare(String(b));
    });

    const traces = [];
    const shapes = [];
    const annotations = [];

    let maxY = -Infinity;

    groups.forEach((group) => {
        const yData = res.box_data[group] || [];
        if (!yData.length) return;

        const localMax = Math.max(...yData);
        if (localMax > maxY) maxY = localMax;

        traces.push({
            y: yData,
            type: "box",
            name: String(group),
            boxpoints: "all",
            jitter: 0.4,
            pointpos: 0,
            marker: { size: plotConfig.markerSize, opacity: plotConfig.markerOpacity },
            line: { width: 2 }
        });
    });

    if (res.posthoc && res.posthoc.length > 0 && isFinite(maxY)) {
        let currentYOffset = maxY * 1.05;
        const yStep = Math.max(maxY * 0.16, 0.2);

        const sigPairs = res.posthoc
            .filter((p) => p.p_adj < 0.05)
            .sort((a, b) => b.p_adj - a.p_adj);

        sigPairs.forEach((pair) => {
            const idx1 = groups.indexOf(pair.g1);
            const idx2 = groups.indexOf(pair.g2);
            if (idx1 === -1 || idx2 === -1) return;

            let stars = "*";
            if (pair.p_adj < 0.001) stars = "***";
            else if (pair.p_adj < 0.01) stars = "**";

            shapes.push({
                type: "path",
                path: `M ${idx1},${currentYOffset} L ${idx1},${currentYOffset + yStep * 0.3} L ${idx2},${currentYOffset + yStep * 0.3} L ${idx2},${currentYOffset}`,
                line: { color: "#ff0c0c", width: 1 }
            });

            annotations.push({
                x: (idx1 + idx2) / 2,
                y: currentYOffset + yStep * 0.35,
                text: `<b>${stars}</b>`,
                showarrow: false,
                font: { size: 12, color: "#333" },
                align: "center"
            });

            currentYOffset += yStep;
        });
    }

    const layout = {
        title: {
            text: `<b>${String(lipidName || "")}</b>`,
            x: 0.5,
            xanchor: "center",
            yanchor: "top",
            font: { size: plotConfig.axisFontSize }
        },
        yaxis: {
            title: { text: "Normalized Abundance", standoff: 10, font: { size: plotConfig.axisFontSize } },
            tickfont: { size: plotConfig.axisFontSize },
            zeroline: false,
            automargin: true
        },
        xaxis: {
            showgrid: false,
            type: "category",
            tickfont: { size: plotConfig.axisFontSize },
            automargin: true
        },
        margin: {
            t: Math.max(PLOT_TUNING.BOXPLOT_MARGIN_TOP, 42),
            b: PLOT_TUNING.BOXPLOT_MARGIN_BOTTOM,
            l: PLOT_TUNING.BOXPLOT_MARGIN_LEFT,
            r: PLOT_TUNING.BOXPLOT_MARGIN_RIGHT,
            pad: PLOT_TUNING.BOXPLOT_MARGIN_PAD
        },
        showlegend: false,
        shapes,
        annotations,
        hovermode: "closest",
        autosize: true
    };

    try {
        Plotly.newPlot("boxplot-detail", traces, layout, {
            responsive: true,
            displayModeBar: "hover",
            scrollZoom: true,
            displaylogo: false,
            toImageButtonOptions: getPlotDownloadOptions(boxplotDownloadConfig, "boxplot")
        });
        safeResizePlot("boxplot-detail");
    } catch (e) {
        console.error("Boxplot error:", e);
    }
}

async function forceDownload(url, filename) {
    try {
        const cacheBustedUrl = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
        const resp = await fetch(cacheBustedUrl, { cache: "no-store" });
        const blob = await resp.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
    } catch (e) {
        window.open(url, "_blank");
    }
}

async function injectSidebar(uid) {
    const resp = await fetch("sidebar.html");
    const html = await resp.text();
    document.getElementById("sidebar-placeholder").innerHTML = html;
    document.getElementById("sidebar-placeholder").querySelectorAll("script").forEach(old => { const s = document.createElement("script"); s.textContent = old.textContent; document.head.appendChild(s); });

    document.querySelectorAll("#analysis-nav a").forEach((l) => {
        const h = l.getAttribute("href");
        if (h && h !== "#") l.href = `${h}?id=${projectId}&uid=${uid}`;
    });

    const activeLink = document.querySelector('#analysis-nav a[href^="anova.html"]');
    if (activeLink) {
        document.querySelectorAll("#analysis-nav .nav-link").forEach((l) => l.classList.remove("active"));
        activeLink.classList.add("active");
    }

    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

mountPlotConfigPanel({
    anchor: document.getElementById("anova-config-anchor"),
    defaults: { ...plotConfig, ...boxplotDownloadConfig },
    options: {
        showLabelSize: false,
        showEllipseOpacity: false,
        showLegendFontSize: false,
    },
    onUpdate: (_key, _val, allCfg) => {
        applySharedPlotConfig(allCfg);
        boxplotDownloadConfig = extractDownloadConfig(allCfg);
        if (resultsGlobal.length > 0) renderManhattanPlot(resultsGlobal);
        if (activeLipid) renderBoxplot(activeLipid);
    },
    onDownload: (cfg) => {
        const boxEl = document.getElementById("boxplot-detail");
        if (!boxEl?.data?.length) return;
        Plotly.downloadImage(boxEl, getPlotDownloadOptions(cfg, "boxplot"));
    },
});

mountPlotConfigPanel({
    anchor: document.getElementById("manhattan-config-anchor"),
    defaults: { ...manhattanDownloadConfig },
    options: {
        showMarkerSize: false,
        showMarkerOpacity: false,
        showAxisFontSize: false,
        showLabelSize: false,
        showLegendFontSize: false,
        showEllipseOpacity: false,
        showLineWidth: false,
    },
    onUpdate: (_key, _val, allCfg) => {
        manhattanDownloadConfig = extractDownloadConfig(allCfg);
    },
    onDownload: (cfg) => {
        const manEl = document.getElementById("manhattan-plot");
        if (!manEl?.data?.length) return;
        Plotly.downloadImage(manEl, getPlotDownloadOptions(cfg, "manhattan_plot"));
    },
});
