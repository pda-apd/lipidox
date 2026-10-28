import { createFeatureInModule } from "./feature-in.js";

export const MULTIVAR_PALETTE_MAP = {
    tableau: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AB"],
    set2: ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    dark2: ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
    vivid: ["#FF0054", "#FF5400", "#FFBD00", "#00C853", "#00B8D9", "#2979FF", "#7C4DFF", "#D500F9", "#F50057", "#00E5FF"],
    neon: ["#39FF14", "#FF3131", "#FFF01F", "#00FFFF", "#FF6EC7", "#FF8C00", "#8A2BE2", "#00FF7F", "#1E90FF", "#FFD700"],
};

export function createMultivarFeatureIn({ dom, onSelectionChange, paletteMap = MULTIVAR_PALETTE_MAP }) {
    return createFeatureInModule({
        searchInput: dom.featureSearchInput,
        results: dom.featureSearchResults,
        scaleMode: dom.featureScaleMode,
        status: dom.featureSearchStatus,
        summary: dom.featureCurrentSummary,
        selectedList: dom.featureSelectedList,
        clearAllButton: dom.featureClearAllBtn,
        distributionPlot: dom.featureDistributionPlot,
        overlayLegend: dom.featureOverlayLegend,
        onSelectionChange,
        getPaletteColors: (palette) => paletteMap[palette] || paletteMap.vivid,
    });
}

export function getCurrentPlotRanges(plotWrap) {
    const xRange = plotWrap?.layout?.xaxis?.range;
    const yRange = plotWrap?.layout?.yaxis?.range;
    if (!Array.isArray(xRange) || !Array.isArray(yRange) || xRange.length !== 2 || yRange.length !== 2) return null;
    return { xRange: [...xRange], yRange: [...yRange] };
}

export function buildMultivarScatterLayout({
    xTitle,
    yTitle,
    plotConfig,
    savedRanges = null,
    activeFeatureOverlay = null,
    showLegend = true,
    xExtra = {},
    yExtra = {},
}) {
    const baseX = {
        title: { text: xTitle, font: { size: plotConfig.axisFontSize } },
        tickfont: { size: plotConfig.axisFontSize },
        zeroline: false,
        gridcolor: "#edf1f5",
        ...xExtra,
    };
    const baseY = {
        title: { text: yTitle, font: { size: plotConfig.axisFontSize } },
        tickfont: { size: plotConfig.axisFontSize },
        zeroline: false,
        gridcolor: "#edf1f5",
        ...yExtra,
    };

    if (savedRanges) {
        baseX.autorange = false;
        baseX.range = savedRanges.xRange;
        baseY.autorange = false;
        baseY.range = savedRanges.yRange;
    }

    return {
        margin: { t: 20, r: activeFeatureOverlay ? 62 : 20, b: 50, l: 60 },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: baseX,
        yaxis: baseY,
        showlegend: showLegend,
        legend: { bgcolor: "rgba(255,255,255,0.85)", borderwidth: 1, font: { size: plotConfig.legendFontSize }, x: 1, xanchor: "right", y: 1, yanchor: "top" },
    };
}

export function getMultivarPlotOptions(plotConfig, overrides = {}) {
    return {
        responsive: true,
        displayModeBar: "hover",
        scrollZoom: true,
        displaylogo: false,
        toImageButtonOptions: {
            format: plotConfig.imgFormat,
            width: plotConfig.imgWidth,
            height: plotConfig.imgHeight,
            scale: plotConfig.imgFormat === "svg" ? 1 : 6,
        },
        edits: { legendPosition: true },
        ...overrides,
    };
}

export function renderEmptyMultivarPlot(plotWrap) {
    Plotly.newPlot(plotWrap, [], { margin: { t: 10, r: 10, b: 10, l: 10 } }, { responsive: true, displaylogo: false });
}

export function bindLassoSelection({ plotWrap, state, onSelectionChange }) {
    if (!plotWrap || !state) return;

    if (!(state.selectedSampleIds instanceof Set)) {
        state.selectedSampleIds = new Set();
    }

    const notify = () => {
        if (typeof onSelectionChange === "function") onSelectionChange();
    };

    if (typeof plotWrap.removeAllListeners === "function") {
        plotWrap.removeAllListeners("plotly_selected");
        plotWrap.removeAllListeners("plotly_deselect");
    }

    plotWrap.on("plotly_selected", (eventData) => {
        const next = new Set();
        (eventData?.points || []).forEach((point) => {
            const sampleId = point?.text;
            if (sampleId !== undefined && sampleId !== null && sampleId !== "") {
                next.add(String(sampleId));
            }
        });
        state.selectedSampleIds = next;
        notify();
    });

    plotWrap.on("plotly_deselect", () => {
        state.selectedSampleIds = new Set();
        notify();
    });
}
