/**
 * analysis-shared.js
 * Shared factory for common logic across all analysis pages
 * (oplsda, plsda, pca, kmeans, som).
 *
 * Usage:
 *   import { createAnalysisCore } from "./analysis-shared.js";
 *   const { setStatus, safeString, ... } = createAnalysisCore({ ... });
 */

import { doc, getDoc, updateDoc } from "./firebase-config.js";
import { ref, getDownloadURL } from "./firebase-config.js";
import { normalizeTaskStatus, getTaskStatusBadge, formatTaskId } from "./task-utils.js";
import { sortMetadataLabels, normalizeMetaLabel, orderLabelsByGroups } from "./meta-label-utils.js";
import { openAppendMetaModal } from "./append-meta-modal.js";
import { openMetadataManagerModal } from "./metadata-manager-modal.js";
import { withInteractionLock } from "./ui-busy-lock.js";
import { mountTerminalWidget } from "./terminal-widget.js";

// ── MODULE-LEVEL UTILITY EXPORTS ─────────────────────────────────────────────
// These pure functions are also available as named exports so standalone pages
// (kmeans.js, som.js) can import them directly without using the factory.

/** Normalize a metadata label value (trim, stringify). */
export function safeString(value) {
    return normalizeMetaLabel(value);
}

/** Update a status element's text and CSS class. */
export function setStatus(element, message, isError = false) {
    if (!element) return;
    element.textContent = message;
    element.className = `status-msg ${isError ? "text-danger" : "text-muted"}`;
}

/**
 * @param {object} ctx
 * @param {object}   ctx.state             - The module's reactive state object
 * @param {object}   ctx.dom               - The module's DOM element map
 * @param {object}   ctx.db                - database instance
 * @param {object}   ctx.storage           - local storage instance
 * @param {string}   ctx.projectId         - Current project ID
 * @param {string}   ctx.vpsUrl            - Backend VPS base URL
 * @param {object}   ctx.featureIn         - Feature-in module instance
 * @param {object}   ctx.paletteMap        - Map of palette name → color array
 *
 * @param {string}   ctx.historyKey        - field name ("oplsda_history", etc.)
 * @param {string}   ctx.activePageFile    - Filename for sidebar active link ("oplsda.html", etc.)
 * @param {string}   [ctx.runLabel]        - Human-readable run type prefix ("OPLS-DA", "PCA", …)
 *                                           Leave undefined for kmeans/som (just show run.name).
 * @param {function} ctx.statusEl          - () => HTMLElement  — returns the page's status <div>
 * @param {function} ctx.applyRunSelection - (run, fromHistory) => void  — page-specific
 *
 * Optional per-page customisations:
 * @param {function} [ctx.extraRunFields]       - (record) => {}  extra fields for normalizeRunRecord
 * @param {function} [ctx.extraRunFields] - (record) => {}  extra fields for buildRunRecords
 * @param {function} [ctx.onSwatchClick]        - (label, swatchEl, event) => void  [oplsda: color picker]
 * @param {string}   [ctx.colorByHeader]        - HTML string prepended to colorBySelect [kmeans]
 * @param {string}   [ctx.defaultColorBy]       - Fallback colorBy when current is deleted [kmeans: "__kmeans_cluster__"]
 * @param {function} [ctx.buildRunTooltip]      - (run) => string  custom tooltip for history items
 * @param {function} [ctx.renderRunConfig]      - (run) => string  extra config HTML in history item
 * @param {function} [ctx.onRunDeleted]         - () => void  called when the active run is deleted
 * @param {function} [ctx.resolvePointLabel]    - (point, meta) => string  custom point-label resolver [kmeans]
 * @param {function} [ctx.applyEditGuard]       - (sourceColumn) => boolean  guard for applyMetadataColumnEdits
 */
export function createAnalysisCore(ctx) {
    const {
        state, dom, db, storage, projectId, vpsUrl, featureIn, paletteMap,
        historyKey, activePageFile,
    } = ctx;

    // ── PURE UTILITIES ──────────────────────────────────────────────────

    /** Sanitize a string for use as a file/run name suffix (no HTML escaping). */
    function sanitizeSuffix(value) {
        return (value || "").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    }

    /** HTML-escape a value for safe use in innerHTML. */
    function sanitizeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function labelOrNone(value) {
        return value && value !== "None" ? value : "None";
    }

    function isBusyRun(run) {
        return ["pending", "running"].includes(normalizeTaskStatus(run?.status));
    }

    function dedupeRuns(runs) {
        const seen = new Set();
        return runs.filter((r) => {
            if (!r.run_id || seen.has(r.run_id)) return false;
            seen.add(r.run_id);
            return true;
        });
    }

    // ── HIGHLIGHT / SELECTION ────────────────────────────────────────────

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

    // ── RUN RECORD MANAGEMENT ────────────────────────────────────────────

    function getCurrentRun() {
        return state.runs.find((r) => r.run_id === state.currentRunId) || null;
    }

    function normalizeRunRecord(record) {
        return {
            run_id: record.run_id,
            task_id: record.task_id || null,
            name: record.name,
            config: record.config || null,
            data: record.data || {},
            data_path: record.data_path || null,
            date: record.date || new Date().toISOString(),
            status: normalizeTaskStatus(record.status),
            message: record.message || "",
            started_at: record.started_at || record.date || null,
            updated_at: record.updated_at || record.date || null,
            completed_at: record.completed_at || null,
            ...ctx.extraRunFields?.(record),
        };
    }

    function dedupeRunsInternal(runs) {
        return dedupeRuns(runs);
    }

    function upsertRun(run) {
        state.runs = dedupeRunsInternal([
            normalizeRunRecord(run),
            ...state.runs.filter((item) => item.run_id !== run.run_id),
        ]);
    }

    function buildRunRecords(runs) {
        return runs.map((run) => ({
            run_id: run.run_id,
            task_id: run.task_id || null,
            name: run.name,
            config: run.config || null,
            data_path: run.data_path || null,
            date: run.date || new Date().toISOString(),
            status: normalizeTaskStatus(run.status),
            message: run.message || "",
            started_at: run.started_at || run.date || null,
            updated_at: run.updated_at || run.date || null,
            completed_at: run.completed_at || null,
            ...ctx.extraRunFields?.(run),
        }));
    }

    async function persistRuns() {
        if (!projectId) return;
        await updateDoc(doc(db, "projects", projectId), { [historyKey]: buildRunRecords(state.runs) });
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
        if (!run.data_path) {
            setStatus(ctx.statusEl(), "Run data unavailable (no data_path). Please re-run.", true);
            return false;
        }
        try {
            let fileUrl = run.data_path;
            if (!fileUrl.startsWith("http://") && !fileUrl.startsWith("https://")) {
                fileUrl = await getDownloadURL(ref(storage, run.data_path));
            }
            // Bound the fetch so a stalled request cannot leave the page
            // spinner running forever.
            const response = await fetch(fileUrl, { signal: AbortSignal.timeout(120000) });
            if (!response.ok) throw new Error("Failed to load run data from local storage");
            run.data = await response.json();
            const stateRun = state.runs.find((r) => r.run_id === run.run_id);
            if (stateRun && stateRun !== run) stateRun.data = run.data;
            return true;
        } catch (e) {
            const message = e?.name === "TimeoutError"
                ? "Loading run data timed out. Please re-run this analysis."
                : (e.message || String(e));
            setStatus(ctx.statusEl(), message, true);
            return false;
        }
    }

    // ── NORMALIZATION DISPLAY ────────────────────────────────────────────

    function getNormalizationConfig() {
        return state.projectData?.norm_settings || state.projectData?.normalization_config || null;
    }

    function getNormalityStat() {
        return (
            state.projectData?.normality_stat ||
            state.projectData?.normalityStat ||
            state.projectData?.normality_stats ||
            null
        );
    }

    function renderNormalizationSummary() {
        if (window.renderNormSummary) window.renderNormSummary(getNormalizationConfig(), getNormalityStat());
    }

    // ── VIZ STATE ────────────────────────────────────────────────────────

    function toggleViz(show) {
        if (dom.vizEmpty) dom.vizEmpty.style.display = show ? "none" : "flex";
        if (dom.vizContent) dom.vizContent.classList.toggle("active", show);
        if (dom.vizSettingsLeft) dom.vizSettingsLeft.style.display = show ? "block" : "none";
    }

    // ── FEATURE OVERLAY ──────────────────────────────────────────────────

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

    // ── COLOR / GROUPING ─────────────────────────────────────────────────

    /**
     * Build a color map for the given label list.
     * Uses state.customLabelColors when available (oplsda/plsda/pca).
     */
    function buildColorMap(labels) {
        const palette = paletteMap[state.palette] || paletteMap.vivid;
        const result = new Map();
        let index = 0;
        labels.forEach((label) => {
            if (label === "NaN") {
                result.set(label, "#ccc");
            } else {
                const defaultColor = palette[index % palette.length];
                index += 1;
                if (state.customLabelColors?.[label]) {
                    result.set(label, state.customLabelColors[label]);
                } else {
                    result.set(label, defaultColor);
                }
            }
        });
        return result;
    }

    /**
     * Group plot_points by colorBy metadata column.
     * Pass ctx.resolvePointLabel for custom label resolution (e.g. kmeans clusters).
     */
    function groupPoints(run) {
        const metaById = new Map((run.data?.metadata || []).map((item) => [String(item.sample_id), item]));
        const grouped = new Map();
        (run.data?.plot_points || []).forEach((point) => {
            let label;
            if (ctx.resolvePointLabel) {
                label = ctx.resolvePointLabel(point, metaById.get(String(point.sample_id)) || {});
            } else {
                const meta = metaById.get(String(point.sample_id)) || {};
                label = state.colorBy ? safeString(meta[state.colorBy]) : safeString(point.group);
            }
            if (!grouped.has(label)) grouped.set(label, []);
            grouped.get(label).push(point);
        });
        // Reorder groups by the user-saved order (meta_metadata[].groups) for
        // the current colorBy column, so plots/legends follow the saved ranking.
        const savedGroups = (state.projectData?.meta_metadata || []).find((m) => m?.name === state.colorBy)?.groups;
        if (Array.isArray(savedGroups) && savedGroups.length) {
            const ordered = new Map();
            const norm = (s) => String(s ?? "").trim().toLowerCase();
            savedGroups.forEach((g) => {
                const key = norm(g);
                for (const [label, pts] of grouped) {
                    if (norm(label) === key && !ordered.has(label)) { ordered.set(label, pts); }
                }
            });
            // Append any labels not in savedGroups (e.g. newly appeared).
            for (const [label, pts] of grouped) {
                if (!ordered.has(label)) ordered.set(label, pts);
            }
            return ordered;
        }
        return grouped;
    }

    /**
     * Compute a confidence ellipse trace (95% CI) for a group of points.
     * Returns a Plotly scatter trace with toself fill, or null if < 3 points.
     */
    function ellipseTraceForGroup(label, points, color, fillOpacity = 0x2A / 255) {
        if (points.length < 3) return null;
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
        const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
        let sxx = 0; let sxy = 0; let syy = 0;
        for (let i = 0; i < xs.length; i += 1) {
            const dx = xs[i] - meanX; const dy = ys[i] - meanY;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
        sxx /= (xs.length - 1); sxy /= (xs.length - 1); syy /= (xs.length - 1);
        const trace = sxx + syy;
        const determinant = sxx * syy - sxy * sxy;
        const root = Math.sqrt(Math.max((trace * trace) / 4 - determinant, 0));
        const lambda1 = trace / 2 + root;
        const lambda2 = trace / 2 - root;
        if (!isFinite(lambda1) || !isFinite(lambda2) || lambda1 <= 0 || lambda2 <= 0) return null;
        const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const axisA = Math.sqrt(lambda1 * 5.991);
        const axisB = Math.sqrt(lambda2 * 5.991);
        const ex = []; const ey = [];
        for (let i = 0; i <= 90; i += 1) {
            const theta = (2 * Math.PI * i) / 90;
            const cosT = Math.cos(theta); const sinT = Math.sin(theta);
            ex.push(meanX + axisA * cosT * Math.cos(angle) - axisB * sinT * Math.sin(angle));
            ey.push(meanY + axisA * cosT * Math.sin(angle) + axisB * sinT * Math.cos(angle));
        }
        const alphaHex = Math.round(Math.max(0, Math.min(1, fillOpacity)) * 255).toString(16).padStart(2, "0");
        return {
            type: "scatter", mode: "lines", x: ex, y: ey,
            line: { color: "transparent", width: 0 },
            fill: "toself", fillcolor: `${color}${alphaHex}`,
            hoverinfo: "skip", showlegend: false,
            name: `${label} ellipse`,
        };
    }

    // ── LEGEND ───────────────────────────────────────────────────────────

    function rgbStringToHex(color) {
        const matches = String(color || "").match(/\d+/g);
        if (!matches || matches.length < 3) return "#ff000d";
        return `#${matches.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
    }

    /**
     * Opens a native color picker to let the user change a legend swatch color.
     * Requires state.customLabelColors to be defined on the page's state object.
     */
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
            ctx.renderPlot();
        }, { once: true });
        document.body.appendChild(colorInput);
        if (typeof colorInput.showPicker === "function") colorInput.showPicker();
        else colorInput.click();
    }

    function updateAppendButtonState() {
        if (!dom.btnAppendMetadata) return;
        const run = getCurrentRun();
        const hasLassoSelection = (state.selectedSampleIds instanceof Set) && state.selectedSampleIds.size > 0;
        dom.btnAppendMetadata.disabled = !(run && Boolean(state.colorBy) && (hasHighlightSelection() || hasLassoSelection));
    }

    /**
     * Render the legend list.
     * Pass ctx.onSwatchClick for per-label color-picker support (oplsda).
     */
    function renderLegend(grouped, colorMap) {
        if (!dom.legendList) return;
        dom.legendList.innerHTML = "";
        // Default A-Z; if the user has reordered groups for the current
        // colorBy column (saved in meta_metadata[].groups), honor that order.
        const savedGroups = (state.projectData?.meta_metadata || []).find((m) => m?.name === state.colorBy)?.groups;
        orderLabelsByGroups([...grouped.keys()], savedGroups).forEach((label) => {
            const points = grouped.get(label) || [];
            const row = document.createElement("div");
            row.className = "legend-item";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "form-check-input mt-0";
            checkbox.checked = !state.hiddenLabels.has(label);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) state.hiddenLabels.delete(label);
                else state.hiddenLabels.add(label);
                ctx.renderPlot();
            });

            const swatch = document.createElement("span");
            swatch.className = "legend-swatch";
            swatch.style.backgroundColor = colorMap.get(label);
            // Auto-enable color picker when page state has customLabelColors;
            // fall back to legacy ctx.onSwatchClick for any custom override.
            if (state.customLabelColors !== undefined) {
                swatch.style.cursor = "pointer";
                swatch.title = "Click to change label color";
                swatch.addEventListener("click", (event) => {
                    event.stopPropagation();
                    openLegendColorPicker(label, swatch);
                });
            } else if (ctx.onSwatchClick) {
                swatch.style.cursor = "pointer";
                swatch.title = "Click to change label color";
                swatch.addEventListener("click", (event) => {
                    event.stopPropagation();
                    ctx.onSwatchClick(label, swatch, event);
                });
            }

            const labelNode = document.createElement("span");
            labelNode.className = `legend-label ${isLabelHighlighted(label) ? "active" : ""}`;
            labelNode.textContent = `${label} (${points.length})`;
            labelNode.addEventListener("click", (event) => {
                toggleHighlightedLabel(label, event);
                ctx.renderPlot();
            });

            row.appendChild(checkbox);
            row.appendChild(swatch);
            row.appendChild(labelNode);
            dom.legendList.appendChild(row);
        });
        updateAppendButtonState();
    }

    // ── COLOR SELECTOR ───────────────────────────────────────────────────

    /**
     * Rebuild the colorBySelect dropdown.
     * ctx.colorByHeader: HTML string for a prepended option (kmeans: K-Means Cluster).
     * ctx.defaultColorBy: fallback value when state.colorBy is not found.
     */
    function refreshColorOptions() {
        if (!dom.colorBySelect) return;
        const run = getCurrentRun();
        dom.colorBySelect.innerHTML = ctx.colorByHeader || "";
        if (!run) return;

        // Derive the column list from the ACTUAL metadata rows (authoritative
        // after a rename/delete) instead of the run's `metadata_columns` field,
        // which can go stale. Fall back to that field only if rows are empty.
        const metaRows = run?.data?.metadata || [];
        const rowKeys = metaRows.length ? Object.keys(metaRows[0]) : [];
        const runColumns = rowKeys.length
            ? rowKeys.filter((k) => k !== "sample_id")
            : (run?.data?.metadata_columns || []);
        const projectColumns = (state.projectData?.meta_metadata || []).map((m) => m?.name).filter(Boolean);
        const columns = sortMetadataLabels([...new Set([...(runColumns || []), ...(projectColumns || [])])]);
        columns.forEach((column) => {
            const option = document.createElement("option");
            option.value = column;
            option.textContent = column;
            dom.colorBySelect.appendChild(option);
        });

        const fallback = ctx.defaultColorBy !== undefined ? ctx.defaultColorBy : (run.data?.target_meta || run.config?.target_meta || columns[0] || null);
        if (!dom.colorBySelect.querySelector(`option[value="${CSS.escape(state.colorBy || "")}"]`)) {
            state.colorBy = fallback;
        }
        dom.colorBySelect.value = state.colorBy || "";
        updateAppendButtonState();
    }

    // ── METADATA RELOAD ──────────────────────────────────────────────────

    async function reloadAllRunMetadata() {
        state.runs.forEach((item) => {
            if (item.data_path) item.data = null;
        });
        const active = getCurrentRun();
        if (active) await ensureRunData(active);
    }

    // ── SIDEBAR INJECTION ────────────────────────────────────────────────

    async function injectSidebar(userId) {
        const response = await fetch("./sidebar.html");
        const html = await response.text();
        dom.sidebarPlaceholder.innerHTML = html;
        dom.sidebarPlaceholder.querySelectorAll("script").forEach((old) => {
            const s = document.createElement("script");
            s.textContent = old.textContent;
            document.head.appendChild(s);
        });
        dom.sidebarPlaceholder.querySelectorAll("#analysis-nav a").forEach((anchor) => {
            const href = anchor.getAttribute("href");
            if (href && href !== "#") anchor.href = `${href}?id=${projectId}&uid=${userId}`;
        });
        const activeLink = dom.sidebarPlaceholder.querySelector(`a[href^="${activePageFile}"]`);
        if (activeLink) {
            dom.sidebarPlaceholder.querySelectorAll(".nav-link").forEach((link) => link.classList.remove("active"));
            activeLink.classList.add("active");
        }
        const exitProjects = document.getElementById("btn-back-projects");
        if (exitProjects) exitProjects.href = `projectID.html?uid=${encodeURIComponent(userId)}`;
        const terminalHost = document.getElementById("sidebar-terminal-slot");
        if (terminalHost) {
            await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
        }
    }

    // ── APPEND METADATA ──────────────────────────────────────────────────

    async function appendHighlightedLabelsToMetadata() {
        const run = getCurrentRun();
        if (!run?.data?.metadata?.length || !state.colorBy) return;

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
            setStatus(ctx.statusEl(), "No metadata path found.", true);
            return;
        }

        state._metaOpBusy = true;
        await withInteractionLock(async () => {
            setStatus(ctx.statusEl(), "Updating metadata...");
            const resp = await fetch(`${vpsUrl}/kmeans/save-clusters`, {
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
        ctx.renderPlot();
        setStatus(ctx.statusEl(), `Appended to metadata column "${columnName}".`);
    }

    // ── EDIT METADATA COLUMN ─────────────────────────────────────────────

    async function applyMetadataColumnEdits(modalResult) {
        const run = getCurrentRun();
        if (!run?.data?.metadata?.length) return;

        const sourceColumn = modalResult?.sourceColumn || state.colorBy;
        if (!sourceColumn) return;
        // Optional guard (e.g. kmeans skips "__kmeans_cluster__")
        if (ctx.applyEditGuard && !ctx.applyEditGuard(sourceColumn)) return;
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
            setStatus(ctx.statusEl(), "No metadata path found.", true);
            return;
        }

        state._metaOpBusy = true;
        await withInteractionLock(async () => {
            setStatus(ctx.statusEl(), "Updating metadata...");
            const resp = await fetch(`${vpsUrl}/kmeans/save-clusters`, {
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

            // Persist the user's group ordering for this column.
            if (Array.isArray(modalResult.groupOrder) && modalResult.groupOrder.length) {
                try {
                    await fetch(`${vpsUrl}/metadata/reorder-groups`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            project_id: projectId,
                            column_name: targetColumn,
                            ordered_groups: modalResult.groupOrder,
                        }),
                    });
                } catch (_) { /* non-fatal */ }
            }
        });

        const snapshot = await getDoc(doc(db, "projects", projectId));
        state.projectData = snapshot.data() || {};
        await reloadAllRunMetadata();
        state._metaOpBusy = false;

        // Auto-select the edited column so the view jumps straight to it.
        state.colorBy = targetColumn;
        state.hiddenLabels.clear();
        state.highlightedLabels.clear();
        refreshColorOptions();
        await syncFeatureInContext();
        ctx.renderPlot();
        setStatus(ctx.statusEl(), `Updated metadata column "${targetColumn}".`);
    }

    // ── CREATE METADATA COLUMN ───────────────────────────────────────────

    async function createNewMetadataColumn(modalResult) {
        const run = getCurrentRun();
        if (!run?.data?.metadata?.length) return;
        if (!modalResult) return;

        const metaPath = state.projectData?.metaCheckedPath;
        if (!metaPath) {
            setStatus(ctx.statusEl(), "No metadata path found.", true);
            return;
        }

        state._metaOpBusy = true;
        await withInteractionLock(async () => {
            setStatus(ctx.statusEl(), "Updating metadata...");
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

        // Auto-select the newly created column.
        state.colorBy = modalResult.newMetaName;
        refreshColorOptions();
        await syncFeatureInContext();
        ctx.renderPlot();
        setStatus(ctx.statusEl(), `Created metadata column "${modalResult.newMetaName}".`);
    }

    // ── DELETE METADATA COLUMNS ──────────────────────────────────────────

    async function deleteMetadataColumns(modalResult) {
        const run = getCurrentRun();
        if (!run?.data?.metadata?.length) return;
        if (!modalResult) return;

        const metaPath = state.projectData?.metaCheckedPath;
        if (!metaPath) {
            setStatus(ctx.statusEl(), "No metadata path found.", true);
            return;
        }

        state._metaOpBusy = true;
        await withInteractionLock(async () => {
            setStatus(ctx.statusEl(), "Updating metadata...");
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
        if (state.colorBy && deletedSet.has(state.colorBy)) {
            state.colorBy = ctx.defaultColorBy !== undefined ? ctx.defaultColorBy : null;
        }
        state.hiddenLabels.clear();
        state.highlightedLabels.clear();
        refreshColorOptions();
        await syncFeatureInContext();
        ctx.renderPlot();
        setStatus(ctx.statusEl(), `Deleted ${modalResult.columnsToDelete.length} metadata column(s).`);
    }

    // ── RENAME METADATA COLUMN ─────────────────────────────────────────

    async function renameMetadataColumn(modalResult) {
        if (!modalResult) return;
        const metaPath = state.projectData?.metaCheckedPath;
        if (!metaPath) {
            setStatus(ctx.statusEl(), "No metadata path found.", true);
            return;
        }
        const { oldName, newName } = modalResult;

        state._metaOpBusy = true;
        await withInteractionLock(async () => {
            setStatus(ctx.statusEl(), `Renaming column "${oldName}" → "${newName}"...`);
            const resp = await fetch(`${vpsUrl}/metadata/rename-column`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    project_id: projectId,
                    meta_path: metaPath,
                    old_name: oldName,
                    new_name: newName,
                }),
            });
            const payload = await resp.json();
            if (!resp.ok) throw new Error(payload.detail || "Rename metadata column failed");
        });

        const snapshot = await getDoc(doc(db, "projects", projectId));
        state.projectData = snapshot.data() || {};
        await reloadAllRunMetadata();
        state._metaOpBusy = false;

        // Auto-select the renamed column.
        if (state.colorBy === oldName) state.colorBy = newName;
        else state.colorBy = newName;
        state.hiddenLabels.clear();
        state.highlightedLabels.clear();
        refreshColorOptions();
        await syncFeatureInContext();
        ctx.renderPlot();
        setStatus(ctx.statusEl(), `Renamed column "${oldName}" → "${newName}".`);
    }

    // ── METADATA MANAGER ─────────────────────────────────────────────────

    async function openUnifiedMetadataManager() {
        const run = getCurrentRun();
        if (!run?.data?.metadata?.length) return;

        const grouped = groupPoints(run);
        const metaMeta = state.projectData?.meta_metadata || [];
        const activeMetaEntry = metaMeta.find((m) => m?.name === state.colorBy);
        const labels = orderLabelsByGroups([...grouped.keys()], activeMetaEntry?.groups);
        const metadataColumns = sortMetadataLabels(metaMeta.map((m) => m?.name).filter(Boolean));
        const activeColumn = metadataColumns.includes(state.colorBy) ? state.colorBy : (metadataColumns[0] || "");

        const modalResult = await openMetadataManagerModal({
            metadataColumns,
            metadataRows: run.data.metadata || [],
            activeColumn,
            colorMap: buildColorMap(labels),
            metaMetadata: metaMeta,
        });
        if (!modalResult) return;

        if (modalResult.action === "edit") {
            await applyMetadataColumnEdits(modalResult);
            return;
        }
        if (modalResult.action === "create") {
            await createNewMetadataColumn(modalResult);
            return;
        }
        if (modalResult.action === "renameColumn") {
            await renameMetadataColumn(modalResult);
            return;
        }
        if (modalResult.action === "delete") {
            await deleteMetadataColumns(modalResult);
        }
    }

    // ── HISTORY ──────────────────────────────────────────────────────────

    /**
     * Render the history popup.
     * ctx.runLabel:        prefix for history title ("OPLS-DA", "PCA", …). Omit for kmeans/som.
     * ctx.buildRunTooltip: (run) => string  — custom tooltip text.
     * ctx.renderRunConfig: (run) => string  — extra HTML rows shown below date/status.
     */
    function renderHistory() {
        if (!dom.historyPopup) return;
        dom.historyPopup.innerHTML = "";
        if (!state.runs.length) {
            dom.historyPopup.innerHTML = '<div class="history-meta">No runs yet.</div>';
            return;
        }

        state.runs.forEach((run) => {
            const item = document.createElement("div");
            item.className = `history-item d-flex align-items-start gap-2 ${state.currentRunId === run.run_id ? "active" : ""}`;
            item.title = ctx.buildRunTooltip
                ? ctx.buildRunTooltip(run)
                : JSON.stringify(run.config || {}, null, 2);

            const info = document.createElement("div");
            info.style.cssText = "flex:1;min-width:0;cursor:pointer;";
            const displayName = ctx.runLabel ? `${ctx.runLabel}: ${sanitizeHtml(run.name)}` : sanitizeHtml(run.name);
            const extraConfig = ctx.renderRunConfig ? ctx.renderRunConfig(run) : "";
            info.innerHTML = `
                <div class="history-title">${displayName}</div>
                <div class="history-meta">${new Date(run.date).toLocaleString()}</div>
                <div class="history-meta mt-1">${getTaskStatusBadge(run.status)} <span class="ms-1">${formatTaskId(run)}</span></div>
                <div class="history-meta mt-1">${sanitizeHtml(run.message || "")}</div>
                ${extraConfig}
            `;
            info.addEventListener("click", () => {
                if (isBusyRun(run)) return;
                ctx.applyRunSelection(run, true);
            });

            const delBtn = document.createElement("button");
            delBtn.className = "btn btn-outline-danger btn-sm py-0 px-1";
            delBtn.style.fontSize = "0.65rem";
            delBtn.style.flexShrink = "0";
            delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            delBtn.title = "Delete this run";
            delBtn.disabled = isBusyRun(run);
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                deleteRun(run);
            });

            item.appendChild(info);
            item.appendChild(delBtn);
            dom.historyPopup.appendChild(item);
        });
    }

    async function deleteRun(run) {
        const label = ctx.runLabel ? `${ctx.runLabel}: ${run.name}` : run.name;
        if (!confirm(`Delete "${label}"?`)) return;

        if (run.data_path) await deleteStorageArtifacts([run.data_path]);

        state.runs = state.runs.filter((r) => r.run_id !== run.run_id);
        if (state.currentRunId === run.run_id) {
            state.currentRunId = null;
            if (ctx.onRunDeleted) ctx.onRunDeleted();
            else toggleViz(false);
        }
        renderHistory();
        await syncFeatureInContext();
        await persistRuns();
    }

    // ── COMMON VIZ EVENT BINDING ─────────────────────────────────────────

    /**
     * Bind the standard visualization controls every analysis page shares:
     * historyToggle, colorBySelect, paletteSelect, ellipseToggle,
     * btnAppendMetadata, btnMetadataManager, window resize.
     * Call once inside each page's bindEvents().
     */
    function bindCommonVizEvents() {
        if (dom.historyToggle && dom.historyPopup) {
            dom.historyToggle.addEventListener("click", () => dom.historyPopup.classList.toggle("open"));
            document.addEventListener("click", (event) => {
                if (!dom.historyPopup.contains(event.target) && !dom.historyToggle.contains(event.target)) {
                    dom.historyPopup.classList.remove("open");
                }
            });
        }

        if (dom.colorBySelect) {
            dom.colorBySelect.addEventListener("change", () => {
                state.colorBy = dom.colorBySelect.value;
                state.hiddenLabels.clear();
                state.highlightedLabels.clear();
                if (state.selectedSampleIds instanceof Set) state.selectedSampleIds.clear();
                syncFeatureInContext().then(() => ctx.renderPlot());
            });
        }

        if (dom.paletteSelect) {
            dom.paletteSelect.addEventListener("change", () => {
                state.palette = dom.paletteSelect.value;
                if (state.customLabelColors !== undefined) {
                    state.customLabelColors = {};
                }
                syncFeatureInContext().then(() => ctx.renderPlot());
            });
        }

        if (dom.ellipseToggle) {
            dom.ellipseToggle.addEventListener("change", () => {
                state.showEllipse = dom.ellipseToggle.checked;
                ctx.renderPlot();
            });
        }

        if (dom.btnAppendMetadata) {
            dom.btnAppendMetadata.addEventListener("click", () => {
                appendHighlightedLabelsToMetadata().catch((err) => setStatus(ctx.statusEl(), err.message || String(err), true));
            });
        }

        if (dom.btnMetadataManager) {
            dom.btnMetadataManager.addEventListener("click", () => {
                openUnifiedMetadataManager().catch((err) => setStatus(ctx.statusEl(), err.message || String(err), true));
            });
        }

        let resizeTimer = null;
        window.addEventListener("resize", () => {
            if (!getCurrentRun() || !dom.plotWrap) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!getCurrentRun() || !dom.plotWrap?.data) return;
                if (window.Plotly?.Plots?.resize) {
                    Plotly.Plots.resize(dom.plotWrap);
                }
            }, 150);
        });
    }

    // ── RETURN ALL SHARED FUNCTIONS ──────────────────────────────────────

    return {
        // utilities
        safeString,
        sanitizeSuffix,
        sanitizeHtml,
        labelOrNone,
        isBusyRun,
        dedupeRuns,
        setStatus,
        // highlight
        isLabelHighlighted,
        hasHighlightSelection,
        toggleHighlightedLabel,
        // run management
        getCurrentRun,
        normalizeRunRecord,
        upsertRun,
        buildRunRecords,
        persistRuns,
        deleteStorageArtifacts,
        ensureRunData,
        // normalization
        getNormalizationConfig,
        renderNormalizationSummary,
        // viz
        toggleViz,
        getFeatureOverlay,
        syncFeatureInContext,
        // color / plot
        buildColorMap,
        groupPoints,
        ellipseTraceForGroup,
        updateAppendButtonState,
        refreshColorOptions,
        renderLegend,
        openLegendColorPicker,
        // metadata operations
        reloadAllRunMetadata,
        appendHighlightedLabelsToMetadata,
        applyMetadataColumnEdits,
        createNewMetadataColumn,
        deleteMetadataColumns,
        openUnifiedMetadataManager,
        // sidebar
        injectSidebar,
        // history
        renderHistory,
        deleteRun,
        // common event binding
        bindCommonVizEvents,
    };
}
