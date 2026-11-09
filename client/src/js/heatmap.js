import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { computeTopFeaturesPerLabel, parseTopFeatureCount } from "./heatmap-feature-ranking.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { orderLabelsByGroups } from "./meta-label-utils.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { fetchJsonWithTimeout, formatTaskId, getTaskStatusBadge, normalizeTaskStatus, nowIso, prepareAnalysisTask } from "./task-utils.js";
import { deleteField, doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { getDownloadURL, ref, getToken, API_BASE } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");
const LABEL_PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
const AXIS_LABEL_FONT_SIZE = 9;
let heatmapPlotConfig = { ...PLOT_CONFIG_DEFAULTS, axisFontSize: 9 };

// HC layout is configured in frontend so it is easy to tune without touching Python.
const HCA_LAYOUT_CONFIG = {
    both: {
        row_heights: [0.07, 0.89, 0.02],
        column_widths: [0.09, 0.91],
        margin: { l: 0, r: 0, t: 5, b: 40 },
        vertical_spacing: 0,
        horizontal_spacing: 0,
    },
    features: {
        row_heights: [0.0001, 0.97, 0.02],
        column_widths: [0.1, 0.9],
        margin: { l: 0, r: 0, t: 5, b: 40 },
        vertical_spacing: 0,
        horizontal_spacing: 0,
    },
    samples: {
        row_heights: [0.07, 0.89, 0.02],
        column_widths: [0.02, 0.98],
        margin: { l: 0, r: 0, t: 5, b: 40 },
        vertical_spacing: 0,
        horizontal_spacing: 0,
    },
    none: {
        row_heights: [0.09, 0.89, 0.02],
        column_widths: [0.01, 0.99],
        margin: { l: 0, r: 0, t: 5, b: 40 },
        vertical_spacing: 0,
        horizontal_spacing: 0,
    },
};

const state = {
    projectData: null,
    datasetLoaded: false,
    sampleIds: [],
    features: [],
    featureToValues: new Map(),
    featureToValuesRaw: new Map(),
    metaBySample: new Map(),
    metaValueMap: new Map(),
    labelColorMapByMeta: new Map(),

    selectedLabels: new Set(),
    selectedFeatures: new Set(),
    filteredFeatures: [],
    autoFeatureSelection: { orderedFeatures: [], featureSet: new Set(), labelSections: [], summary: "", error: "" },

    viewMode: "heatmap",
    hcaHistory: [],
    activeHistoryRunId: null,
    hcaBusy: false,

    renderTimer: null,
    hcaCooldownUntil: 0,
    hcaCooldownTimer: null,
};

const dom = {
    sidebarPlaceholder: document.getElementById("sidebar-placeholder"),
    historyAnchor: document.querySelector(".history-anchor"),
    historyToggle: document.getElementById("history-toggle"),
    historyPopup: document.getElementById("history-popup"),

    viewMode: document.getElementById("view-mode"),
    showColLabels: document.getElementById("show-col-labels"),
    showRowLabels: document.getElementById("show-row-labels"),

    hcaConfig: document.getElementById("hca-config"),
    hcaAnalysisName: document.getElementById("hca-analysis-name"),
    hcaStandardization: document.getElementById("hca-standardization"),
    hcaDistance: document.getElementById("hca-distance"),
    hcaMetaCol: document.getElementById("hca-meta-col"),
    hcaGroupSelect: document.getElementById("hca-group-select"),
    hcaGroupAll: document.getElementById("hca-group-all"),
    hcaGroupNone: document.getElementById("hca-group-none"),
    hcaClusterBy: document.getElementById("hca-cluster-by"),
    hcaHeatmapType: document.getElementById("hca-heatmap-type"),
    runHcaBtn: document.getElementById("btn-run-hca"),
    hcaRunStatus: document.getElementById("hca-run-status"),

    heatmapOnlyOptions: document.getElementById("heatmap-only-options"),
    heatmapScaleWrap: document.getElementById("heatmap-scale-wrap"),
    metaCol: document.getElementById("meta-col"),
    heatmapScaleMode: document.getElementById("heatmap-scale-mode"),
    heatmapType: document.getElementById("heatmap-type"),
    featureViewMode: document.getElementById("feature-view-mode"),
    featureViewNote: document.getElementById("feature-view-note"),
    labelList: document.getElementById("label-list"),
    featureSearch: document.getElementById("feature-search"),
    featureCheckAll: document.getElementById("feature-check-all"),
    featureTableBody: document.querySelector("#feature-table tbody"),
    heatmapStatus: document.getElementById("heatmap-status"),
    rerunHeatmapBtn: document.getElementById("btn-rerun-heatmap"),
        featureSection: document.getElementById("feature-section"),
    commonConfig: document.getElementById("common-config"),
    hcLoadingText: document.getElementById("hc-loading-text"),

    resultSubtitle: document.getElementById("result-subtitle"),
    resultEmpty: document.getElementById("result-empty"),
    heatmapFrame: document.getElementById("heatmap-frame"),

};

function sanitizeText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeLabel(v) {
    const t = String(v ?? "").trim();
    if (!t || t.toLowerCase() === "nan" || t.toLowerCase() === "none" || t.toLowerCase() === "null") return "NaN";
    return t;
}

function toFiniteOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseCsvRow(line) {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === "," && !inQuotes) {
            values.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    values.push(current);
    return values;
}

function parseCsv(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) return { header: [], rows: [] };
    return { header: parseCsvRow(lines[0]), rows: lines.slice(1).map(parseCsvRow) };
}

function labelColor(label, allLabels) {
    const labels = Array.isArray(allLabels) ? allLabels : [];
    const idx = Math.max(0, labels.indexOf(label));
    return LABEL_PALETTE[idx % LABEL_PALETTE.length];
}

function buildStableLabelColorMap(labels) {
    const map = new Map();
    (labels || []).forEach((label, idx) => {
        map.set(label, LABEL_PALETTE[idx % LABEL_PALETTE.length]);
    });
    return map;
}

function colorForMetaLabel(metaCol, label) {
    const cmap = state.labelColorMapByMeta.get(metaCol);
    if (cmap && cmap.has(label)) return cmap.get(label);
    return labelColor(label, state.metaValueMap.get(metaCol) || []);
}

function isHeatmapMode() {
    return state.viewMode === "heatmap";
}

function isHcaMode() {
    return state.viewMode === "hca";
}

function getHcaLayoutSettings() {
    const key = String(dom.hcaClusterBy?.value || "both").toLowerCase();
    return {
        ...(HCA_LAYOUT_CONFIG[key] || HCA_LAYOUT_CONFIG.both),
        label_font_size: heatmapPlotConfig.groupLabelFontSize,
    };
}

function getCurrentMetaCol() {
    return isHcaMode() ? (dom.hcaMetaCol?.value || dom.metaCol.value) : dom.metaCol.value;
}

function syncMetaSelectors(value) {
    if (!value) return;
    if (dom.metaCol) dom.metaCol.value = value;
    if (dom.hcaMetaCol) dom.hcaMetaCol.value = value;
}

function setHeatmapStatus(message, isError = false) {
    dom.heatmapStatus.textContent = message || "";
    dom.heatmapStatus.classList.toggle("error", Boolean(isError));
}

function setHcaStatus(message, isError = false) {
    dom.hcaRunStatus.textContent = message || "";
    dom.hcaRunStatus.classList.toggle("error", Boolean(isError));
}

function setResultLoading(message) {
    dom.resultEmpty.innerHTML = `<div><div class="spinner-border spinner-border-sm me-2" role="status"></div>${sanitizeText(message || "Loading...")}</div>`;
    dom.resultEmpty.style.display = "flex";
    dom.heatmapFrame.style.display = "none";
    dom.heatmapFrame.src = "about:blank";
    dom.heatmapFrame.removeAttribute("srcdoc");
}

function showEmpty(message) {
    dom.heatmapFrame.style.display = "none";
    dom.heatmapFrame.src = "about:blank";
    dom.heatmapFrame.removeAttribute("srcdoc");
    dom.resultEmpty.innerHTML = sanitizeText(message || "No result.");
    dom.resultEmpty.style.display = "flex";
}

async function showFrameUrl(url, subtitle) {
    dom.heatmapFrame.removeAttribute("srcdoc");
    dom.heatmapFrame.style.display = "block";
    dom.resultEmpty.style.display = "none";
    dom.resultSubtitle.textContent = subtitle || "Ready";
    // The /files endpoint requires a Bearer token, but an iframe `src`
    // navigation does not send custom Authorization headers (and the global
    // fetch wrapper skips .html URLs). Fetch the HTML with the token explicitly
    // and render it via srcdoc instead.
    try {
        const fullUrl = url.startsWith("http") ? url : `${API_BASE || ""}${url}`;
        const resp = await fetch(fullUrl, { credentials: "include" });
        if (!resp.ok) {
            showEmpty(`Failed to load result (HTTP ${resp.status}).`);
            return;
        }
        let html = await resp.text();
        // Make the server-generated HCA plot fill the iframe (auto-fit like the
        // local heatmap does). Plotly's responsive config keeps the figure at
        // its fixed pixel height by default, so we force the container to 100%
        // and call Plotly.Plots.resize once Plotly (CDN) has loaded.
        const fitStyle = `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff;}#hca-plot{width:100%!important;height:100%!important;}</style>`;
        const fitScript = `<script>(function(){function f(){if(window.Plotly&&document.getElementById('hca-plot')){try{Plotly.Plots.resize('hca-plot');}catch(e){}}}window.addEventListener('load',function(){f();setTimeout(f,300);setTimeout(f,1000);setTimeout(f,2500);});window.addEventListener('resize',f);})();</script>`;
        html = html.replace("</head>", fitStyle + "</head>")
                   .replace("</body>", fitScript + "</body>");
        dom.heatmapFrame.src = "about:blank";
        dom.heatmapFrame.srcdoc = html;
    } catch (err) {
        showEmpty(err.message || "Failed to load result.");
    }
}

function waitForFrameLoad(timeoutMs = 12000) {
    return new Promise((resolve) => {
        let done = false;
        const complete = () => {
            if (done) return;
            done = true;
            dom.heatmapFrame.removeEventListener("load", onLoad);
            clearTimeout(timer);
            resolve();
        };
        const onLoad = () => complete();
        const timer = setTimeout(complete, timeoutMs);
        dom.heatmapFrame.addEventListener("load", onLoad, { once: true });
    });
}

function showFrameSrcdoc(srcdoc, subtitle) {
    dom.heatmapFrame.src = "about:blank";
    dom.heatmapFrame.srcdoc = srcdoc;
    dom.heatmapFrame.style.display = "block";
    dom.resultEmpty.style.display = "none";
    dom.resultSubtitle.textContent = subtitle || "Ready";
}

function setHcaBusy(isBusy, message = "") {
    state.hcaBusy = Boolean(isBusy);
    const coolingDown = isHcaCoolingDown();
    dom.runHcaBtn.disabled = isBusy || coolingDown;
    dom.historyToggle.disabled = !isHcaMode() || isBusy;

    if (dom.commonConfig) {
        if (isHcaMode()) {
            dom.commonConfig.classList.remove("d-none");
            dom.commonConfig.classList.toggle("is-loading", isBusy);
        } else {
            dom.commonConfig.classList.remove("is-loading");
        }
    }
    if (dom.hcLoadingText) {
        dom.hcLoadingText.textContent = message || "Loading...";
    }

    if (isBusy) {
        dom.runHcaBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Processing...';
    } else {
        refreshHcaCooldownUi();
        if (isHcaMode()) {
            dom.featureSection?.classList.add("d-none");
            renderLabelList();
        }
    }
}

function isHcaCoolingDown() {
    return state.hcaCooldownUntil > Date.now();
}

function refreshHcaCooldownUi() {
    if (state.hcaBusy) return;
    if (isHcaCoolingDown()) {
        dom.runHcaBtn.disabled = true;
        dom.runHcaBtn.innerHTML = '<i class="fa-solid fa-clock me-1"></i>Queued...';
        return;
    }
    dom.runHcaBtn.disabled = false;
    dom.runHcaBtn.innerHTML = '<i class="fa-solid fa-play me-1"></i>RUN HCA';
}

function startHcaCooldown(durationMs = RUN_SUBMIT_COOLDOWN_MS) {
    state.hcaCooldownUntil = Date.now() + durationMs;
    if (state.hcaCooldownTimer) {
        window.clearInterval(state.hcaCooldownTimer);
    }
    refreshHcaCooldownUi();
    state.hcaCooldownTimer = window.setInterval(() => {
        if (!isHcaCoolingDown()) {
            window.clearInterval(state.hcaCooldownTimer);
            state.hcaCooldownTimer = null;
            refreshHcaCooldownUi();
            return;
        }
        refreshHcaCooldownUi();
    }, 200);
}

async function fetchTextFromStoragePath(path) {
    const url = await getDownloadURL(ref(storage, path));
    const resp = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`Cannot load storage file: HTTP ${resp.status}`);
    return resp.text();
}

async function preloadDataset() {
    if (state.datasetLoaded) return;

    const matrixPath = state.projectData?.matrixNormPath;
    const rawMatrixPath = state.projectData?.matrixPreScalePath || matrixPath;
    const metaPath = state.projectData?.metaCheckedPath;
    if (!matrixPath || !metaPath) throw new Error("Missing matrixNormPath/metaCheckedPath.");

    const needRaw = rawMatrixPath && rawMatrixPath !== matrixPath;
    const [matrixText, metaText, rawMatrixText] = await Promise.all([
        fetchTextFromStoragePath(matrixPath),
        fetchTextFromStoragePath(metaPath),
        needRaw ? fetchTextFromStoragePath(rawMatrixPath) : Promise.resolve(null),
    ]);

    const matrixParsed = parseCsv(matrixText);
    const metaParsed = parseCsv(metaText);

    state.sampleIds = matrixParsed.header.slice(1);
    state.features = [];
    state.featureToValues = new Map();
    state.featureToValuesRaw = new Map();

    matrixParsed.rows.forEach((row) => {
        const feature = String(row[0] || "").trim();
        if (!feature) return;
        state.features.push(feature);
        state.featureToValues.set(feature, row.slice(1).map(toFiniteOrNull));
    });

    if (rawMatrixText) {
        const rawParsed = parseCsv(rawMatrixText);
        rawParsed.rows.forEach((row) => {
            const feature = String(row[0] || "").trim();
            if (!feature) return;
            state.featureToValuesRaw.set(feature, row.slice(1).map(toFiniteOrNull));
        });
    } else {
        state.featureToValues.forEach((v, k) => state.featureToValuesRaw.set(k, v));
    }

    const metaCols = metaParsed.header.slice(1);
    const metaValueMap = new Map();
    metaCols.forEach((col) => metaValueMap.set(col, new Set()));

    state.metaBySample = new Map();
    metaParsed.rows.forEach((row) => {
        const sample = String(row[0] || "").trim();
        if (!sample) return;
        const obj = {};
        metaCols.forEach((col, idx) => {
            const value = normalizeLabel(row[idx + 1]);
            obj[col] = value;
            metaValueMap.get(col).add(value);
        });
        state.metaBySample.set(sample, obj);
    });

    state.metaValueMap = new Map([...metaValueMap.entries()].map(([k, set]) => {
        const savedGroups = (state.projectData?.meta_metadata || []).find((m) => m?.name === k)?.groups;
        const ordered = orderLabelsByGroups([...set], savedGroups);
        return [k, ordered];
    }));
    state.labelColorMapByMeta = new Map(
        [...state.metaValueMap.entries()].map(([metaCol, labels]) => [metaCol, buildStableLabelColorMap(labels)])
    );
    state.filteredFeatures = [...state.features];
    state.selectedFeatures.clear();
    state.selectedLabels.clear();
    state.datasetLoaded = true;
}

function dedupeHistory(history) {
    const seen = new Set();
    return (history || []).filter((item) => {
        const key = item.run_id || `${item.name || ""}_${item.date || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getHeatmapScaleMode() {
    return String(dom.heatmapScaleMode?.value || "row_zscore").trim().toLowerCase();
}

function getFeatureViewMode() {
    return String(dom.featureViewMode?.value || "manual").trim().toLowerCase();
}

function isAutoFeatureViewEnabled() {
    return Number.isFinite(parseTopFeatureCount(getFeatureViewMode()));
}

function getSelectedLabelsForRanking(metaCol = getCurrentMetaCol()) {
    const labelDomain = state.metaValueMap.get(metaCol) || [];
    const activeLabels = labelDomain.filter((label) => state.selectedLabels.has(label));
    return activeLabels.length ? activeLabels : [...labelDomain];
}

function updateFeatureViewNote() {
    if (!dom.featureViewNote) return;
    if (!isAutoFeatureViewEnabled()) {
        dom.featureViewNote.textContent = "Manual mode uses the feature checklist below.";
        return;
    }
    dom.featureViewNote.textContent = state.autoFeatureSelection.error || state.autoFeatureSelection.summary || "Top-feature ranking is ready.";
}

function refreshAutoFeatureSelection() {
    if (!isAutoFeatureViewEnabled()) {
        state.autoFeatureSelection = { orderedFeatures: [], featureSet: new Set(), labelSections: [], summary: "", error: "" };
        updateFeatureViewNote();
        return state.autoFeatureSelection;
    }

    const metaCol = dom.metaCol?.value || getCurrentMetaCol();
    const selectedLabels = getSelectedLabelsForRanking(metaCol);
    state.autoFeatureSelection = computeTopFeaturesPerLabel({
        sampleIds: state.sampleIds,
        features: state.features,
        featureToValues: state.featureToValues,
        metaBySample: state.metaBySample,
        metaCol,
        selectedLabels,
        labelOrder: selectedLabels,
        topN: parseTopFeatureCount(getFeatureViewMode()),
        scaleMode: getHeatmapScaleMode(),
    });
    updateFeatureViewNote();
    return state.autoFeatureSelection;
}

function getCurrentFeatureSelection() {
    if (isAutoFeatureViewEnabled()) {
        const next = refreshAutoFeatureSelection();
        return {
            features: [...next.orderedFeatures],
            labelSections: next.labelSections || [],
            summary: next.summary || "",
            error: next.error || "",
        };
    }

    return {
        features: [...state.selectedFeatures],
        labelSections: [],
        summary: "",
        error: state.selectedFeatures.size ? "" : "Select at least one feature.",
    };
}

function applyDisplayScale(rows) {
    if (getHeatmapScaleMode() !== "row_zscore") {
        return rows;
    }

    return rows.map((row) => {
        const finite = row.filter((value) => Number.isFinite(value));
        if (!finite.length) return row.map(() => null);
        const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
        const variance = finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, finite.length - 1);
        const std = Math.sqrt(variance);
        if (!Number.isFinite(std) || std === 0) return row.map((value) => (Number.isFinite(value) ? 0 : null));
        return row.map((value) => (Number.isFinite(value) ? (value - mean) / std : null));
    });
}

function buildHistoryConfigText(item) {
    return [
        `Std: ${item.standardization || "none"}`,
        `Distance: ${item.distance || "euclidean"}`,
        `Cluster: ${item.cluster_by || "both"}`,
        `Meta: ${item.meta_col || "-"}`,
        `Status: ${normalizeTaskStatus(item.status)}`,
    ].join(" | ");
}

async function deleteStorageArtifacts(urls) {
    const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
    if (!uniqueUrls.length) return;
    await fetch(`${vpsUrl}/storage/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: uniqueUrls }),
    });
}

function populateMetaSelector() {
    const cols = (state.projectData?.meta_metadata || []).map((m) => String(m.name));
    const fallback = cols.length ? cols : [...state.metaValueMap.keys()];
    const optionsHtml = fallback.length
        ? fallback.map((col) => `<option value="${sanitizeText(col)}">${sanitizeText(col)}</option>`).join("")
        : '<option value="">No metadata</option>';
    dom.metaCol.innerHTML = optionsHtml;
    if (dom.hcaMetaCol) dom.hcaMetaCol.innerHTML = optionsHtml;
    if (fallback.length) syncMetaSelectors(fallback[0]);
    renderHcaGroupSelect();
}

// ── HCA group multi-select ───────────────────────────────────────────────
// Renders one toggle chip per group of the selected metadata column, colored
// to match the figure (colorForMetaLabel). Selection is kept in meta-column
// order so the HCA output's colors and group ordering stay consistent.
function renderHcaGroupSelect() {
    if (!dom.hcaGroupSelect) return;
    const metaCol = dom.hcaMetaCol?.value || dom.metaCol.value;
    const groups = state.metaValueMap.get(metaCol) || [];
    // Preserve previously selected labels that still exist; default = all.
    const prev = new Set(state.selectedLabels);
    const wanted = prev.size ? groups.filter((g) => prev.has(g)) : groups.slice();
    state.selectedLabels = new Set(wanted);

    if (!groups.length) {
        dom.hcaGroupSelect.innerHTML = '<span class="text-muted small">No groups</span>';
        return;
    }
    dom.hcaGroupSelect.innerHTML = groups.map((label, idx) => {
        const color = colorForMetaLabel(metaCol, label);
        const checked = wanted.includes(label) ? "checked" : "";
        return `<label class="hca-group-chip">
            <input type="checkbox" data-idx="${idx}" ${checked}>
            <span class="hca-group-swatch" style="background:${color}"></span>
            <span class="hca-group-label">${sanitizeText(label)}</span>
        </label>`;
    }).join("");
    dom.hcaGroupSelect.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener("change", syncHcaGroupSelection);
    });
}

function syncHcaGroupSelection() {
    const metaCol = dom.hcaMetaCol?.value || dom.metaCol.value;
    const groups = state.metaValueMap.get(metaCol) || [];
    const chosenIdx = new Set(
        [...dom.hcaGroupSelect.querySelectorAll('input:checked')].map((x) => Number(x.dataset.idx))
    );
    // Keep meta-column order so colors/layout on the figure stay aligned.
    state.selectedLabels = new Set(groups.filter((_, idx) => chosenIdx.has(idx)));
    if (!isHcaMode()) setHcaStatus("Group selection updated. Click RUN HCA to apply.");
}

function getHcaSelectedGroups() {
    const metaCol = dom.hcaMetaCol?.value || dom.metaCol.value;
    const allGroups = state.metaValueMap.get(metaCol) || [];
    const selected = state.selectedLabels.size
        ? allGroups.filter((g) => state.selectedLabels.has(g))
        : allGroups.slice();
    return { metaCol, allGroups, selected };
}

function renderLabelList() {
    const metaCol = getCurrentMetaCol();
    const labels = state.metaValueMap.get(metaCol) || [];

    if (!labels.length) {
        state.selectedLabels.clear();
        dom.labelList.innerHTML = '<div class="text-muted extra-small">No labels found.</div>';
        return;
    }

    if (!state.selectedLabels.size) labels.forEach((x) => state.selectedLabels.add(x));

    if (isHcaMode()) {
        dom.labelList.innerHTML = labels.map((label) => {
            const color = colorForMetaLabel(metaCol, label);
            return `<div class="d-flex align-items-center gap-1 extra-small mb-1"><span class="label-chip" style="background:${color}"></span>${sanitizeText(label)}</div>`;
        }).join("");
        return;
    }

    dom.labelList.innerHTML = labels.map((label, idx) => {
        const color = colorForMetaLabel(metaCol, label);
        return `
            <div class="form-check d-flex align-items-center gap-1">
                <input class="form-check-input label-check" id="lbl-${idx}" type="checkbox" value="${sanitizeText(label)}" ${state.selectedLabels.has(label) ? "checked" : ""}>
                <label for="lbl-${idx}" class="form-check-label extra-small mb-0"><span class="label-chip" style="background:${color}"></span>${sanitizeText(label)}</label>
            </div>
        `;
    }).join("");

    dom.labelList.querySelectorAll(".label-check").forEach((cb) => {
        cb.addEventListener("change", () => {
            if (cb.checked) state.selectedLabels.add(cb.value);
            else state.selectedLabels.delete(cb.value);
            refreshAutoFeatureSelection();
            renderFeatureTable();
            if (isHeatmapMode()) scheduleLocalRender();
            else setHcaStatus("Label filter updated. Click RUN HCA to apply.");
        });
    });
}

function renderFeatureTable() {
    const autoView = isAutoFeatureViewEnabled();
    const activeFeatureSelection = autoView ? refreshAutoFeatureSelection() : null;
    const activeFeatureSet = autoView ? activeFeatureSelection.featureSet : state.selectedFeatures;
    const search = String(dom.featureSearch.value || "").trim().toLowerCase();
    state.filteredFeatures = state.features.filter((f) => !search || f.toLowerCase().includes(search));

    if (!state.filteredFeatures.length) {
        dom.featureTableBody.innerHTML = '<tr><td colspan="2" class="text-muted py-2">No features found.</td></tr>';
        dom.featureCheckAll.checked = false;
        dom.featureCheckAll.disabled = autoView;
        return;
    }

    dom.featureTableBody.innerHTML = state.filteredFeatures.map((feature) => `
        <tr class="feature-row" data-feature="${sanitizeText(feature)}" style="cursor:pointer;">
            <td><input class="form-check-input feature-check" type="checkbox" value="${sanitizeText(feature)}" ${activeFeatureSet.has(feature) ? "checked" : ""} ${autoView ? "disabled" : ""}></td>
            <td>${sanitizeText(feature)}</td>
        </tr>
    `).join("");

    dom.featureTableBody.querySelectorAll(".feature-row").forEach((row) => {
        row.addEventListener("click", (e) => {
            if (autoView) return;
            const cb = row.querySelector(".feature-check");
            if (!cb) return;
            if (e.target.classList.contains("feature-check")) {
                if (cb.checked) state.selectedFeatures.add(cb.value);
                else state.selectedFeatures.delete(cb.value);
            } else {
                cb.checked = !cb.checked;
                if (cb.checked) state.selectedFeatures.add(cb.value);
                else state.selectedFeatures.delete(cb.value);
            }
            renderFeatureTable();
            if (isHeatmapMode()) scheduleLocalRender();
            else setHcaStatus("Feature selection updated. Click RUN HCA to apply.");
        });
    });

    dom.featureCheckAll.checked = state.filteredFeatures.length > 0 && state.filteredFeatures.every((feature) => activeFeatureSet.has(feature));
    dom.featureCheckAll.disabled = autoView;
}

function buildLocalMatrix(perSampleOnly = false) {
    const featureSelection = getCurrentFeatureSelection();
    const selectedFeatures = featureSelection.features;
    if (featureSelection.error) return { error: featureSelection.error };
    if (!selectedFeatures.length) return { error: "Select at least one feature." };

    const metaCol = dom.metaCol.value;
    const labelsToShow = state.selectedLabels;

    const sampleRows = [];
    state.sampleIds.forEach((sampleId, idx) => {
        const meta = state.metaBySample.get(sampleId);
        if (!meta) return;
        const label = normalizeLabel(meta[metaCol]);
        if (!labelsToShow.has(label)) return;
        sampleRows.push({ sampleId, idx, label });
    });

    if (!sampleRows.length) return { error: "No samples after label filter." };

    const mode = perSampleOnly ? "per_sample" : dom.heatmapType.value;
    const labelDomain = state.metaValueMap.get(metaCol) || [];

    if (mode === "mean_expression") {
        const groupMap = new Map();
        sampleRows.forEach((row) => {
            if (!groupMap.has(row.label)) groupMap.set(row.label, []);
            groupMap.get(row.label).push(row.idx);
        });

        const xLabels = [...groupMap.keys()];
        const valueSource = getHeatmapScaleMode() === "row_zscore" ? state.featureToValuesRaw : state.featureToValues;
        const z = selectedFeatures.map((feature) => {
            const values = valueSource.get(feature) || [];
            return xLabels.map((group) => {
                const indices = groupMap.get(group) || [];
                const arr = indices.map((i) => values[i]).filter((v) => v !== null);
                if (!arr.length) return null;
                return arr.reduce((a, b) => a + b, 0) / arr.length;
            });
        });

        const scaledZ = applyDisplayScale(z);
        return {
            xLabels,
            yLabels: selectedFeatures,
            z: scaledZ,
            xGroups: xLabels,
            labelDomain,
            subtitle: `Heatmap mean expression | ${getHeatmapScaleMode() === "row_zscore" ? "Row Z-score" : "Normalized"} | ${selectedFeatures.length} features | ${xLabels.length} groups`,
        };
    }

    const ordered = [...sampleRows].sort((a, b) => {
        const ai = labelDomain.indexOf(a.label);
        const bi = labelDomain.indexOf(b.label);
        if (ai !== bi) return ai - bi;
        return a.sampleId.localeCompare(b.sampleId);
    });

    const perValueSource = getHeatmapScaleMode() === "row_zscore" ? state.featureToValuesRaw : state.featureToValues;
    const rawZ = selectedFeatures.map((feature) => {
        const values = perValueSource.get(feature) || [];
        return ordered.map((row) => values[row.idx]);
    });

    return {
        xLabels: ordered.map((row) => row.sampleId),
        yLabels: selectedFeatures,
        z: applyDisplayScale(rawZ),
        xGroups: ordered.map((row) => row.label),
        labelDomain,
        subtitle: `Heatmap per-sample | ${getHeatmapScaleMode() === "row_zscore" ? "Row Z-score" : "Normalized"} | ${selectedFeatures.length} features | ${ordered.length} samples`,
    };
}

function buildLocalSrcdoc(payload, title) {
    const metaCol = dom.metaCol.value;
    const maxLabelLen = (payload.yLabels || []).reduce((m, f) => Math.max(m, String(f).length), 0);
    const leftMargin = dom.showRowLabels.checked ? Math.max(80, Math.min(240, maxLabelLen * 7)) : 40;
    const labelDomain = payload.labelDomain || [];
    const groupToCode = new Map(labelDomain.map((label, idx) => [label, idx]));
    const codes = payload.xGroups.map((label) => groupToCode.get(label) ?? 0);

    const n = Math.max(1, labelDomain.length - 1);
    const labelColorscale = labelDomain.length
        ? labelDomain.flatMap((label, idx) => {
            const pos = idx / n;
            const color = colorForMetaLabel(metaCol, label);
            return [[pos, color], [pos, color]];
        })
        : [[0, LABEL_PALETTE[0]], [1, LABEL_PALETTE[0]]];

    const separators = [];
    for (let i = 1; i < payload.xGroups.length; i++) {
        if (payload.xGroups[i] !== payload.xGroups[i - 1]) separators.push(i - 0.5);
    }

    const groupAnnotations = [];
    {
        const fSize = heatmapPlotConfig.groupLabelFontSize;
        const yshift = Math.round(fSize * 1.5 + 2.5);
        let gi = 0;
        while (gi < payload.xGroups.length) {
            const glabel = payload.xGroups[gi];
            let gj = gi;
            while (gj < payload.xGroups.length && payload.xGroups[gj] === glabel) gj++;
            const centerIdx = Math.floor((gi + gj - 1) / 2);
            groupAnnotations.push({
                x: payload.xLabels[centerIdx],
                y: 1,
                xref: "x2",
                yref: "paper",
                text: glabel,
                showarrow: false,
                captureevents: true,
                font: { size: fSize, color: "#333333" },
                yshift: yshift,
            });
            gi = gj;
        }
    }

    const traces = [
        {
            type: "heatmap",
            x: payload.xLabels,
            y: payload.yLabels,
            z: payload.z,
            colorscale: "RdBu_r",
            colorbar: { title: "Expression", len: 0.78, tickfont: { size: heatmapPlotConfig.legendFontSize }, titlefont: { size: heatmapPlotConfig.legendFontSize } },
            xaxis: "x",
            yaxis: "y",
            hovertemplate: "Feature: %{y}<br>Sample/Group: %{x}<br>Value: %{z:.4f}<extra></extra>",
        },
        {
            type: "heatmap",
            x: payload.xLabels,
            y: ["Label"],
            z: [codes],
            colorscale: labelColorscale,
            zmin: 0,
            zmax: Math.max(1, labelDomain.length - 1),
            showscale: false,
            xaxis: "x2",
            yaxis: "y2",
            hovertemplate: "Label: %{x}<extra></extra>",
        },
    ];

    const shapes = separators.flatMap((x) => ([
        { type: "line", x0: x, x1: x, y0: -0.5, y1: payload.yLabels.length - 0.5, xref: "x", yref: "y", line: { color: "#ffffff", width: 2 } },
        { type: "line", x0: x, x1: x, y0: -0.5, y1: 0.5, xref: "x2", yref: "y2", line: { color: "#ffffff", width: 2 } },
    ]));

    const _fSize = heatmapPlotConfig.groupLabelFontSize;
    const _bandH = Math.max(0.035, _fSize * 0.0035);
    const _gap = 0.008;
    const _mainTop = 1 - _bandH - _gap;
    const _marginTop = Math.max(30, Math.round(_fSize + 30));

    const layout = {
        template: "plotly_white",
        // title: { text: title || "Heatmap", x: 0.01 },
        margin: { l: 120, r: 0, t: _marginTop, b: 60 },
        xaxis: { domain: [0, 1], anchor: "y", showticklabels: Boolean(dom.showColLabels.checked), tickangle: -45, tickfont: { size: heatmapPlotConfig.axisFontSize }, type: "category" },
        yaxis: { domain: [0, _mainTop], anchor: "x", showticklabels: Boolean(dom.showRowLabels.checked), tickfont: { size: heatmapPlotConfig.axisFontSize }, type: "category" },
        xaxis2: { domain: [0, 1], anchor: "y2", showticklabels: false, matches: "x" , type: "category"},
        yaxis2: { domain: [1 - _bandH, 1], anchor: "x2", showticklabels: false, type: "category" },
        shapes,
        annotations: groupAnnotations,
    };

    const config = { responsive: true, displaylogo: false, displayModeBar: "hover", scrollZoom: true, edits: { annotationPosition: true }, toImageButtonOptions: { format: heatmapPlotConfig.imgFormat, width: heatmapPlotConfig.imgWidth, height: heatmapPlotConfig.imgHeight, scale: heatmapPlotConfig.imgFormat === "svg" ? 1 : 6 } };

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="./src/js/vendor/plotly-2.35.2.min.js"></script>
<style>html,body,#plot{margin:0;width:100%;height:100%;overflow:hidden;background:#fff;}g.annotation text{font-weight:bold!important;}</style>
</head>
<body>
<div id="plot"></div>
<script>
const data = ${JSON.stringify(traces)};
const layout = ${JSON.stringify(layout)};
const config = ${JSON.stringify(config)};
function boldAnnotations() {
    document.querySelectorAll('g.annotation text').forEach(function(el) {
        el.style.fontWeight = 'bold';
    });
}
var _origSerialize = XMLSerializer.prototype.serializeToString;
XMLSerializer.prototype.serializeToString = function(node) {
    if (node && node.querySelectorAll) {
        node.querySelectorAll('g.annotation text').forEach(function(el) {
            el.setAttribute('font-weight', 'bold');
        });
    }
    return _origSerialize.call(this, node);
};
Plotly.newPlot('plot', data, layout, config).then(boldAnnotations);
window.addEventListener('resize', () => Plotly.Plots.resize('plot').then(boldAnnotations));
</script>
</body>
</html>`;
}

function scheduleLocalRender() {
    if (!isHeatmapMode()) return;
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => {
        const payload = buildLocalMatrix(false);
        if (payload.error) {
            showEmpty(payload.error);
            setHeatmapStatus(payload.error, true);
            return;
        }
        showFrameSrcdoc(buildLocalSrcdoc(payload, "Heatmap"), payload.subtitle);
        setHeatmapStatus("Ready");
    }, 70);
}

function resetHeatmapRamCache() {
    state.datasetLoaded = false;
    state.sampleIds = [];
    state.features = [];
    state.featureToValues = new Map();
    state.featureToValuesRaw = new Map();
    state.metaBySample = new Map();
    state.metaValueMap = new Map();
    state.labelColorMapByMeta = new Map();
    state.filteredFeatures = [];
    state.selectedFeatures.clear();
    state.selectedLabels.clear();
    state.autoFeatureSelection = { orderedFeatures: [], featureSet: new Set(), labelSections: [], summary: "", error: "" };
}

async function deleteOldHeatmapArtifacts() {
    const cleanupKeys = [
        "heatmap_html_url",
        "heatmap_latest_url",
        "heatmap_latest_result_url",
        "heatmap_local_last_url",
    ];

    const oldUrls = cleanupKeys
        .map((k) => state.projectData?.[k])
        .filter((v) => typeof v === "string" && v.trim());

    if (oldUrls.length) {
        await deleteStorageArtifacts(oldUrls);
    }

    const payload = {
        heatmap_html_url: deleteField(),
        heatmap_latest_url: deleteField(),
        heatmap_latest_result_url: deleteField(),
        heatmap_local_last_url: deleteField(),
    };
    await updateDoc(doc(db, "projects", projectId), payload);

    const nextProjectData = { ...(state.projectData || {}) };
    cleanupKeys.forEach((k) => delete nextProjectData[k]);
    state.projectData = nextProjectData;
}

async function rerunHeatmapFresh() {
    if (!isHeatmapMode()) return;
    const btn = dom.rerunHeatmapBtn;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Re-running...';

    try {
        setResultLoading("Clearing old heatmap and rebuilding...");
        setHeatmapStatus("Removing old heatmap from RAM/server...");

        await deleteOldHeatmapArtifacts();

        resetHeatmapRamCache();
        await preloadDataset();
        populateMetaSelector();
        renderLabelList();
        renderFeatureTable();

        setHeatmapStatus("Running new heatmap...");
        const payload = buildLocalMatrix(false);
        if (payload.error) {
            showEmpty(payload.error);
            setHeatmapStatus(payload.error, true);
            return;
        }
        showFrameSrcdoc(buildLocalSrcdoc(payload, "Heatmap"), payload.subtitle);
        setHeatmapStatus("Re-run complete");
    } catch (error) {
        showEmpty(error?.message || "Re-run heatmap failed.");
        setHeatmapStatus(error?.message || "Re-run heatmap failed.", true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

function renderHistoryPopup() {
    if (!state.hcaHistory.length) {
        dom.historyPopup.innerHTML = '<div class="text-muted small text-center">No HC history yet.</div>';
        return;
    }

    dom.historyPopup.innerHTML = state.hcaHistory.map((item) => {
        const active = item.run_id === state.activeHistoryRunId ? "active" : "";
        return `
            <div class="history-item ${active}" data-run-id="${sanitizeText(item.run_id || "")}" style="cursor:pointer;">
                <div class="d-flex justify-content-between align-items-start gap-1">
                    <div style="min-width:0;">
                        <div class="fw-bold extra-small">${sanitizeText(item.name || "Untitled")}</div>
                            <div class="extra-small mt-1">${getTaskStatusBadge(item.status || "done")} <span class="text-muted ms-1">${formatTaskId(item)}</span></div>
                        <div class="text-muted extra-small">${sanitizeText(buildHistoryConfigText(item))}</div>
                            <div class="text-muted extra-small">${sanitizeText(item.message || "")}</div>
                        <div class="text-muted extra-small">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
                    </div>
                    <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete" data-run-id="${sanitizeText(item.run_id || "")}" title="Delete" ${["pending", "running"].includes(normalizeTaskStatus(item.status)) ? "disabled" : ""}><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join("");

    dom.historyPopup.querySelectorAll(".history-item").forEach((itemEl) => {
        itemEl.addEventListener("click", async (e) => {
            if (e.target.closest(".history-delete")) return;
            if (!isHcaMode() || state.hcaBusy) return;
            const runId = itemEl.dataset.runId;
            const item = state.hcaHistory.find((h) => h.run_id === runId);
            if (["pending", "running"].includes(normalizeTaskStatus(item?.status))) return;
            if (!item?.html_url) return;

            setHcaBusy(true, "Loading history...");
            setResultLoading("Loading HC history...");
            try {
                state.activeHistoryRunId = runId;
                syncMetaSelectors(item.meta_col || dom.metaCol.value);
                renderLabelList();
                renderHistoryPopup();
                showFrameUrl(item.html_url, `__HC history | ${item.name || "Untitled"}`);
                await waitForFrameLoad();
                setHcaStatus("History loaded");
            } finally {
                setHcaBusy(false);
            }
            dom.historyPopup.classList.remove("open");
        });
    });

    dom.historyPopup.querySelectorAll(".history-delete").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            const item = state.hcaHistory.find((h) => h.run_id === runId);
            if (!item) return;
            if (["pending", "running"].includes(normalizeTaskStatus(item.status))) return;
            if (!confirm(`Delete HC run '${item.name || "Untitled"}'?`)) return;

            await deleteStorageArtifacts([item.html_url]);
            state.hcaHistory = state.hcaHistory.filter((h) => h.run_id !== runId);
            const wasActive = state.activeHistoryRunId === runId;
            if (wasActive) state.activeHistoryRunId = null;
            await updateDoc(doc(db, "projects", projectId), {
                heatmap_hc_history: state.hcaHistory.length ? state.hcaHistory : null,
            });
            renderHistoryPopup();
            if (wasActive || !state.hcaHistory.length) {
                showEmpty("HC mode: Run or select a history entry to display interactive dendrogram result.");
                setHcaStatus(state.hcaHistory.length ? "History entry deleted." : "All history deleted. Run HCA to generate a new result.");
            }
        });
    });
}

function switchMode(mode) {
    state.viewMode = mode;
    const hca = mode === "hca";

    dom.hcaConfig.classList.toggle("d-none", !hca);
    dom.commonConfig.classList.remove("d-none");
    dom.heatmapOnlyOptions.classList.toggle("d-none", hca);
    dom.heatmapScaleWrap?.classList.toggle("d-none", hca);
    dom.featureSection?.classList.toggle("d-none", hca);
    dom.rerunHeatmapBtn?.classList.toggle("d-none", hca);
    dom.historyAnchor?.classList.toggle("d-none", !hca);
    dom.heatmapStatus?.classList.toggle("d-none", hca);
    dom.metaCol.disabled = hca;
    if (hca) setHeatmapStatus("");
    dom.historyToggle.disabled = !hca || state.hcaBusy;
    dom.historyPopup.classList.remove("open");

    if (hca) {
        showEmpty("HC mode: Run or select a history entry to display interactive dendrogram result.");
        renderHcaGroupSelect();
        setHcaStatus("Adjust config and click RUN HCA, or pick one from History.");
    } else {
        renderLabelList();
        scheduleLocalRender();
    }
}

async function runHca() {
    if (state.hcaBusy || isHcaCoolingDown()) return;

    let queuedRunId = null;

    setHcaBusy(true, "Running HCA...");
    setResultLoading("Running HCA...");
    setHcaStatus("Processing...");

    try {
        const identity = await prepareAnalysisTask(vpsUrl, projectId, "heatmap-hca", { "ngrok-skip-browser-warning": "true" });
        queuedRunId = identity.run_id;
        const metaColValue = dom.hcaMetaCol?.value || dom.metaCol.value;
        // Use only the groups chosen in the HCA group multi-select, kept in
        // meta-column order; colors come from the same palette used for chips.
        const { selected: selectedGroups } = getHcaSelectedGroups();
        const colorMap = {};
        selectedGroups.forEach((label) => {
            colorMap[label] = colorForMetaLabel(metaColValue, label);
        });
        syncMetaSelectors(metaColValue);
        const featureSelection = getCurrentFeatureSelection();
        if (featureSelection.error) {
            throw new Error(featureSelection.error);
        }

        const hcaViewType = dom.hcaHeatmapType?.value || "per_sample";
        const settings = {
            mode: "hca",
            view_type: hcaViewType,
            meta_col: metaColValue,
            selected_labels: selectedGroups,
            label_domain: selectedGroups,
            color_map: colorMap,
            selected_features: featureSelection.features,
            show_col_labels: dom.showColLabels.checked,
            show_row_labels: dom.showRowLabels.checked,
            standardization: dom.hcaStandardization.value,
            distance: dom.hcaDistance.value,
            cluster_by: dom.hcaClusterBy.value,
            hca_layout: getHcaLayoutSettings(),
        };

        const pendingItem = {
            run_id: identity.run_id,
            task_id: identity.task_id,
            name: dom.hcaAnalysisName.value.trim() || `HCA_${new Date().toLocaleString()}`,
            date: nowIso(),
            html_url: null,
            meta_col: settings.meta_col,
            standardization: settings.standardization,
            distance: settings.distance,
            cluster_by: settings.cluster_by,
            status: "pending",
            message: "Queued for processing.",
            started_at: identity.started_at,
            updated_at: identity.started_at,
        };

        state.hcaHistory = dedupeHistory([pendingItem, ...state.hcaHistory.filter((item) => item.run_id !== identity.run_id)]);
        state.activeHistoryRunId = identity.run_id;
        await updateDoc(doc(db, "projects", projectId), {
            heatmap_hc_history: state.hcaHistory,
        });
        renderHistoryPopup();

        state.hcaHistory = dedupeHistory([{ ...pendingItem, status: "running", message: "HCA is running...", updated_at: nowIso() }, ...state.hcaHistory.filter((item) => item.run_id !== identity.run_id)]);
        await updateDoc(doc(db, "projects", projectId), {
            heatmap_hc_history: state.hcaHistory,
        });
        renderHistoryPopup();

// Kiểm tra xem user chọn "none" hay có Z-score
        const isNoneStandardization = dom.hcaStandardization.value === "none";
        
        // Nếu "none" -> Lấy data sau scale (NormPath)
        // Nếu khác "none" -> Lấy data Pre-scale (hoặc fallback về NormPath nếu PreScale bị lỗi/không tồn tại)
        const targetMatrixPath = isNoneStandardization 
            ? state.projectData.matrixNormPath 
            : (state.projectData.matrixPreScalePath || state.projectData.matrixNormPath);

        const requestPromise = fetchJsonWithTimeout(`${vpsUrl}/heatmap/render`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "ngrok-skip-browser-warning": "true",
            },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                run_id: identity.run_id,
                task_id: identity.task_id,
                
                // Gán biến matrix_path đã được xử lý logic ở trên
                matrix_path: targetMatrixPath, 
                meta_path: state.projectData.metaCheckedPath,
                settings,
            }),
        });

        startHcaCooldown();
        setHcaBusy(false);

        void (async () => {
            try {
                const { response, data: payload } = await requestPromise;
                if (!response.ok) {
                    throw new Error(payload.detail || `HCA run failed (${response.status})`);
                }

                const item = {
                    run_id: identity.run_id,
                    task_id: identity.task_id,
                    name: pendingItem.name,
                    date: pendingItem.date,
                    html_url: payload.html_url,
                    meta_col: settings.meta_col,
                    standardization: settings.standardization,
                    distance: settings.distance,
                    cluster_by: settings.cluster_by,
                    status: "done",
                    message: "HCA generated successfully.",
                    started_at: pendingItem.started_at,
                    updated_at: nowIso(),
                    completed_at: nowIso(),
                };

                state.hcaHistory = dedupeHistory([item, ...state.hcaHistory]);
                state.activeHistoryRunId = identity.run_id;

                await updateDoc(doc(db, "projects", projectId), {
                    heatmap_hc_history: state.hcaHistory,
                    heatmap_hca_latest_url: payload.html_url,
                });

                renderHistoryPopup();
                showFrameUrl(payload.html_url, `__HCA dendrogram | ${payload.n_features} features | ${payload.n_samples} samples`);
                setHcaStatus("Done");
            } catch (error) {
                state.hcaHistory = dedupeHistory([{
                    ...pendingItem,
                    status: "error",
                    message: error.message || "HCA failed.",
                    updated_at: nowIso(),
                    completed_at: nowIso(),
                }, ...state.hcaHistory.filter((item) => item.run_id !== identity.run_id)]);
                await updateDoc(doc(db, "projects", projectId), {
                    heatmap_hc_history: state.hcaHistory,
                });
                renderHistoryPopup();
                showEmpty(error.message || "HCA failed.");
                setHcaStatus(error.message || String(error), true);
            }
        })();
    } catch (error) {
        const failedRun = state.hcaHistory.find((item) => item.run_id === queuedRunId);
        if (failedRun) {
            state.hcaHistory = dedupeHistory([{
                ...failedRun,
                status: "error",
                message: error.message || "HCA failed.",
                updated_at: nowIso(),
                completed_at: nowIso(),
            }, ...state.hcaHistory.filter((item) => item.run_id !== failedRun.run_id)]);
            await updateDoc(doc(db, "projects", projectId), {
                heatmap_hc_history: state.hcaHistory,
            });
            renderHistoryPopup();
        }
        showEmpty(error.message || "HCA failed.");
        setHcaStatus(error.message || String(error), true);
    } finally {
        if (state.hcaBusy) {
            setHcaBusy(false);
        }
    }
}

function bindEvents() {
    dom.historyToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isHcaMode() || state.hcaBusy) return;
        dom.historyPopup.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".history-anchor")) dom.historyPopup.classList.remove("open");
    });

    dom.viewMode.addEventListener("change", () => switchMode(dom.viewMode.value));

    dom.showColLabels.addEventListener("change", () => {
        if (isHeatmapMode()) {
            scheduleLocalRender();
        } else {
            const ifrWin = dom.heatmapFrame.contentWindow;
            if (ifrWin && dom.heatmapFrame.style.display !== "none") {
                ifrWin.postMessage({ type: "hca_relayout", updates: { "xaxis4.showticklabels": dom.showColLabels.checked } }, "*");
            } else {
                setHcaStatus("Column label setting updated. Click RUN HCA to apply.");
            }
        }
    });
    dom.showRowLabels.addEventListener("change", () => {
        if (isHeatmapMode()) {
            scheduleLocalRender();
        } else {
            const ifrWin = dom.heatmapFrame.contentWindow;
            if (ifrWin && dom.heatmapFrame.style.display !== "none") {
                ifrWin.postMessage({ type: "hca_relayout", updates: { "yaxis3.showticklabels": dom.showRowLabels.checked } }, "*");
            } else {
                setHcaStatus("Row label setting updated. Click RUN HCA to apply.");
            }
        }
    });

    dom.heatmapType.addEventListener("change", scheduleLocalRender);
    dom.heatmapScaleMode?.addEventListener("change", () => {
        refreshAutoFeatureSelection();
        renderFeatureTable();
        scheduleLocalRender();
    });
    dom.featureViewMode?.addEventListener("change", () => {
        refreshAutoFeatureSelection();
        renderFeatureTable();
        if (isHeatmapMode()) scheduleLocalRender();
        else setHcaStatus("Feature view updated. Click RUN HCA to apply.");
    });
    dom.metaCol.addEventListener("change", () => {
        state.selectedLabels.clear();
        renderLabelList();
        refreshAutoFeatureSelection();
        renderFeatureTable();
        if (isHeatmapMode()) scheduleLocalRender();
        else setHcaStatus("Metadata column updated. Click RUN HCA to apply.");
    });
    dom.hcaMetaCol?.addEventListener("change", () => {
        syncMetaSelectors(dom.hcaMetaCol.value);
        state.selectedLabels.clear();
        renderHcaGroupSelect();
        renderLabelList();
        setHcaStatus("Metadata column updated. Click RUN HCA to apply.");
    });
    dom.hcaGroupAll?.addEventListener("click", () => {
        dom.hcaGroupSelect?.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = true));
        syncHcaGroupSelection();
    });
    dom.hcaGroupNone?.addEventListener("click", () => {
        dom.hcaGroupSelect?.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
        syncHcaGroupSelection();
    });

    dom.featureSearch.addEventListener("input", renderFeatureTable);
    dom.featureCheckAll.addEventListener("change", () => {
        if (isAutoFeatureViewEnabled()) return;
        if (dom.featureCheckAll.checked) {
            state.filteredFeatures.forEach((f) => state.selectedFeatures.add(f));
        } else {
            state.filteredFeatures.forEach((f) => state.selectedFeatures.delete(f));
        }
        renderFeatureTable();
        if (isHeatmapMode()) scheduleLocalRender();
        else setHcaStatus("Feature selection updated. Click RUN HCA to apply.");
    });

    dom.hcaStandardization.addEventListener("change", () => setHcaStatus("Config updated. Click RUN HCA to apply."));
    dom.hcaDistance.addEventListener("change", () => setHcaStatus("Config updated. Click RUN HCA to apply."));
    dom.hcaClusterBy.addEventListener("change", () => setHcaStatus("Config updated. Click RUN HCA to apply."));

    if (dom.hcaHeatmapType) {
        dom.hcaHeatmapType.addEventListener("change", () => {
            const isMean = dom.hcaHeatmapType.value === "mean_expression";
            if (isMean) {
                dom.hcaClusterBy.value = "features";
                dom.hcaClusterBy.querySelectorAll("option").forEach((opt) => {
                    opt.disabled = opt.value !== "features" && opt.value !== "none";
                });
            } else {
                dom.hcaClusterBy.querySelectorAll("option").forEach((opt) => { opt.disabled = false; });
            }
            setHcaStatus("Config updated. Click RUN HCA to apply.");
        });
    }

    dom.runHcaBtn.addEventListener("click", runHca);
    dom.rerunHeatmapBtn.addEventListener("click", rerunHeatmapFresh);
}

async function injectSidebar(uid) {
    const resp = await fetch("./sidebar.html");
    const html = await resp.text();
    dom.sidebarPlaceholder.innerHTML = html;
    dom.sidebarPlaceholder.querySelectorAll("script").forEach(old => { const s = document.createElement("script"); s.textContent = old.textContent; document.head.appendChild(s); });

    dom.sidebarPlaceholder.querySelectorAll("#analysis-nav a").forEach((l) => {
        const href = l.getAttribute("href");
        if (href && href !== "#") l.href = `${href}?id=${projectId}&uid=${uid}`;
    });

    const activeLink = dom.sidebarPlaceholder.querySelector('a[href^="heatmap.html"]');
    if (activeLink) {
        dom.sidebarPlaceholder.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
        activeLink.classList.add("active");
    }

    const exitBtn = document.getElementById("btn-back-projects");
    if (exitBtn) exitBtn.href = `projectID.html?uid=${encodeURIComponent(uid)}`;

    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

async function initPage() {
    const snap = await getDoc(doc(db, "projects", projectId));
    state.projectData = snap.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(state.projectData.norm_settings, state.projectData.normality_stat);
    state.hcaHistory = dedupeHistory(state.projectData.heatmap_hc_history || []);

    setResultLoading("Loading matrix/meta into RAM...");
    await preloadDataset();
    populateMetaSelector();
    renderLabelList();
    refreshAutoFeatureSelection();
    renderFeatureTable();
    renderHistoryPopup();

    switchMode("heatmap");
    dom.viewMode.value = "heatmap";
    scheduleLocalRender();

    onSnapshot(doc(db, "projects", projectId), (docSnap) => {
        const data = docSnap.data() || {};
        state.projectData = { ...state.projectData, ...data };
        if (Array.isArray(data.heatmap_hc_history)) {
            state.hcaHistory = dedupeHistory(data.heatmap_hc_history);
            renderHistoryPopup();
        }
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!projectId) {
        showEmpty("Missing project id. Open this page from Project list.");
        document.body.classList.add("loaded");
        return;
    }
    if (!user) {
        document.body.classList.add("loaded");
        return;
    }
    await injectSidebar(user.uid);
    bindEvents();
    await initPage();
    document.body.classList.add("loaded");
});

mountPlotConfigPanel({
    anchor: document.getElementById("heatmap-config-anchor"),
    defaults: heatmapPlotConfig,
    options: { showMarkerSize: false, showMarkerOpacity: false, showLabelSize: false, showEllipseOpacity: false, showLineWidth: false, showGroupLabelSize: true },
    onUpdate: (_key, _val, allCfg) => {
        Object.assign(heatmapPlotConfig, allCfg);
        if (isHeatmapMode()) {
            scheduleLocalRender();
        } else if (isHcaMode()) {
            const ifrWin = dom.heatmapFrame.contentWindow;
            if (ifrWin && dom.heatmapFrame.style.display !== "none") {
                ifrWin.postMessage({ type: "hca_relayout", updates: {
                    "yaxis3.tickfont.size": heatmapPlotConfig.axisFontSize,
                    "xaxis4.tickfont.size": heatmapPlotConfig.axisFontSize,
                } }, "*");
                ifrWin.postMessage({ type: "hca_annotation_font", size: heatmapPlotConfig.groupLabelFontSize }, "*");
                ifrWin.postMessage({ type: "hca_restyle", style: {
                    "colorbar.tickfont.size": heatmapPlotConfig.legendFontSize,
                    "colorbar.titlefont.size": heatmapPlotConfig.legendFontSize,
                } }, "*");
            }
        }
    },
    onPreview: async (cfg) => {
        const opts = { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6 };
        if (isHcaMode()) {
            const ifrWin = dom.heatmapFrame.contentWindow;
            if (!ifrWin || dom.heatmapFrame.style.display === "none") return null;
            return await new Promise((resolve) => {
                const handler = (evt) => {
                    const d = evt.data || {};
                    if (d.type === "hca_preview_result") {
                        window.removeEventListener("message", handler);
                        resolve(d.error ? null : d.dataURL);
                    }
                };
                window.addEventListener("message", handler);
                ifrWin.postMessage({ type: "hca_preview", options: opts }, "*");
                setTimeout(() => { window.removeEventListener("message", handler); resolve(null); }, 15000);
            });
        }
        const frame = document.getElementById("heatmap-frame");
        const plotEl = frame?.contentDocument?.getElementById("plot");
        if (!plotEl?.data) return null;
        return await frame.contentWindow.Plotly.toImage(plotEl, opts);
    },
    onDownload: (cfg) => {
        if (isHcaMode()) {
            const ifrWin = dom.heatmapFrame.contentWindow;
            if (ifrWin && dom.heatmapFrame.style.display !== "none") {
                ifrWin.postMessage({ type: "hca_download", options: { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "hca_heatmap" } }, "*");
            }
            return;
        }
        const frame = document.getElementById("heatmap-frame");
        const plotEl = frame?.contentDocument?.getElementById("plot");
        if (!plotEl?.data) return;
        frame.contentWindow.Plotly.downloadImage(plotEl, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === "svg" ? 1 : 6, filename: "heatmap" });
    },
});
