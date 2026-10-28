import { storage } from "./firebase-config.js";
import { getDownloadURL, ref } from "./firebase-config.js";

function parseCsvRow(line) {
    const values = [];
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
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}

function parseMatrixCsv(text) {
    const lines = String(text || "")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    if (!lines.length) {
        return { sampleIds: [], features: [], featureToValues: new Map() };
    }

    const header = parseCsvRow(lines[0]);
    const sampleIds = header.slice(1).map((value) => String(value || "").trim());
    const features = [];
    const featureToValues = new Map();

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const row = parseCsvRow(lines[lineIndex]);
        const feature = String(row[0] || "").trim();
        if (!feature) continue;
        features.push(feature);
        featureToValues.set(feature, row.slice(1).map((value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        }));
    }

    return { sampleIds, features, featureToValues };
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values, avg) {
    if (values.length <= 1 || !Number.isFinite(avg)) return 0;
    const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
    return Math.sqrt(Math.max(variance, 0));
}

function median(values) {
    return quantile(values, 0.5);
}

function quantile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] + ((sorted[upper] - sorted[lower]) * weight);
}

function formatNumber(value) {
    if (!Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(1);
    if (abs >= 100) return value.toFixed(2);
    if (abs >= 10) return value.toFixed(3);
    return value.toFixed(4);
}

function normalizeGroupLabel(value) {
    const text = String(value ?? "").trim();
    if (!text || ["nan", "null", "none"].includes(text.toLowerCase())) return "NaN";
    return text;
}

function rowZScore(values) {
    const finite = values.filter((value) => Number.isFinite(value));
    if (!finite.length) return values.map(() => null);
    const avg = mean(finite);
    const deviation = stdDev(finite, avg);
    if (!Number.isFinite(deviation) || deviation === 0) {
        return values.map((value) => (Number.isFinite(value) ? 0 : null));
    }
    return values.map((value) => (Number.isFinite(value) ? (value - avg) / deviation : null));
}

function getFeatureDatasetMode(scaleMode) {
    return String(scaleMode || "normalize").toLowerCase() === "raw" ? "raw" : "normalize";
}

function buildStats(values) {
    const finite = values.filter((value) => Number.isFinite(value));
    if (!finite.length) {
        return {
            count: 0,
            min: null,
            max: null,
            q1: null,
            mean: null,
            median: null,
            q3: null,
        };
    }
    return {
        count: finite.length,
        min: Math.min(...finite),
        max: Math.max(...finite),
        q1: quantile(finite, 0.25),
        mean: mean(finite),
        median: median(finite),
        q3: quantile(finite, 0.75),
    };
}

function filterFeatures(features, searchTerm, activeFeature) {
    const normalized = String(searchTerm || "").trim().toLowerCase();
    const exact = [];
    const partial = [];
    const startsWith = [];

    (features || []).forEach((feature) => {
        const value = String(feature || "");
        const lower = value.toLowerCase();
        if (!normalized) {
            partial.push(value);
            return;
        }
        if (lower === normalized) exact.push(value);
        else if (lower.startsWith(normalized)) startsWith.push(value);
        else if (lower.includes(normalized)) partial.push(value);
    });

    const ordered = [
        ...(activeFeature ? [activeFeature] : []),
        ...exact,
        ...startsWith,
        ...partial,
    ].filter((value, index, array) => value && array.indexOf(value) === index);

    return ordered.slice(0, 40);
}

export function createFeatureInModule(options) {
    const dom = {
        searchInput: options.searchInput,
        results: options.results,
        scaleMode: options.scaleMode,
        status: options.status,
        summary: options.summary,
        selectedList: options.selectedList,
        clearAllButton: options.clearAllButton,
        distributionPlot: options.distributionPlot,
        overlayLegend: options.overlayLegend,
    };

    const onSelectionChange = typeof options.onSelectionChange === "function" ? options.onSelectionChange : () => {};
    const datasetCache = new Map();
    const state = {
        projectData: null,
        run: null,
        colorBy: null,
        palette: "vivid",
        searchTerm: "",
        searchResults: [],
        activeFeature: null,
        activeOverlay: null,
        savedFeatures: [],
        featureSourceMode: "normalize",
    };

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function setStatus(message, isError = false) {
        if (!dom.status) return;
        dom.status.textContent = message || "";
        dom.status.classList.toggle("error", Boolean(isError));
    }

    function setSummary(content) {
        if (!dom.summary) return;
        dom.summary.innerHTML = content;
    }

    function buildHoverStatsMarkup(stats) {
        const rows = [
            ["Count", String(stats.count || 0)],
            ["Mean", formatNumber(stats.mean)],
            ["Median", formatNumber(stats.median)],
            ["Q1", formatNumber(stats.q1)],
            ["Q3", formatNumber(stats.q3)],
            ["Min", formatNumber(stats.min)],
            ["Max", formatNumber(stats.max)],
        ];
        return rows.map(([label, value]) => `
            <div class="feature-current-detail-row">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
            </div>
        `).join("");
    }

    function getSourcePath(mode) {
        if (!state.projectData) return null;
        if (mode === "raw") {
            return state.projectData.matrixRawPath || state.projectData.matrixCheckedPath || null;
        }
        return state.projectData.matrixNormPath || state.projectData.matrixCheckedPath || state.projectData.matrixRawPath || null;
    }

    async function ensureDataset(mode) {
        const sourceMode = mode === "raw" ? "raw" : "normalize";
        const path = getSourcePath(sourceMode);
        if (!path) {
            throw new Error(sourceMode === "raw"
                ? "Raw matrix is unavailable for this project."
                : "Normalized matrix is unavailable for this project.");
        }
        if (datasetCache.has(path)) return datasetCache.get(path);

        const promise = (async () => {
            const url = await getDownloadURL(ref(storage, path));
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to load matrix: ${path}`);
            const text = await response.text();
            return parseMatrixCsv(text);
        })();

        datasetCache.set(path, promise);
        return promise;
    }

    async function ensureFeatureIndex() {
        const preferredMode = getSourcePath("normalize") ? "normalize" : "raw";
        const dataset = await ensureDataset(preferredMode);
        return dataset.features || [];
    }

    function getModeLabel(scaleMode) {
        if (scaleMode === "raw") return "Raw";
        if (scaleMode === "row_zscore") return "Row Z-score";
        return "Normalize";
    }

    function rgba(hex, alpha) {
        const safe = String(hex || "#2563eb").replace("#", "");
        const normalized = safe.length === 3
            ? safe.split("").map((char) => char + char).join("")
            : safe.padEnd(6, "0").slice(0, 6);
        const red = parseInt(normalized.slice(0, 2), 16);
        const green = parseInt(normalized.slice(2, 4), 16);
        const blue = parseInt(normalized.slice(4, 6), 16);
        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }

    function buildOverlayFromFeature(dataset, feature) {
        if (!state.run?.data) throw new Error("No analysis run selected.");
        const rawValues = dataset.featureToValues.get(feature);
        if (!rawValues) throw new Error(`Feature '${feature}' was not found in the selected matrix.`);

        const transformedValues = state.featureSourceMode === "row_zscore" ? rowZScore(rawValues) : rawValues;
        const sourceBySample = new Map(dataset.sampleIds.map((sampleId, index) => [String(sampleId), transformedValues[index]]));
        const metadataBySample = new Map((state.run.data.metadata || []).map((item) => [String(item.sample_id), item]));
        const runSampleIds = state.run.data.sample_ids || (state.run.data.plot_points || []).map((point) => point.sample_id);
        const points = [];

        (runSampleIds || []).forEach((sampleId) => {
            const value = sourceBySample.get(String(sampleId));
            const meta = metadataBySample.get(String(sampleId)) || {};
            points.push({
                sampleId: String(sampleId),
                value: Number.isFinite(value) ? value : null,
                label: normalizeGroupLabel(meta[state.colorBy]),
            });
        });

        const stats = buildStats(points.map((point) => point.value));
        return {
            feature,
            mode: state.featureSourceMode,
            modeLabel: getModeLabel(state.featureSourceMode),
            points,
            stats,
            valuesBySample: new Map(points.map((point) => [point.sampleId, point.value])),
            groupLabel: state.colorBy || "Metadata",
        };
    }

    function getPrimaryColor() {
        return "#b81d13";
    }

    function renderOverlayLegend() {
        if (!dom.overlayLegend) return;
        const overlay = state.activeOverlay;
        if (!overlay) {
            dom.overlayLegend.classList.remove("active");
            dom.overlayLegend.innerHTML = "";
            return;
        }

        const rows = [
            ["Count", String(overlay.stats.count || 0)],
            ["Mean", formatNumber(overlay.stats.mean)],
            ["Median", formatNumber(overlay.stats.median)],
            ["Q1", formatNumber(overlay.stats.q1)],
            ["Q3", formatNumber(overlay.stats.q3)],
            ["Min", formatNumber(overlay.stats.min)],
            ["Max", formatNumber(overlay.stats.max)],
        ];

        dom.overlayLegend.innerHTML = `
            <div class="feature-overlay-details">
                ${rows.map(([label, value]) => `
                    <div class="feature-overlay-stat">
                        <span>${escapeHtml(label)}</span>
                        <strong>${escapeHtml(value)}</strong>
                    </div>
                `).join("")}
            </div>
        `;
        dom.overlayLegend.classList.add("active");
    }

    function renderDistributionPlot() {
        if (!dom.distributionPlot || !window.Plotly) return;
        const plotHeight = Math.max(dom.distributionPlot.clientHeight || 0, 72);
        const overlay = state.activeOverlay;
        if (!overlay) {
            dom.distributionPlot.innerHTML = "";
            window.Plotly.newPlot(dom.distributionPlot, [], {
                height: plotHeight,
                margin: { t: 14, r: 14, b: 24, l: 14 },
                paper_bgcolor: "#ffffff",
                plot_bgcolor: "#ffffff",
                annotations: [{
                    text: "Select a feature to inspect the expression distribution.",
                    x: 0.5,
                    y: 0.5,
                    xref: "paper",
                    yref: "paper",
                    showarrow: false,
                    font: { size: 12, color: "#6b7280" },
                }],
                xaxis: { visible: false },
                yaxis: { visible: false },
            }, { responsive: true, displaylogo: false, displayModeBar: false, staticPlot: true });
            return;
        }

        const points = overlay.points.filter((point) => Number.isFinite(point.value));
        const values = points.map((point) => point.value);
        const primary = getPrimaryColor();
        const violinFill = rgba(primary, 0.34);
        const boxFill = rgba(primary, 0.22);

        window.Plotly.newPlot(dom.distributionPlot, [
            {
                type: "violin",
                orientation: "h",
                x: values,
                y: new Array(values.length).fill(""),
                name: "",
                side: "positive",
                spanmode: "hard",
                line: { color: primary, width: 1.1 },
                fillcolor: violinFill,
                opacity: 0.75,
                hoverinfo: "skip",
                showlegend: false,
                points: false,
                xaxis: "x",
                yaxis: "y",
            },
            {
                type: "box",
                orientation: "h",
                x: values,
                y: new Array(values.length).fill(""),
                name: overlay.modeLabel,
                fillcolor: boxFill,
                line: { color: primary, width: 1.2 },
                marker: { color: boxFill },
                boxmean: true,
                boxpoints: false,
                hoverinfo: "skip",
                showlegend: false,
                xaxis: "x2",
                yaxis: "y2",
            },
        ], {
            height: plotHeight,
            grid: { rows: 2, columns: 1, pattern: "independent", roworder: "top to bottom" },
            margin: { t: 22, r: 18, b: 30, l: 12 },
            paper_bgcolor: "#ffffff",
            plot_bgcolor: "#ffffff",
            title: {
                text: `${escapeHtml(overlay.feature)}`,
                font: { size: 13, color: "#1f2937" },
                x: 0.02,
                xanchor: "left",
            },
            xaxis: {
                title: { text: "" },
                gridcolor: "#eef2f7",
                zeroline: false,
                tickfont: { size: 10 },
            },
            xaxis2: {
                title: { text: overlay.modeLabel, font: { size: 10, color: "#475569" } },
                gridcolor: "#eef2f7",
                zeroline: false,
                tickfont: { size: 10 },
            },
            yaxis: {
                visible: false,
                showticklabels: false,
                zeroline: false,
            },
            yaxis2: {
                visible: false,
                showticklabels: false,
                zeroline: false,
            },
            hovermode: false,
            showlegend: false,
        }, {
            responsive: true,
            displaylogo: false,
            displayModeBar: false,
            staticPlot: true,
            scrollZoom: false,
            doubleClick: false,
        });
    }

    function renderSearchResults() {
        if (!dom.results) return;
        const shouldOpen = Boolean(state.searchTerm.trim()) && Boolean(state.projectData) && Boolean(state.run);
        dom.results.innerHTML = "";
        dom.results.classList.toggle("open", shouldOpen);
        if (!shouldOpen) return;

        if (!state.searchResults.length) {
            const empty = document.createElement("div");
            empty.className = "feature-selected-empty";
            empty.textContent = "No matched features.";
            dom.results.appendChild(empty);
            return;
        }

        state.searchResults.forEach((feature) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "feature-search-option";
            button.textContent = feature;
            button.addEventListener("click", async () => {
                await addSavedFeature(feature);
            });
            dom.results.appendChild(button);
        });
    }

    function renderSavedFeatures() {
        if (!dom.selectedList) return;
        dom.selectedList.innerHTML = "";
        if (!state.savedFeatures.length) {
            const empty = document.createElement("div");
            empty.className = "feature-selected-empty";
            dom.selectedList.appendChild(empty);
        } else {
            state.savedFeatures.forEach((feature) => {
                const row = document.createElement("div");
                row.className = `feature-saved-chip ${state.activeFeature === feature ? "active" : ""}`;

                const labelButton = document.createElement("button");
                labelButton.type = "button";
                labelButton.className = "feature-saved-chip-label";
                labelButton.textContent = feature;
                labelButton.title = feature;
                labelButton.addEventListener("click", async () => {
                    try {
                        if (state.activeFeature === feature) {
                            await clearSelectionInternal();
                        } else {
                            await applySavedFeature(feature);
                        }
                    } catch (error) {
                        setStatus(error.message || String(error), true);
                    }
                });

                const clearButton = document.createElement("button");
                clearButton.type = "button";
                clearButton.className = "feature-saved-chip-button";
                clearButton.innerHTML = "&times;";
                clearButton.title = `Remove ${feature}`;
                clearButton.addEventListener("click", async (event) => {
                    event.stopPropagation();
                    await removeSavedFeature(feature);
                });

                row.appendChild(labelButton);
                row.appendChild(clearButton);
                dom.selectedList.appendChild(row);
            });
        }

        if (dom.clearAllButton) {
            dom.clearAllButton.disabled = state.savedFeatures.length === 0;
        }
    }

    async function refreshSearchResults() {
        try {
            if (!state.projectData || !state.run) {
                state.searchResults = [];
                renderSearchResults();
                return;
            }
            if (!state.searchTerm.trim()) {
                state.searchResults = [];
                renderSearchResults();
                // setStatus("Search a feature and add it to the saved list.", false);
                return;
            }
            const features = await ensureFeatureIndex();
            state.searchResults = filterFeatures(features, state.searchTerm, null).filter((feature) => !state.savedFeatures.includes(feature));
            renderSearchResults();
        } catch (error) {
            state.searchResults = [];
            renderSearchResults();
            setStatus(error.message || String(error), true);
        }
    }

    async function addSavedFeature(feature) {
        if (!state.savedFeatures.includes(feature)) {
            state.savedFeatures.push(feature);
        }
        state.searchTerm = "";
        if (dom.searchInput) dom.searchInput.value = "";
        state.searchResults = [];
        renderSearchResults();
        renderSavedFeatures();
    }

    async function applySavedFeature(feature) {
        const dataset = await ensureDataset(getFeatureDatasetMode(state.featureSourceMode));
        state.activeFeature = feature;
        state.activeOverlay = buildOverlayFromFeature(dataset, feature);
        dom.summary?.classList.add("has-details");
        setSummary(`
            <div class="feature-current-details">
                ${buildHoverStatsMarkup(state.activeOverlay.stats)}
            </div>
        `);
        renderSavedFeatures();
        renderOverlayLegend();
        renderDistributionPlot();
        onSelectionChange(state.activeOverlay);
    }

    async function clearSelectionInternal(silent = false) {
        state.activeFeature = null;
        state.activeOverlay = null;
        dom.summary?.classList.remove("has-details");
        setSummary("");
        renderSavedFeatures();
        renderOverlayLegend();
        renderDistributionPlot();
        if (!silent) onSelectionChange(null);
    }

    async function removeSavedFeature(feature) {
        state.savedFeatures = state.savedFeatures.filter((item) => item !== feature);
        if (state.activeFeature === feature) {
            await clearSelectionInternal();
        } else {
            renderSavedFeatures();
        }
        if (state.searchTerm.trim()) {
            await refreshSearchResults();
        }
    }

    async function clearAllSavedFeatures() {
        state.savedFeatures = [];
        state.searchTerm = "";
        state.searchResults = [];
        if (dom.searchInput) dom.searchInput.value = "";
        renderSearchResults();
        await clearSelectionInternal();
        renderSavedFeatures();
        setStatus("Cleared all saved features.", false);
    }

    async function refreshActiveOverlay() {
        if (!state.activeFeature) {
            renderDistributionPlot();
            renderOverlayLegend();
            return;
        }
        await applySavedFeature(state.activeFeature);
    }

    function syncScaleAvailability() {
        if (!dom.scaleMode) return;
        const rawOption = [...dom.scaleMode.options].find((option) => option.value === "raw");
        if (rawOption) rawOption.disabled = !getSourcePath("raw");
        if (rawOption && rawOption.disabled && dom.scaleMode.value === "raw") {
            dom.scaleMode.value = "normalize";
            state.featureSourceMode = "normalize";
        }
    }

    function bind() {
        if (dom.searchInput) {
            dom.searchInput.addEventListener("input", async () => {
                state.searchTerm = dom.searchInput.value || "";
                await refreshSearchResults();
            });
            dom.searchInput.addEventListener("focus", async () => {
                await refreshSearchResults();
            });
            dom.searchInput.addEventListener("keydown", async (event) => {
                if (event.key === "Escape") {
                    state.searchTerm = "";
                    dom.searchInput.value = "";
                    state.searchResults = [];
                    renderSearchResults();
                }
            });
        }
        if (dom.scaleMode) {
            dom.scaleMode.addEventListener("change", async () => {
                state.featureSourceMode = dom.scaleMode.value || "normalize";
                if (state.activeFeature) {
                    try {
                        await refreshActiveOverlay();
                    } catch (error) {
                        setStatus(error.message || String(error), true);
                    }
                } else {
                    setStatus(`Default expression view: ${getModeLabel(state.featureSourceMode)}.`, false);
                }
            });
        }
        if (dom.clearAllButton) {
            dom.clearAllButton.addEventListener("click", async () => {
                await clearAllSavedFeatures();
            });
        }
        document.addEventListener("click", (event) => {
            if (!dom.results || !dom.searchInput) return;
            const popup = dom.results;
            if (popup.contains(event.target) || dom.searchInput.contains(event.target)) return;
            popup.classList.remove("open");
        });
    }

    bind();
    renderSavedFeatures();
    renderSearchResults();
    renderDistributionPlot();

    return {
        async setContext({ projectData, run, colorBy, palette }) {
            state.projectData = projectData || null;
            state.run = run || null;
            state.colorBy = colorBy || null;
            state.palette = palette || state.palette;
            syncScaleAvailability();
            if (!state.projectData || !state.run) {
                // setStatus("Load a run to enable feature search.", false);
                state.searchResults = [];
                renderSearchResults();
                await clearSelectionInternal(true);
                renderSavedFeatures();
                return;
            }
            if (!state.colorBy) {
                // setStatus("Choose a metadata column to group the feature distribution.", true);
            } else if (!state.activeFeature) {
                // setStatus("Search a feature and add it to the saved list.", false);
            }
            await refreshSearchResults();
            renderSavedFeatures();
            if (state.activeFeature) {
                try {
                    await refreshActiveOverlay();
                } catch (error) {
                    setStatus(error.message || String(error), true);
                }
            } else {
                renderDistributionPlot();
                renderOverlayLegend();
            }
        },
        async clearSelection() {
            await clearSelectionInternal();
        },
        getActiveOverlay() {
            return state.activeOverlay;
        },
    };
}
