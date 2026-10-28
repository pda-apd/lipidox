import "./auth-gate.js";
import { db, auth } from "./firebase-config.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc } from "./firebase-config.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");
const runId = urlParams.get("run");
const sourceRunId = urlParams.get("sourceRun");

let projectData = null;
let historyEntry = null;
let enrichmentPayload = null;
let selectedDatabases = new Set();
let checkedTermIds = new Set();
let activeTermId = null;
let currentPage = 1;
const PAGE_SIZE = 15;
const MAX_BUBBLE_DIAMETER_PX = 58;
const NETWORK_MAX_BUBBLE_DIAMETER_PX = 52;
const MIN_BUBBLE_DIAMETER_PX = 10;
const MAX_LEGEND_ICON_PX = 58;
const DEFAULT_MAX_FDR = 1;
const TERM_WRAP_LINE_LENGTH = 24;
const GSEA_MAX_SELECTION = 3;

// â”€â”€ Plot config state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const plotConfig = { ...PLOT_CONFIG_DEFAULTS };
let _configPanel = null;
let _lastConfigMode = null;

function mountConfigForMode(mode) {
    if (_lastConfigMode === mode && _configPanel) return;
    if (_configPanel) { _configPanel.destroy(); _configPanel = null; }
    const anchor = document.getElementById("enrichment-config-anchor");
    if (!anchor) return;
    _lastConfigMode = mode;

    const isGsea    = mode === "gsea";
    const isDot     = mode === "dot" || mode === "bar";
    const isNetwork = mode === "network";

    _configPanel = mountPlotConfigPanel({
        anchor,
        defaults: { ...plotConfig },
        options: {
            showMarkerSize:     false,
            showMarkerOpacity:  false,
            showAxisFontSize:   isGsea || isDot,
            showLabelSize:      isNetwork || mode === "dot",
            showLegendFontSize: isGsea || isNetwork || mode === "dot",
        },
        onUpdate: (_key, _val, allCfg) => {
            Object.assign(plotConfig, allCfg);
            _renderCurrentView();
        },
        onDownload: async (cfg) => {
            Object.assign(plotConfig, cfg);
            const el = dom.plotHost().querySelector("[data-role='plot-canvas']") || dom.plotHost();
            if (!el || !el._fullLayout) return;
            const dataURL = await _captureEnrichmentWithLegend(el, cfg);
            const ext = cfg.imgFormat === "jpeg" ? "jpg" : cfg.imgFormat;
            const a = document.createElement("a");
            a.href = dataURL;
            a.download = `enrichment_${mode}.${ext}`;
            document.body.appendChild(a); a.click(); a.remove();
        },
        onPreview: async (cfg) => {
            Object.assign(plotConfig, cfg);
            const el = dom.plotHost().querySelector("[data-role='plot-canvas']") || dom.plotHost();
            if (!el || !el._fullLayout) return null;
            return await _captureEnrichmentWithLegend(el, cfg);
        },
    });
}

// Capture the Plotly figure WITH the "% Feature" size legend, by compositing
// the legend onto a canvas at the SAME scale as the on-screen legend (circles
// drawn with ctx.arc => perfectly round, true-size proportions preserved).
// Format-aware: SVG keeps vector (legend injected as <circle>/<text>); PNG/JPEG
// composited on canvas with the matching MIME.
async function _captureEnrichmentWithLegend(plotEl, cfg) {
    const outW = cfg.imgWidth || 900;
    const outH = cfg.imgHeight || 600;
    const fmt = cfg.imgFormat || "png";

    if (fmt === "svg") {
        return await _captureEnrichmentSvgWithLegend(plotEl, cfg, outW, outH);
    }

    const scale = fmt === "jpeg" ? 6 : 6;
    const plotDataURL = await Plotly.toImage(plotEl, { format: "png", width: outW, height: outH, scale });
    const canvasW = outW * scale;
    const canvasH = outH * scale;
    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (fmt === "jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvasW, canvasH); }
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = plotDataURL; });
    ctx.drawImage(img, 0, 0, canvasW, canvasH);
    _drawEnrichmentLegendOnCanvas(ctx, plotEl, canvasW, canvasH, cfg, scale);
    return canvas.toDataURL(fmt === "jpeg" ? "image/jpeg" : "image/png");
}

// SVG path: inject the legend as native <circle>/<text> elements into the
// Plotly SVG string so the download stays true vector and includes the legend.
async function _captureEnrichmentSvgWithLegend(plotEl, cfg, outW, outH) {
    const svgDataURL = await Plotly.toImage(plotEl, { format: "svg", width: outW, height: outH, scale: 1 });
    const prefix = "data:image/svg+xml; charset=utf-8,";
    const prefix2 = "data:image/svg+xml,";
    let raw;
    if (svgDataURL.startsWith(prefix)) raw = decodeURIComponent(svgDataURL.slice(prefix.length));
    else if (svgDataURL.startsWith(prefix2)) raw = decodeURIComponent(svgDataURL.slice(prefix2.length));
    else raw = svgDataURL;

    const wMatch = raw.match(/<svg[^>]*\swidth=["']([\d.]+)/);
    const hMatch = raw.match(/<svg[^>]*\sheight=["']([\d.]+)/);
    const sw = wMatch ? parseFloat(wMatch[1]) : outW;
    const sh = hMatch ? parseFloat(hMatch[1]) : outH;
    const s = 1; // SVG toImage scale is 1; bubbles are MAX_BUBBLE_DIAMETER_PX (layout px).
    const maxDiam = MAX_LEGEND_ICON_PX * s;
    const fontSize = (cfg.legendFontSize || 12) * s;
    const labelGap = 10 * s;

    let inj = "";
    const t = ENRICHMENT_LEGEND_COORDS.title;
    inj += `<text x="${(t.x * sw).toFixed(2)}" y="${((1 - t.y) * sh + fontSize).toFixed(2)}" font-family="Inter, Segoe UI, sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="bold" fill="#1f2937">% Feature</text>`;
    buildDotLegendValues().forEach((p) => {
        const c = ENRICHMENT_LEGEND_COORDS[String(p)];
        const d = Math.max(4, (p / 100) * maxDiam);
        const r = d / 2;
        const cx = c.x * sw + r;
        const cy = (1 - c.y) * sh + r;
        inj += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="#94a3b8" stroke="#7c8794" stroke-width="${(1.2 * s).toFixed(2)}" opacity="0.9"/>`;
        inj += `<text x="${(cx + r + labelGap).toFixed(2)}" y="${(cy + 3 * s).toFixed(2)}" font-family="Inter, Segoe UI, sans-serif" font-size="${Math.max(8, fontSize - 1).toFixed(2)}" fill="#334155">${p}%</text>`;
    });
    raw = raw.replace("</svg>", inj + "</svg>");
    return "data:image/svg+xml; charset=utf-8," + encodeURIComponent(raw);
}

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Replicate the on-screen ".dp-size-legend" overlay onto the canvas, scaled so
// circle sizes match the on-screen legend relative to the plot.
// Draw the "% Feature" legend onto the canvas at the SAME hardcoded paper
// coords used by the on-screen overlay (ENRICHMENT_LEGEND_COORDS), so the
// composited download/preview matches what the user arranged.
// `scale` is the Plotly toImage scale factor — legend circle px = MAX_LEGEND_ICON_PX * scale
// (same as the plot bubbles), NOT canvasH/onScreenH.
function _drawEnrichmentLegendOnCanvas(ctx, plotEl, canvasW, canvasH, cfg, scale) {
    const s = scale || 1;
    const pcts = buildDotLegendValues();
    const maxDiam = MAX_LEGEND_ICON_PX * s;
    const fontSize = (cfg.legendFontSize || 12) * s;
    const labelGap = 10 * s;

    // Title
    const t = ENRICHMENT_LEGEND_COORDS.title;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `bold ${fontSize}px Inter, Segoe UI, sans-serif`;
    // background pill
    const tw = ctx.measureText("% Feature").width + 12 * s;
    const th = fontSize + 6 * s;
    _roundRect(ctx, t.x * canvasW, (1 - t.y) * canvasH, tw, th, 4 * s); ctx.fill();
    ctx.fillStyle = "#1f2937";
    ctx.fillText("% Feature", t.x * canvasW + 6 * s, (1 - t.y) * canvasH + 2 * s);

    // Circles + % labels
    ctx.textBaseline = "middle";
    ctx.font = `${Math.max(8, fontSize - 1)}px Inter, Segoe UI, sans-serif`;
    pcts.forEach((p) => {
        const c = ENRICHMENT_LEGEND_COORDS[String(p)];
        const d = Math.max(4, (p / 100) * maxDiam);
        const r = d / 2;
        const cx = c.x * canvasW + r;            // circle left = component left
        const cy = (1 - c.y) * canvasH + r;       // circle top = component top
        ctx.fillStyle = "#94a3b8"; ctx.strokeStyle = "#7c8794"; ctx.lineWidth = 1.2 * s;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#334155";
        ctx.fillText(`${p}%`, cx + r + labelGap, cy);
    });
}

function _renderCurrentView() {
    const mode = dom.viewMode().value;
    if (mode === "gsea")       renderGseaPlot();
    else if (mode === "dot")   renderDotPlot();
    else if (mode === "bar")   renderOraBarChart();
    else                       renderNetworkPlot();
}

const dom = {
    backToDal: () => document.getElementById("back-to-dal"),
    metaTitleHeading: () => document.getElementById("meta-title-heading"),
    databaseButton: () => document.getElementById("database-button"),
    databaseMenu: () => document.getElementById("database-menu"),
    downloadCsv: () => document.getElementById("download-csv"),
    sortSelect: () => document.getElementById("sort-select"),
    sortGseaOptions: () => document.getElementById("sort-gsea-options"),
    sortOraOptions: () => document.getElementById("sort-ora-options"),
    fdrLabel: () => document.getElementById("fdr-label"),
    maxFdr: () => document.getElementById("max-fdr"),
    termSearch: () => document.getElementById("term-search"),
    tableSummary: () => document.getElementById("table-summary"),
    selectionSummary: () => document.getElementById("selection-summary"),
    selectionWarning: () => document.getElementById("selection-warning"),
    selectAllTerms: () => document.getElementById("select-all-terms"),
    termTableBody: () => document.getElementById("term-table-body"),
    pageInfo: () => document.getElementById("page-info"),
    paginationControls: () => document.getElementById("pagination-controls"),
    viewMode: () => document.getElementById("view-mode"),
    vizTitle: () => document.getElementById("viz-title"),
    vizContext: () => document.getElementById("viz-context"),
    plotHost: () => document.getElementById("plot-host")
};

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) return;
    try {
        await initPage();
        document.body.classList.add("loaded");
    } finally {
        if (window.parent !== window) {
            window.parent.postMessage({ type: "enrichment-ready" }, "*");
        }
    }
});

async function initPage() {
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data() || {};
    const history = projectData.ttest_enrichment_history || [];
    historyEntry = runId
        ? history.find((item) => item.run_id === runId)
        : sourceRunId
        ? history.find((item) => item.source_run_id === sourceRunId)
        : history[0] || null;

    if (!historyEntry) {
        renderEmpty("No enrichment history found for this project.");
        return;
    }

    const response = await fetch(historyEntry.data_url);
    enrichmentPayload = await response.json();
    selectedDatabases = new Set(enrichmentPayload.databases || []);

    const firstTerm = (enrichmentPayload.results_table || [])[0];
    activeTermId = firstTerm?.term_id || null;
    if (activeTermId) checkedTermIds.add(activeTermId);

    bindEvents();
    renderMeta();
    applyOraUiMode();
    renderDatabaseMenu();
    renderTable();
    renderVisualization();
}

function bindEvents() {
    dom.sortSelect().onchange = () => {
        currentPage = 1;
        renderTable();
        renderVisualization();
    };
    dom.maxFdr().oninput = () => {
        const nextValue = parseFdrInputValue(dom.maxFdr().value);
        if (nextValue == null) return;
        currentPage = 1;
        renderTable();
        renderVisualization();
    };
    dom.maxFdr().onblur = () => {
        dom.maxFdr().value = formatFdrInputValue(getMaxFdrFilter());
    };
    dom.termSearch().oninput = () => {
        currentPage = 1;
        renderTable();
        renderVisualization();
    };
    dom.viewMode().onchange = () => {
        clearSelectionWarning();
        renderTable();
        renderVisualization();
    };
    dom.selectAllTerms().onchange = (event) => toggleCurrentPageSelection(event.target.checked);
}

function pruneSelectionForDatabaseFilter() {
    const allowedTermIds = new Set(
        (enrichmentPayload.results_table || [])
            .filter((row) => selectedDatabases.has(row.Database))
            .map((row) => row.term_id)
    );
    checkedTermIds = new Set([...checkedTermIds].filter((termId) => allowedTermIds.has(termId)));
    if (activeTermId && !allowedTermIds.has(activeTermId)) activeTermId = null;
}

function renderMeta() {
    const comparisonText = `${enrichmentPayload.target || "-"} | ${enrichmentPayload.comparison || "-"}`;
    const titleText = enrichmentPayload.title || "-";
    const methodLabel = isOraMode() ? "ORA" : "GSEA";
    dom.metaTitleHeading().textContent = `Enrichment - ${methodLabel} - ${comparisonText}`;
    dom.vizTitle().textContent = `Title: ${titleText}`;
    dom.downloadCsv().href = historyEntry.csv_url || "#";
    const backEl = dom.backToDal();
    if (backEl) backEl.href = `t-test.html?id=${encodeURIComponent(projectId)}&run=${encodeURIComponent(historyEntry.source_run_id || sourceRunId || "")}&tab=enrichment`;
}

function renderDatabaseMenu() {
    const databases = enrichmentPayload.databases || [];
    dom.databaseMenu().innerHTML = databases.map((name) => `
        <div class="form-check">
            <input class="form-check-input db-filter-check" type="checkbox" value="${name}" id="db-filter-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}" ${selectedDatabases.has(name) ? "checked" : ""}>
            <label class="form-check-label small" for="db-filter-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}">${name}</label>
        </div>
    `).join("");
    dom.databaseMenu().querySelectorAll(".db-filter-check").forEach((input) => {
        input.onchange = () => {
            if (input.checked) selectedDatabases.add(input.value);
            else selectedDatabases.delete(input.value);
            pruneSelectionForDatabaseFilter();
            currentPage = 1;
            updateDatabaseButton();
            renderTable();
            renderVisualization();
        };
    });
    updateDatabaseButton();
}

function updateDatabaseButton() {
    const total = (enrichmentPayload.databases || []).length;
    const count = selectedDatabases.size;
    dom.databaseButton().textContent = count === total ? "All databases" : `${count}/${total} databases`;
}

function parseFdrInputValue(rawValue) {
    const normalized = String(rawValue || "").trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(1, parsed));
}

function formatFdrInputValue(value) {
    const numeric = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(numeric)) return String(DEFAULT_MAX_FDR);
    if (numeric === 0 || numeric === 1) return String(numeric);
    if (numeric < 0.001) return numeric.toExponential(2);
    return numeric.toString();
}

function getMaxFdrFilter() {
    const parsedValue = parseFdrInputValue(dom.maxFdr().value);
    return parsedValue == null ? DEFAULT_MAX_FDR : parsedValue;
}

function getFilteredTerms() {
    const searchText = (dom.termSearch().value || "").trim().toLowerCase();
    const maxFdr = getMaxFdrFilter();
    const sortMode = dom.sortSelect().value;
    const ora = isOraMode();

    const rows = [...(enrichmentPayload.results_table || [])].filter((row) => {
        const passDb = selectedDatabases.has(row.Database);
        const passSearch = !searchText || String(row.Term || "").toLowerCase().includes(searchText);
        const passFdr = ora
            ? Number(row["p-value"]) <= maxFdr
            : Number(row.FDR) <= maxFdr;
        return passDb && passSearch && passFdr;
    });

    rows.sort((left, right) => {
        if (sortMode === "abs_nes_desc") return Number(right["|NES|"]) - Number(left["|NES|"]);
        if (sortMode === "abs_nes_asc") return Number(left["|NES|"]) - Number(right["|NES|"]);
        if (sortMode === "nes_desc") return Number(right.NES) - Number(left.NES);
        if (sortMode === "nes_asc") return Number(left.NES) - Number(right.NES);
        if (sortMode === "es_desc") return Number(right.ES) - Number(left.ES);
        if (sortMode === "es_asc") return Number(left.ES) - Number(right.ES);
        if (sortMode === "pval_asc") return Number(left["p-value"]) - Number(right["p-value"]);
        if (sortMode === "pval_desc") return Number(right["p-value"]) - Number(left["p-value"]);
        if (sortMode === "gene_count_desc") {
            return Number(right["Feature count"] ?? right["Gene count"] ?? 0) - Number(left["Feature count"] ?? left["Gene count"] ?? 0);
        }
        if (sortMode === "gene_count_asc") {
            return Number(left["Feature count"] ?? left["Gene count"] ?? 0) - Number(right["Feature count"] ?? right["Gene count"] ?? 0);
        }
        return ora
            ? Number(left["p-value"]) - Number(right["p-value"])
            : Number(left.FDR) - Number(right.FDR);
    });
    return rows;
}

function getPagedTerms(rows) {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    return {
        pageRows: rows.slice(start, start + PAGE_SIZE),
        totalPages
    };
}

function updateSelectionSummary() {
    const count = checkedTermIds.size;
    dom.selectionSummary().textContent = `${count} selected${count && isGseaMode() ? ` | ${Math.min(count, GSEA_MAX_SELECTION)} used for GSEA` : ""}`;
    updateSelectAllCheckbox();
}

function isGseaMode() {
    return dom.viewMode().value === "gsea";
}

function isOraMode() {
    return enrichmentPayload?.method === "ORA";
}

function applyOraUiMode() {
    const isOra = isOraMode();

    // Toggle table header columns
    document.querySelectorAll(".gsea-col").forEach((el) => { el.style.display = isOra ? "none" : ""; });
    document.querySelectorAll(".ora-col").forEach((el) => { el.style.display = isOra ? "" : "none"; });

    // Toggle sort option groups
    const gseaOpts = dom.sortGseaOptions();
    const oraOpts = dom.sortOraOptions();
    if (gseaOpts) gseaOpts.style.display = isOra ? "none" : "";
    if (oraOpts) oraOpts.style.display = isOra ? "" : "none";
    if (isOra) dom.sortSelect().value = "pval_asc";

    // Toggle FDR/p-value label
    const fdrLabel = dom.fdrLabel();
    if (fdrLabel) fdrLabel.textContent = isOra ? "p-value <=" : "FDR <=";
    if (isOra) {
        dom.maxFdr().value = "0.05";
        dom.maxFdr().max = "1";
        dom.maxFdr().step = "0.001";
    }

    // Toggle view-mode options
    document.querySelectorAll(".gsea-view-option").forEach((el) => { el.style.display = isOra ? "none" : ""; });
    document.querySelectorAll(".ora-view-option").forEach((el) => { el.style.display = isOra ? "" : "none"; });
    if (isOra) {
        const vm = dom.viewMode();
        if (vm.value === "gsea" || vm.value === "dot") vm.value = "bar";
    }
}

function clearSelectionWarning() {
    dom.selectionWarning().textContent = "";
}

function showSelectionWarning(message) {
    dom.selectionWarning().textContent = message;
}

function canAddMoreSelections(addCount = 1) {
    if (!isGseaMode()) return true;
    return checkedTermIds.size + addCount <= GSEA_MAX_SELECTION;
}

function updateSelectAllCheckbox() {
    const checkbox = dom.selectAllTerms();
    if (!checkbox) return;
    const { pageRows } = getPagedTerms(getFilteredTerms());
    if (!pageRows.length) {
        checkbox.checked = false;
        checkbox.indeterminate = false;
        checkbox.disabled = true;
        return;
    }

    const selectedCount = pageRows.filter((row) => checkedTermIds.has(row.term_id)).length;
    checkbox.disabled = false;
    if (isGseaMode()) {
        checkbox.checked = selectedCount > 0;
        checkbox.indeterminate = selectedCount > 0 && selectedCount < pageRows.length;
        checkbox.title = selectedCount > 0 ? "Deselect visible terms" : `Select all is not available in GSEA (max ${GSEA_MAX_SELECTION} terms).`;
        return;
    }
    checkbox.checked = selectedCount === pageRows.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < pageRows.length;
    checkbox.title = "";
}

function toggleCurrentPageSelection(checked) {
    const { pageRows } = getPagedTerms(getFilteredTerms());
    clearSelectionWarning();
    if (isGseaMode()) {
        const selectedCount = pageRows.filter((row) => checkedTermIds.has(row.term_id)).length;
        if (checked) {
            dom.selectAllTerms().checked = selectedCount > 0;
            showSelectionWarning(`Select all is unavailable in GSEA. Maximum is ${GSEA_MAX_SELECTION}.`);
            updateSelectAllCheckbox();
            return;
        }
        if (!selectedCount) {
            updateSelectAllCheckbox();
            return;
        }
    }
    pageRows.forEach((row) => {
        if (checked) checkedTermIds.add(row.term_id);
        else checkedTermIds.delete(row.term_id);
    });
    activeTermId = checked
        ? (activeTermId && pageRows.some((row) => row.term_id === activeTermId) ? activeTermId : pageRows[0]?.term_id || null)
        : (getFilteredTerms()[0]?.term_id || null);
    renderTable();
    renderVisualization();
}

function getTermRow(termId) {
    return (enrichmentPayload.results_table || []).find((row) => row.term_id === termId) || null;
}

function getTermDetail(termId) {
    if (!termId) return null;
    const details = enrichmentPayload.term_details || {};
    if (details[termId]) return details[termId];
    const row = getTermRow(termId);
    if (!row) return null;
    return details[row.Term] || details[String(row.term || "")] || null;
}

function getSelectedRows({ limit = null, fallbackToActive = true } = {}) {
    const filteredRows = getFilteredTerms();
    const filteredById = new Map(filteredRows.map((row) => [row.term_id, row]));

    let rows = Array.from(checkedTermIds)
        .map((termId) => filteredById.get(termId))
        .filter(Boolean);

    if (!rows.length && fallbackToActive && activeTermId) {
        const activeRow = filteredById.get(activeTermId);
        if (activeRow) rows = [activeRow];
    }

    if (limit != null) rows = rows.slice(0, limit);
    return rows;
}

function buildFdrStripAnnotations() {
    return [
        { xref: "paper", yref: "paper", x: 0.035, y: 0.405, text: "0.05", showarrow: false, font: { size: 10, color: "#000000" } },
        { xref: "paper", yref: "paper", x: 0.08, y: 0.405, text: "0.1", showarrow: false, font: { size: 10, color: "#000000" } },
        { xref: "paper", yref: "paper", x: 0.92, y: 0.405, text: "0.1", showarrow: false, font: { size: 10, color: "#000000" } },
        { xref: "paper", yref: "paper", x: 0.965, y: 0.405, text: "0.05", showarrow: false, font: { size: 10, color: "#000000" } },
    ];
}

function buildDotLegendValues() {
    return [25, 50, 75, 100];
}

function clampPercent(value) {
    return Math.max(0, Math.min(100, Number(value) || 0));
}

function percentToBubbleDiameter(percent, maxDiameterPx = MAX_BUBBLE_DIAMETER_PX, minDiameterPx = MIN_BUBBLE_DIAMETER_PX) {
    const safePercent = clampPercent(percent);
    if (safePercent <= 0) return 0;
    return Math.max(minDiameterPx, (safePercent / 100) * maxDiameterPx);
}

/**
 * Build a Plotly-native "% Feature" size legend baked INTO the figure (as an
 * inset scatter trace on a hidden xaxis2/yaxis2 + a paper annotation), so it
 * is captured by Plotly.toImage / downloadImage (preview & single-file
 * download include it). Positioned at the bottom-right, directly below the
 * "-log10FDR" colorbar (which occupies the upper-right half).
 *
 * @param {number} maxDiameterPx - same max bubble diameter used by the main plot.
 * @param {number} fontSize - legend font size.
 * @returns {{ traces: object[], layout: object }}
 */
function buildSizeLegendInset(maxDiameterPx, fontSize) {
    const pcts = buildDotLegendValues();               // [25,50,75,100]
    const sizeref = maxDiameterPx / MAX_LEGEND_ICON_PX; // match main plot scaling (true sizes)
    const sizes = pcts.map((p) => percentToBubbleDiameter(p, maxDiameterPx));
    const n = pcts.length;
    // Spread circles across a TALL band so the full-size dots (up to ~58px)
    // do not overlap. Band sits below the "-log10FDR" colorbar on the right.
    const ys = pcts.map((_, i) => 0.10 + (i * (0.80 / Math.max(1, n - 1))));

    const trace = {
        x: pcts.map(() => 0.5),
        y: ys,
        mode: "markers+text",
        type: "scatter",
        xaxis: "x2",
        yaxis: "y2",
        marker: {
            size: sizes,
            sizemode: "diameter",
            sizeref: sizeref,
            color: "#94a3b8",
            line: { color: "#7c8794", width: 1 },
            opacity: 0.9,
        },
        text: pcts.map((p) => `${p}%`),
        textposition: "right",
        textfont: { size: Math.max(8, fontSize - 1), color: "#334155" },
        hoverinfo: "skip",
        showlegend: false,
    };

    const layout = {
        xaxis2: { domain: [0.82, 0.965], anchor: "y2", visible: false, range: [0, 1], fixedrange: true },
        yaxis2: { domain: [0.02, 0.55], anchor: "x2", visible: false, range: [0, 1], fixedrange: true },
        annotations: [{
            x: 0.892, y: 0.57, xref: "paper", yref: "paper",
            text: "<b>% Feature</b>", showarrow: false,
            font: { size: fontSize, color: "#1f2937" },
        }],
    };
    return { traces: [trace], layout };
}

function clearPlotHost() {
    const host = dom.plotHost();
    host.innerHTML = "";
    host.style.display = "block";
    host.style.padding = "0";
}

function ensurePlotScaffold(legendWidth = 116) {
    const host = dom.plotHost();
    host.innerHTML = `
        <div class="plot-layout" style="grid-template-columns:minmax(0, 1fr) ${legendWidth}px;">
            <div data-role="plot-canvas" style="min-width:0; min-height:0; height:100%;"></div>
            <div data-role="plot-legend" class="plot-legend-pane"></div>
        </div>
    `;
    host.style.display = "block";
    host.style.padding = "0";
    return {
        canvas: host.querySelector('[data-role="plot-canvas"]'),
        legend: host.querySelector('[data-role="plot-legend"]'),
    };
}

function toHoverNumber(value, fallback = "-") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function buildRankingCustomDatum(row, index) {
    return [
        String(row?.Feature || "-"),
        String(row?.["Mapped feature"] || row?.Gene || "-"),
        toHoverNumber(row?.LogFC),
        toHoverNumber(row?.FDR),
        Number(row?.RankIndex) || index + 1,
    ];
}

function chunkLabelToken(token, chunkLength) {
    if (token.length <= chunkLength) return [token];

    const chunks = [];
    for (let start = 0; start < token.length; start += chunkLength) {
        chunks.push(token.slice(start, start + chunkLength));
    }
    return chunks;
}

function wrapTermLabel(value, maxLines = 2, lineLength = TERM_WRAP_LINE_LENGTH) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    if (!normalized) return "-";

    const tokens = normalized
        .split(" ")
        .flatMap((token) => chunkLabelToken(token, lineLength));
    const lines = [];
    let currentLine = "";

    tokens.forEach((token) => {
        if (lines.length >= maxLines) return;
        const nextLine = currentLine ? `${currentLine} ${token}` : token;
        if (nextLine.length <= lineLength || !currentLine) {
            currentLine = nextLine;
            return;
        }
        lines.push(currentLine);
        currentLine = token;
    });

    if (currentLine && lines.length < maxLines) {
        lines.push(currentLine);
    }

    if (tokens.length && lines.length === maxLines) {
        const reconstructed = lines.join(" ");
        if (reconstructed.length < normalized.length) {
            lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.\s]+$/g, "")}...`;
        }
    }

    return lines.map((line) => escapeHtmlAttr(line)).join("<br>");
}

function wrapTermLabelFull(value, lineLength = TERM_WRAP_LINE_LENGTH) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    if (!normalized) return "-";

    const tokens = normalized
        .split(" ")
        .flatMap((token) => chunkLabelToken(token, lineLength));
    const lines = [];
    let currentLine = "";

    tokens.forEach((token) => {
        const nextLine = currentLine ? `${currentLine} ${token}` : token;
        if (nextLine.length <= lineLength || !currentLine) {
            currentLine = nextLine;
            return;
        }
        lines.push(currentLine);
        currentLine = token;
    });

    if (currentLine) lines.push(currentLine);
    return lines.map((line) => escapeHtmlAttr(line)).join("<br>");
}

/**
 * Attach a FIXED HTML size-legend ("% Feature") onto the plot host element,
 * positioned directly below the "-log10FDR" colorbar (which occupies the
 * upper-right half: len 0.5, y 1, yanchor top â†’ ends at ~50% height).
 * Circles render at their true pixel sizes (MAX_LEGEND_ICON_PX scale),
 * bypassing Plotly's native legend icon row-height cap (~20px). Fixed
 * (non-draggable) so it stays part of the figure, aligned under the colorbar.
 */
// Hardcoded "% Feature" legend positions (paper coords: x 0-1 left->right,
// y 0-1 bottom->top, top-left of each component). Shared by the on-screen
// overlay (attachFixedLegend) and the canvas composite (_drawEnrichmentLegendOnCanvas)
// so display and download/preview match exactly.
const ENRICHMENT_LEGEND_COORDS = {
    title:     { x: 0.872, y: 0.476 },
    "25":      { x: 0.891, y: 0.417 },
    "50":      { x: 0.889, y: 0.378 },
    "75":      { x: 0.890, y: 0.316 },
    "100":     { x: 0.892, y: 0.238 },
};

function attachFixedLegend(hostEl, cfg) {
    hostEl.querySelectorAll(".legend-positioner, .legend-positioner-readout").forEach((el) => el.remove());
    document.querySelectorAll(".legend-positioner-readout").forEach((el) => el.remove());
    if (!hostEl) return;
    if (getComputedStyle(hostEl).position === "static") hostEl.style.position = "relative";

    const pcts = buildDotLegendValues();
    const maxDiam = MAX_LEGEND_ICON_PX;
    const fontSize = cfg?.legendFontSize || 12;
    const W = hostEl.clientWidth, H = hostEl.clientHeight;

    const container = document.createElement("div");
    container.className = "legend-positioner";
    container.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:6;";

    const place = (el, coord) => {
        el.style.left = (coord.x * W) + "px";
        el.style.top = ((1 - coord.y) * H) + "px";
    };

    const title = document.createElement("div");
    title.textContent = "% Feature";
    title.style.cssText = "position:absolute;pointer-events:none;font-weight:700;color:#1f2937;font-size:" + fontSize + "px;background:rgba(255,255,255,0.92);padding:2px 6px;border-radius:4px;border:1px solid #e2e8f0;white-space:nowrap;";
    place(title, ENRICHMENT_LEGEND_COORDS.title);
    container.appendChild(title);

    pcts.forEach((p) => {
        const d = Math.max(4, Math.round((p / 100) * maxDiam));
        const item = document.createElement("div");
        item.style.cssText = "position:absolute;pointer-events:none;display:flex;align-items:center;gap:8px;";
        item.innerHTML = '<div style="width:' + d + 'px;height:' + d + 'px;border-radius:50%;background:#94a3b8;border:1.2px solid #7c8794;opacity:0.9;box-sizing:border-box;"></div><span style="color:#334155;font-size:' + Math.max(8, fontSize - 1) + 'px;white-space:nowrap;">' + p + '%</span>';
        place(item, ENRICHMENT_LEGEND_COORDS[String(p)]);
        container.appendChild(item);
    });
    hostEl.appendChild(container);
}
function attachDraggableSizeLegend(hostEl, legendValues, plotConfig) {
    hostEl.querySelectorAll('.dp-size-legend').forEach(el => el.remove());
    if (!hostEl || !legendValues?.length) return;

    const fontSize = plotConfig?.legendFontSize || 12;
    const maxDiam = MAX_LEGEND_ICON_PX;

    const rows = legendValues.map(pct => {
        const d = Math.max(4, Math.round((pct / 100) * maxDiam));
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;"><div style="width:${maxDiam}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><div style="width:${d}px;height:${d}px;border-radius:50%;background:#94a3b8;border:1.2px solid #7c8794;opacity:0.85;box-sizing:border-box;"></div></div><span style="color:#334155;white-space:nowrap;">${pct}%</span></div>`;
    }).join('');

    const el = document.createElement('div');
    el.className = 'dp-size-legend';
    // Fixed below the -log10FDR colorbar (colorbar bottom â‰ˆ 50% of plot height).
    el.style.cssText = `position:absolute;right:6px;top:52%;background:rgba(255,255,255,0.96);border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;font-family:Inter,'Segoe UI',Tahoma,sans-serif;font-size:${fontSize}px;z-index:5;box-shadow:0 1px 5px rgba(0,0,0,0.1);`;
    el.innerHTML = `<div style="font-weight:700;color:#1f2937;margin-bottom:8px;">% Feature</div>${rows}`;

    if (getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative';
    hostEl.appendChild(el);
}

// Build and download a standalone legend image (SVG or PNG).
// Circle diameters use the same formula as the main plot, scaled by the download scale factor,
// so the legend circles visually match what appears in the downloaded main plot.
async function downloadSizeLegendFile(legendValues, plotCfg, filename) {
    const scale = plotCfg.imgFormat === 'svg' ? 1 : 6;
    const fontSize = Math.round((plotCfg.legendFontSize || 12) * scale);
    // Match the diameter formula used by the main plot markers
    const diameters = legendValues.map(pct => Math.round(percentToBubbleDiameter(pct, MAX_BUBBLE_DIAMETER_PX) * scale));
    const maxDiam = Math.max(...diameters);
    const rowH = maxDiam + Math.round(8 * scale);
    const pad = Math.round(10 * scale);
    const titleH = Math.round(fontSize + 8 * scale);
    const labelGap = Math.round(8 * scale);
    const labelW = Math.round(36 * scale);
    const totalW = pad + maxDiam + labelGap + labelW + pad;
    const totalH = pad + titleH + legendValues.length * rowH + pad;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', totalW);
    svg.setAttribute('height', totalH);

    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', 0); bg.setAttribute('y', 0);
    bg.setAttribute('width', totalW); bg.setAttribute('height', totalH);
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    const titleEl = document.createElementNS(ns, 'text');
    titleEl.setAttribute('x', pad); titleEl.setAttribute('y', pad + fontSize);
    titleEl.setAttribute('font-size', fontSize); titleEl.setAttribute('font-weight', 'bold');
    titleEl.setAttribute('fill', '#1f2937'); titleEl.setAttribute('font-family', 'Segoe UI, Tahoma, sans-serif');
    titleEl.textContent = '% Feature';
    svg.appendChild(titleEl);

    const bodyTop = pad + titleH;
    legendValues.forEach((pct, i) => {
        const d = diameters[i];
        const cx = pad + maxDiam / 2;
        const cy = bodyTop + i * rowH + maxDiam / 2;

        const circ = document.createElementNS(ns, 'circle');
        circ.setAttribute('cx', cx); circ.setAttribute('cy', cy);
        circ.setAttribute('r', d / 2); circ.setAttribute('fill', '#94a3b8');
        circ.setAttribute('fill-opacity', '0.85'); circ.setAttribute('stroke', '#7c8794');
        circ.setAttribute('stroke-width', Math.max(1, Math.round(1.2 * scale)));
        svg.appendChild(circ);

        const lbl = document.createElementNS(ns, 'text');
        lbl.setAttribute('x', pad + maxDiam + labelGap);
        lbl.setAttribute('y', cy + fontSize * 0.35);
        lbl.setAttribute('font-size', fontSize); lbl.setAttribute('fill', '#334155');
        lbl.setAttribute('font-family', 'Segoe UI, Tahoma, sans-serif');
        lbl.textContent = pct + '%';
        svg.appendChild(lbl);
    });

    const svgStr = new XMLSerializer().serializeToString(svg);
    if (plotCfg.imgFormat === 'svg') {
        _downloadBlob(new Blob([svgStr], { type: 'image/svg+xml' }), filename + '.svg');
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = totalW; canvas.height = totalH;
        const ctx = canvas.getContext('2d');
        const blobUrl = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(blobUrl);
                canvas.toBlob(b => { _downloadBlob(b, filename + '.png'); resolve(); }, 'image/png');
            };
            img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('Legend render failed')); };
            img.src = blobUrl;
        });
    }
}

function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
}

// Download 2 separate files: the main plot and a standalone % Feature legend.
// Both use the same format (SVG or PNG) and the same scale, so circle sizes in the legend
// visually match the corresponding circles in the main plot download.
async function downloadPlotWithSizeLegend(gd, plotCfg, filename) {
    Plotly.downloadImage(gd, {
        format: plotCfg.imgFormat,
        width: plotCfg.imgWidth,
        height: plotCfg.imgHeight,
        scale: plotCfg.imgFormat === 'svg' ? 1 : 6,
        filename,
    });
    await downloadSizeLegendFile(buildDotLegendValues(), plotCfg, filename + '_legend');
}

function renderBubbleLegend(container, title, sizeLegendValues, maxLegendDiameterPx = MAX_BUBBLE_DIAMETER_PX, fontSize = 12) {
    if (!container) return;
    container.innerHTML = `
        <div data-role="legend-stack" style="display:flex; flex-direction:column; gap:14px; width:100%; color:#344054; align-items:flex-start;">
            <div style="font-size:${fontSize}px; font-weight:700; color:#1f2937;">${escapeHtmlAttr(title)}</div>
            ${sizeLegendValues.map((value) => {
                const diameterPx = percentToBubbleDiameter(value, maxLegendDiameterPx, 0);
                return `
                    <div style="display:flex; align-items:center; gap:12px; min-height:${Math.max(diameterPx, 20)}px;">
                        <div style="width:${diameterPx}px; height:${diameterPx}px; border-radius:999px; border:1.2px solid #7c8794; background:#c5ced8; flex:0 0 auto;"></div>
                        <div style="font-size:${Math.max(9, fontSize - 1)}px; color:#475467;">${Math.min(100, value)}%</div>
                    </div>
                `;
            }).join("")}
        </div>
    `;
}

function renderColorLegend(container, title, minValue, maxValue, gradientStops, fontSize = 12) {
    if (!container) return;
    const legendStack = container.querySelector('[data-role="legend-stack"]');
    if (!legendStack) return;

    const safeMin = Number.isFinite(minValue) ? minValue : 0;
    const safeMax = Number.isFinite(maxValue) ? maxValue : safeMin;
    const tickCount = 5;
    const ticks = Array.from({ length: tickCount }, (_, index) => {
        if (tickCount === 1 || safeMax === safeMin) return safeMax;
        const ratio = 1 - (index / (tickCount - 1));
        return safeMin + ((safeMax - safeMin) * ratio);
    });
    const gradient = gradientStops.join(", ");

    legendStack.insertAdjacentHTML("beforeend", `
        <div style="display:flex; flex-direction:column; gap:10px; width:100%; margin-top:6px;">
            <div style="font-size:${fontSize}px; font-weight:700; color:#1f2937;">${escapeHtmlAttr(title)}</div>
            <div style="display:flex; align-items:stretch; gap:10px; min-height:132px;">
                <div style="width:16px; border-radius:999px; background:linear-gradient(to top, ${gradient}); border:1px solid #d0d5dd;"></div>
                <div style="display:flex; flex-direction:column; justify-content:space-between; font-size:${Math.max(9, fontSize - 1)}px; color:#475467; min-height:132px;">
                    ${ticks.map((value) => `<div>${value.toFixed(2)}</div>`).join("")}
                </div>
            </div>
        </div>
    `);
}

function normalizeNetworkCoordinate(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function buildNetworkNodes(selectedRows) {
    const payloadNodes = new Map(
        ((enrichmentPayload.network?.nodes || []).filter((node) => selectedDatabases.has(node.database))).map((node) => [node.term_id, node])
    );
    const ora = isOraMode();

    const nodes = selectedRows.map((row) => {
        const payloadNode = payloadNodes.get(row.term_id);
        const nesValue = ora
            ? -Math.log10(Math.max(Number(row["p-value"]) || 1, 1e-300))
            : Number(payloadNode?.nes ?? row.NES) || 0;
        return {
            term_id: row.term_id,
            term: row.Term,
            database: row.Database,
            nes: nesValue,
            fdr: Number(payloadNode?.fdr ?? row.FDR) || 1,
            hits_ratio: clampPercent(parseFeatureSetPercent(row["Feature percent"] ?? row["Gene percent"])),
            node_idx: payloadNode?.node_idx ?? null,
            x: normalizeNetworkCoordinate(payloadNode?.x),
            y: normalizeNetworkCoordinate(payloadNode?.y),
            hasPayloadPosition: Boolean(payloadNode),
        };
    });

    const positionedNodes = nodes.filter((node) => node.hasPayloadPosition);
    const missingNodes = nodes.filter((node) => !node.hasPayloadPosition);
    const maxAbsX = Math.max(...positionedNodes.map((node) => Math.abs(node.x)), 1);
    const maxAbsY = Math.max(...positionedNodes.map((node) => Math.abs(node.y)), 1);
    const fallbackRadiusX = maxAbsX * 1.35;
    const fallbackRadiusY = maxAbsY * 1.35;

    missingNodes.forEach((node, index) => {
        const angle = (2 * Math.PI * index) / Math.max(missingNodes.length, 1);
        node.x = Math.cos(angle) * fallbackRadiusX;
        node.y = Math.sin(angle) * fallbackRadiusY;
    });

    return nodes;
}

function buildNetworkEdges(nodes) {
    const nodeIds = new Set(nodes.map((node) => node.node_idx).filter((value) => value !== null));
    return (enrichmentPayload.network?.edges || []).filter((edge) => nodeIds.has(edge.src_idx) && nodeIds.has(edge.targ_idx));
}

function getNetworkBounds(nodes, sizes) {
    const xs = nodes.map((node) => Number(node.x) || 0);
    const ys = nodes.map((node) => Number(node.y) || 0);
    const maxMarkerPx = Math.max(...sizes, MIN_BUBBLE_DIAMETER_PX);
    const xMin = Math.min(...xs, -1);
    const xMax = Math.max(...xs, 1);
    const yMin = Math.min(...ys, -1);
    const yMax = Math.max(...ys, 1);
    const xSpan = Math.max(xMax - xMin, 1);
    const ySpan = Math.max(yMax - yMin, 1);
    const padFactor = 0.08 + (maxMarkerPx / 300);
    return {
        xRange: [xMin - xSpan * padFactor, xMax + xSpan * padFactor],
        yRange: [yMin - ySpan * padFactor, yMax + ySpan * padFactor],
    };
}

function buildWeightedEdgeTraces(nodes, edges, nodeMap) {
    const maxWeight = Math.max(...edges.map((edge) => Number(edge.jaccard_coef || edge.overlap_coef || 0)), 0.001);
    return edges.map((edge) => {
        const src = nodeMap.get(edge.src_idx);
        const targ = nodeMap.get(edge.targ_idx);
        if (!src || !targ) return null;
        const weight = Number(edge.jaccard_coef || edge.overlap_coef || 0);
        const normalized = Math.max(0.15, weight / maxWeight);
        return {
            x: [src.x, targ.x],
            y: [src.y, targ.y],
            type: "scatter",
            mode: "lines",
            line: {
                color: `rgba(120, 144, 156, ${Math.min(0.2 + normalized * 0.75, 0.95)})`,
                width: 0.5 + normalized * 2.4,
            },
            hoverinfo: "skip",
            showlegend: false,
        };
    }).filter(Boolean);
}

function parseFeatureSetPercent(value) {
    if (typeof value === "string") {
        if (value.endsWith("%")) return parseFloat(value);
        if (value.includes("/")) {
            const [lhs, rhs] = value.split("/").map((item) => Number(item));
            if (Number.isFinite(lhs) && Number.isFinite(rhs) && rhs > 0) {
                return (lhs / rhs) * 100;
            }
        }
    }
    if (Number.isFinite(Number(value))) return Number(value);
    return 0;
}

function renderTable() {
    const rows = getFilteredTerms();
    const totalTerms = (enrichmentPayload.results_table || []).length;
    const { pageRows, totalPages } = getPagedTerms(rows);
    const ora = isOraMode();
    const filterLabel = ora ? "p-value" : "FDR";
    dom.tableSummary().textContent = `${rows.length}/${totalTerms} terms shown | ${filterLabel} <= ${getMaxFdrFilter()}`;
    dom.pageInfo().textContent = `Page ${currentPage}/${totalPages}`;
    updateSelectionSummary();

    if (!rows.length) {
        clearSelectionWarning();
        dom.termTableBody().innerHTML = `<tr><td colspan="${ora ? 4 : 5}" class="text-center text-muted py-4">No terms match current filters.</td></tr>`;
        renderPagination(totalPages);
        updateSelectAllCheckbox();
        return;
    }

    if (!rows.some((row) => row.term_id === activeTermId)) {
        activeTermId = rows[0].term_id;
        checkedTermIds.add(activeTermId);
    }

    dom.termTableBody().innerHTML = pageRows.map((row) => {
        const dataCells = ora
            ? `<td>${Number(row["p-value"]).toExponential(2)}</td><td>${Number(row["Feature count"] ?? row["Gene count"] ?? 0)}</td>`
            : `<td>${Number(row.ES).toFixed(3)}</td><td>${Number(row.NES).toFixed(3)}</td><td>${Number(row.FDR).toExponential(2)}</td>`;
        return `
        <tr class="${row.term_id === activeTermId ? "active" : ""}" data-term-id="${row.term_id}" title="${escapeHtmlAttr(`${row.Term} | ${row.Database}`)}">
            <td><input class="form-check-input term-check" type="checkbox" value="${row.term_id}" ${checkedTermIds.has(row.term_id) ? "checked" : ""}></td>
            <td><div class="term-name">${row.Term}</div><div class="small-note">${row.Database}</div></td>
            ${dataCells}
        </tr>`;
    }).join("");

    dom.termTableBody().querySelectorAll("tr").forEach((rowEl) => {
        rowEl.onclick = (event) => {
            const termId = rowEl.dataset.termId;
            const checkbox = rowEl.querySelector(".term-check");
            if (event.target.classList.contains("term-check")) return;
            activeTermId = termId;
            if (!checkbox.checked) {
                checkbox.checked = true;
                toggleTermSelection(termId, true);
                return;
            }
            renderTable();
            renderVisualization();
        };
    });
    dom.termTableBody().querySelectorAll(".term-check").forEach((checkbox) => {
        checkbox.onchange = (event) => toggleTermSelection(event.target.value, event.target.checked, event.target);
    });

    updateSelectAllCheckbox();
    renderPagination(totalPages);
}

function toggleTermSelection(termId, checked, checkboxElement = null) {
    clearSelectionWarning();
    if (checked && !checkedTermIds.has(termId) && isGseaMode() && !canAddMoreSelections(1)) {
        if (checkboxElement) checkboxElement.checked = false;
        showSelectionWarning(`Maximum is ${GSEA_MAX_SELECTION}.`);
        updateSelectAllCheckbox();
        return;
    }

    if (checked) checkedTermIds.add(termId);
    else checkedTermIds.delete(termId);
    activeTermId = termId;
    renderTable();
    renderVisualization();
}

function renderPagination(totalPages) {
    const controls = [];
    controls.push({ label: "<<", page: 1, disabled: currentPage === 1 });
    controls.push({ label: "<", page: Math.max(1, currentPage - 1), disabled: currentPage === 1 });
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, start + 4);
    for (let page = start; page <= end; page++) {
        controls.push({ label: String(page), page, active: page === currentPage });
    }
    controls.push({ label: ">", page: Math.min(totalPages, currentPage + 1), disabled: currentPage === totalPages });
    controls.push({ label: ">>", page: totalPages, disabled: currentPage === totalPages });

    dom.paginationControls().innerHTML = controls.map((item) => `
        <button class="btn btn-sm btn-outline-secondary ${item.active ? "active" : ""}" data-page="${item.page}" ${item.disabled ? "disabled" : ""}>${item.label}</button>
    `).join("");
    dom.paginationControls().querySelectorAll("button").forEach((button) => {
        button.onclick = () => {
            currentPage = Number(button.dataset.page);
            renderTable();
        };
    });
}

function getActiveDetail() {
    return getTermDetail(activeTermId);
}

function renderVisualization() {
    const mode = dom.viewMode().value;
    mountConfigForMode(mode);
    _renderCurrentView();
}

function renderGseaPlot() {
    clearPlotHost();
    const selectedRows = getSelectedRows({ limit: GSEA_MAX_SELECTION, fallbackToActive: true });
    const rankedRows = enrichmentPayload.ranking_preview || [];
    if (!selectedRows.length) {
        renderEmpty(`Select up to ${GSEA_MAX_SELECTION} terms to visualize the enrichment score profile.`);
        return;
    }
    if (!rankedRows.length) {
        renderEmpty("Ranking preview is not available for this enrichment run.");
        return;
    }

    const colors = ["#ff8a1f", "#4daf3c", "#6f59ff"];
    const xValues = rankedRows.map((_, index) => index + 1);
    const rankingMetric = rankedRows.map((row) => Number(row.Rank) || 0);
    const rankingCustomData = rankedRows.map((row, index) => buildRankingCustomDatum(row, index));
    const fdrMetric = rankedRows.map((row) => {
        const fdr = Math.max(Number(row.FDR) || 1e-300, 1e-300);
        const rank = Number(row.Rank) || 0;
        return -Math.sign(rank || 1) * -Math.log10(fdr);
    });
    const traces = [];
    selectedRows.forEach((row, index) => {
        const detail = getTermDetail(row.term_id);
        if (!detail?.running_score?.length) return;
        const color = colors[index % colors.length];
        traces.push({
            x: xValues,
            y: detail.running_score,
            customdata: rankingCustomData,
            type: "scatter",
            mode: "lines",
            line: { color, width: 2.4 },
            name: `${detail.term} (${detail.database})`,
            xaxis: "x",
            yaxis: "y",
            hovertemplate: `${escapeHtmlAttr(detail.term)}<br>Feature: %{customdata[0]}<br>ES: %{y:.3f}<br>LogFC: %{customdata[2]:.3f}<br>FDR: %{customdata[3]:.2e}<extra></extra>`
        });
        const hitCustomData = (detail.hit_indices || []).map((value) => buildRankingCustomDatum(rankedRows[value], value));
        traces.push({
            x: (detail.hit_indices || []).map((value) => value + 1),
            y: new Array((detail.hit_indices || []).length).fill(index + 1),
            customdata: hitCustomData,
            type: "scatter",
            mode: "markers",
            marker: { symbol: "line-ns-open", size: 18, color },
            name: "",
            showlegend: false,
            xaxis: "x2",
            yaxis: "y2",
            hovertemplate: `${escapeHtmlAttr(detail.term)}<br>Feature: %{customdata[0]}<br>LogFC: %{customdata[2]:.3f}<br>FDR: %{customdata[3]:.2e}<extra></extra>`
        });
    });

    traces.push({
        x: xValues,
        y: [0],
        z: [fdrMetric],
        type: "heatmap",
        colorscale: [
            [0, "#d73a49"],
            [0.5, "#f6f8fa"],
            [1, "#2f81f7"]
        ],
        zmid: 0,
        showscale: false,
        xaxis: "x3",
        yaxis: "y3",
        hovertemplate: "Rank: %{x}<br>signed -log10(FDR): %{z:.3f}<extra></extra>"
    });

    traces.push({
        x: xValues,
        y: rankingMetric,
        customdata: rankingCustomData,
        type: "scatter",
        mode: "lines",
        fill: "tozeroy",
        line: { color: "#9aa4b2", width: 1.2 },
        fillcolor: "rgba(154,164,178,0.35)",
        name: "sign(LogFC) x -log10(FDR)",
        showlegend: false,
        xaxis: "x4",
        yaxis: "y4",
        hovertemplate: "Feature: %{customdata[0]}<br>Metric: %{y:.3f}<br>LogFC: %{customdata[2]:.3f}<br>FDR: %{customdata[3]:.2e}<extra></extra>"
    });

    dom.vizContext().textContent = `GSEA profile for ${selectedRows.length} selected term${selectedRows.length > 1 ? "s" : ""}.`;

    Plotly.newPlot(dom.plotHost(), traces, {
        margin: { t: 34, r: 12, b: 48, l: 60 },
        font: { family: "Segoe UI, Tahoma, sans-serif", size: 11, color: "#334155" },
        dragmode: false,
        hovermode: "closest",
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: true,
        legend: { orientation: "h", x: 0, y: 1.13, font: { size: plotConfig.legendFontSize } },
        xaxis: { domain: [0, 1], anchor: "y", showticklabels: false, range: [1, xValues.length] },
        yaxis: { domain: [0.60, 1], title: { text: "Enrichment Score (ES)", font: { size: plotConfig.axisFontSize } }, tickfont: { size: Math.max(8, plotConfig.axisFontSize - 2) }, zeroline: true, zerolinecolor: "#c9d2db" },
        xaxis2: { domain: [0, 1], anchor: "y2", showticklabels: false, showgrid: false, zeroline: false, range: [1, xValues.length] },
        yaxis2: {
            domain: [0.44, 0.57],
            title: "",
            showticklabels: false,
            showgrid: false,
            zeroline: false,
            range: [0.4, Math.max(selectedRows.length + 0.6, 1.6)]
        },
        xaxis3: { domain: [0, 1], anchor: "y3", showticklabels: false, range: [1, xValues.length] },
        yaxis3: { domain: [0.36, 0.42], visible: false },
        xaxis4: { domain: [0, 1], anchor: "y4", title: { text: "Rank in ordered dataset", font: { size: plotConfig.axisFontSize } }, tickfont: { size: Math.max(8, plotConfig.axisFontSize - 2) }, range: [1, xValues.length] },
        yaxis4: { domain: [0, 0.30], title: { text: "sign(LogFC) x -log10(FDR)", font: { size: plotConfig.axisFontSize } }, tickfont: { size: Math.max(8, plotConfig.axisFontSize - 2) }, zeroline: true, zerolinecolor: "#c9d2db" },
        shapes: [
            { type: "line", xref: "paper", yref: "paper", x0: 0.045, x1: 0.045, y0: 0.355, y1: 0.375, line: { color: "#b42318", width: 1.4 } },
            { type: "line", xref: "paper", yref: "paper", x0: 0.090, x1: 0.090, y0: 0.355, y1: 0.375, line: { color: "#b42318", width: 1.4 } },
            { type: "line", xref: "paper", yref: "paper", x0: 0.910, x1: 0.910, y0: 0.355, y1: 0.375, line: { color: "#175cd3", width: 1.4 } },
            { type: "line", xref: "paper", yref: "paper", x0: 0.955, x1: 0.955, y0: 0.355, y1: 0.375, line: { color: "#175cd3", width: 1.4 } },
        ],
        annotations: [
            { xref: "paper", yref: "paper", x: 0, y: 0.312, text: "Up-regulated", xanchor: "left", showarrow: false, font: { size: 12, color: "#b42318" } },
            { xref: "paper", yref: "paper", x: 1, y: 0.312, text: "Down-regulated", xanchor: "right", showarrow: false, font: { size: 12, color: "#175cd3" } },
            { xref: "paper", yref: "paper", x: 0.5, y: 0.405, text: "FDR (from DEA)", showarrow: false, align: "center", font: { size: 12, color: "#000000" } },
            ...buildFdrStripAnnotations(),
        ],
    }, {
        responsive: true,
        displaylogo: false,
        displayModeBar: "hover",
        scrollZoom: false,
        doubleClick: false,
        showAxisDragHandles: false,
        showAxisRangeEntryBoxes: false,
        toImageButtonOptions: { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === 'svg' ? 1 : 6 },
    });
}

function renderDotPlot() {
    const selectedRows = getSelectedRows({ fallbackToActive: true });
    if (!selectedRows.length) {
        renderEmpty("Select at least one term to build the dot plot.");
        return;
    }

    const rows = [...selectedRows].reverse();
    clearPlotHost();
    const termAxisValues = rows.map((row) => row.term_id);
    const labelLineLen = Math.max(14, Math.round(220 / plotConfig.labelFontSize));
    const wrappedTerms = rows.map((row) => wrapTermLabelFull(row.Term, labelLineLen));
    const colorValues = rows.map((row) => -Math.log10(Math.max(Number(row.FDR) || 1e-300, 1e-300)));
    const sizePercents = rows.map((row) => clampPercent(parseFeatureSetPercent(row["Feature percent"] ?? row["Gene percent"])));
    const sizeValues = sizePercents.map((percent) => percentToBubbleDiameter(percent, MAX_BUBBLE_DIAMETER_PX));

    const traces = [{
        x: rows.map((row) => Number(row.NES)),
        y: termAxisValues,
        mode: "markers",
        type: "scatter",
        showlegend: false,
        marker: {
            size: sizeValues,
            sizemode: "diameter",
            sizeref: MAX_BUBBLE_DIAMETER_PX / MAX_LEGEND_ICON_PX,
            opacity: 1,
            color: colorValues,
            colorscale: "Viridis",
            colorbar: {
                title: { text: "-log10FDR", font: { size: plotConfig.legendFontSize }, side: "right" },
                thickness: 14,
                len: 0.5,
                x: 1.03,
                y: 1, yanchor: "top",
                tickfont: { size: Math.max(8, plotConfig.legendFontSize - 1) }
            },
            line: {
                color: rows.map(() => "#ffffff"),
                width: rows.map(() => 1)
            }
        },
        text: rows.map((row) => row.Term),
        customdata: rows.map((row, index) => [
            row.Term,
            row.Database,
            Number(row.NES).toFixed(3),
            Number(row.FDR).toExponential(2),
            sizePercents[index].toFixed(1)
        ]),
        hovertemplate: "%{customdata[0]}<br>%{customdata[1]}<br>NES: %{customdata[2]}<br>FDR: %{customdata[3]}<br>% Feature in set: %{customdata[4]}%<extra></extra>"
    }];

    dom.vizContext().textContent = `Dot plot for ${rows.length} selected term${rows.length > 1 ? "s" : ""}.`;
    Plotly.newPlot(dom.plotHost(), traces, {
        margin: { t: 12, r: 110, b: 44, l: 168 },
        xaxis: { title: { text: "NES", font: { size: plotConfig.axisFontSize } }, automargin: true, tickfont: { size: Math.max(8, plotConfig.axisFontSize - 2) } },
        yaxis: {
            automargin: true,
            tickmode: "array",
            tickvals: termAxisValues,
            ticktext: wrappedTerms,
            tickfont: { size: plotConfig.labelFontSize },
            side: "left",
        },
        hovermode: "closest",
        font: { family: "Inter, Segoe UI, Tahoma, sans-serif", size: 11, color: "#334155" },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: false,
    }, { responsive: true, displaylogo: false, displayModeBar: "hover", scrollZoom: true, modeBarButtonsToRemove: ['toImage'], modeBarButtonsToAdd: [{ name: 'Download plot', icon: Plotly.Icons.camera, click: (gd) => Plotly.downloadImage(gd, { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === 'svg' ? 1 : 6, filename: 'enrichment_dot' }) }], edits: { colorbarPosition: true } });
    attachFixedLegend(dom.plotHost(), plotConfig);
}

function renderOraBarChart() {
    const selectedRows = getSelectedRows({ fallbackToActive: true });   
    if (!selectedRows.length) {
        renderEmpty("Select at least one term to build the bar chart.");
        return;
    }

    const rows = [...selectedRows].sort((a, b) => Number(a["p-value"]) - Number(b["p-value"])).reverse();
    const termAxisValues = rows.map((row) => row.term_id);
    const wrappedTerms = rows.map((row) => wrapTermLabel(row.Term, 2, 22));
    const pValues = rows.map((row) => Math.max(Number(row["p-value"]) || 1, 1e-300));
    const colorValues = pValues.map((p) => -Math.log10(p));
    const featureCounts = rows.map((row) => Number(row["Feature count"] ?? row["Gene count"] ?? 0));

    const traces = [{
        x: colorValues,
        y: termAxisValues,
        orientation: "h",
        type: "bar",
        marker: {
            color: colorValues,
            colorscale: "Viridis",
            showscale: true,
            colorbar: { title: "-log10(p-value)", thickness: 14, len: 0.7, x: 1.02 }
        },
        text: rows.map((row, i) => `${row.Term}<br>${row.Database}<br>p-value: ${pValues[i].toExponential(2)}<br>Feature count: ${featureCounts[i]}`),
        hovertemplate: "%{text}<extra></extra>",
    }];

    dom.vizContext().textContent = `Bar chart for ${rows.length} selected term${rows.length > 1 ? "s" : ""}.`;
    Plotly.newPlot(dom.plotHost(), traces, {
        margin: { t: 12, r: 80, b: 44, l: 168 },
        xaxis: { title: { text: "-log10(p-value)", font: { size: plotConfig.axisFontSize } }, automargin: true, tickfont: { size: Math.max(8, plotConfig.axisFontSize - 2) } },
        yaxis: {
            automargin: true,
            tickmode: "array",
            tickvals: termAxisValues,
            ticktext: wrappedTerms,
            tickfont: { size: 10 },
        },
        font: { family: "Segoe UI, Tahoma, sans-serif", size: 11, color: "#334155" },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: false,
    }, { responsive: true, displaylogo: false, displayModeBar: "hover", scrollZoom: true, toImageButtonOptions: { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === 'svg' ? 1 : 6 } });
}

function renderNetworkPlot() {
    const networkRows = getSelectedRows({ fallbackToActive: true });
    if (!networkRows.length) {
        renderEmpty("Select at least one visible term to visualize the network.");
        return;
    }

    clearPlotHost();
    const nodes = buildNetworkNodes(networkRows);
    const edges = buildNetworkEdges(nodes);
    const nodeMap = new Map(nodes.filter((node) => node.node_idx !== null).map((node) => [node.node_idx, node]));
    const edgeTraces = buildWeightedEdgeTraces(nodes, edges, nodeMap);

    const nodeEdgeInfoMap = new Map();
    edges.forEach((edge) => {
        const src = nodeMap.get(edge.src_idx);
        const targ = nodeMap.get(edge.targ_idx);
        if (!src || !targ) return;
        const jaccard = Number(edge.jaccard_coef || 0).toFixed(3);
        const overlapCoef = Number(edge.overlap_coef || 0).toFixed(3);
        const overlapGenes = escapeHtmlAttr(edge.overlap_genes || "-");
        const addEdge = (node, otherNode) => {
            if (!nodeEdgeInfoMap.has(node.term_id)) nodeEdgeInfoMap.set(node.term_id, []);
            nodeEdgeInfoMap.get(node.term_id).push(
                `\u2194 ${escapeHtmlAttr(otherNode.term)}<br>Overlap: ${overlapGenes}<br>Jaccard: ${jaccard} | Overlap coef: ${overlapCoef}`
            );
        };
        addEdge(src, targ);
        addEdge(targ, src);
    });

    const nodePercents = nodes.map((node) => clampPercent(node.hits_ratio));
    const nodeSizes = nodePercents.map((percent) => percentToBubbleDiameter(percent, NETWORK_MAX_BUBBLE_DIAMETER_PX));
    const nodeColorValues = nodes.map((node) => -Math.log10(Math.max(node.fdr, 1e-300)));
    const bounds = getNetworkBounds(nodes, nodeSizes);
    const maxColorVal = Math.max(...nodeColorValues, 0.01);
    dom.vizContext().textContent = `Network visualization for ${nodes.length} selected term${nodes.length > 1 ? "s" : ""}.`;
    Plotly.newPlot(dom.plotHost(), [
        ...edgeTraces,
        {
            x: nodes.map((node) => node.x),
            y: nodes.map((node) => node.y),
            type: "scatter",
            mode: "markers",
            showlegend: false,
            marker: {
                size: nodeSizes,
                sizemode: "diameter",
                sizeref: NETWORK_MAX_BUBBLE_DIAMETER_PX / MAX_LEGEND_ICON_PX,
                opacity: 1,
                color: nodeColorValues,
                cmin: 0,
                cmax: maxColorVal,
                colorscale: "Viridis",
                colorbar: {
                    title: { text: "-log10FDR", font: { size: plotConfig.legendFontSize }, side: "right" },
                    thickness: 14,
                    len: 0.5,
                    x: 1.03,
                    y: 1, yanchor: "top",
                    tickfont: { size: Math.max(8, plotConfig.legendFontSize - 1) }
                },
                line: {
                    color: nodes.map(() => "#ffffff"),
                    width: nodes.map(() => 1)
                }
            },
            text: nodes.map((node) => node.term),
            customdata: nodes.map((node) => {
                const edgeInfos = nodeEdgeInfoMap.get(node.term_id) || [];
                const edgesStr = edgeInfos.length
                    ? `<br>\u2500\u2500\u2500 ${edgeInfos.length} edge${edgeInfos.length !== 1 ? "s" : ""} \u2500\u2500\u2500<br>` + edgeInfos.join("<br>\u2500<br>")
                    : "";

                return [
                    node.term,
                    node.database,
                    `\u2212log\u2081\u2080(FDR): ${(-Math.log10(Math.max(node.fdr, 1e-300))).toFixed(3)}`,
                    `FDR: ${node.fdr.toExponential(2)}`,
                    node.hits_ratio.toFixed(1),
                    edgesStr
                ];
            }),
            hovertemplate: "%{customdata[0]}<br>%{customdata[1]}<br>%{customdata[2]}<br>%{customdata[3]}<br>% Feature: %{customdata[4]}%%{customdata[5]}<extra></extra>",
        },
        {
            x: nodes.map((node) => node.x),
            y: nodes.map((node) => node.y),
            type: "scatter",
            mode: "text",
            text: nodes.map((node) => `<b>${wrapTermLabelFull(node.term, 18)}</b>`),
            textposition: "top center",
            textfont: { size: plotConfig.labelFontSize, color: "#1f2937", family: "Segoe UI Semibold, Segoe UI, sans-serif" },
            cliponaxis: false,
            hoverinfo: "skip",
            showlegend: false
        }
    ], {
        margin: { t: 8, r: 110, b: 4, l: 4 },
        font: { family: "Inter, Segoe UI, Tahoma, sans-serif", size: 11, color: "#334155" },
        hovermode: "closest",
        xaxis: { visible: false, range: bounds.xRange, fixedrange: false },
        yaxis: { visible: false, range: bounds.yRange, fixedrange: false },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: false,
    }, { responsive: true, displaylogo: false, displayModeBar: "hover", scrollZoom: true, modeBarButtonsToRemove: ['toImage'], modeBarButtonsToAdd: [{ name: 'Download plot', icon: Plotly.Icons.camera, click: (gd) => Plotly.downloadImage(gd, { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === 'svg' ? 1 : 6, filename: 'enrichment_network' }) }], edits: { colorbarPosition: true } });
    attachFixedLegend(dom.plotHost(), plotConfig);
}

function renderEmpty(message) {
    dom.vizContext().textContent = message;
    clearPlotHost();
    dom.plotHost().innerHTML = `<div class="plot-empty">${message}</div>`;
}

function escapeHtmlAttr(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}