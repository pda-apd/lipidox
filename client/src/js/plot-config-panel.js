/**
 * plot-config-panel.js
 *
 * Reusable floating ⚙ gear-button settings panel for Plotly figures.
 * Drop-in into any analysis page that uses Plotly.
 *
 * Usage:
 *   import { mountPlotConfigPanel } from './plot-config-panel.js';
 *
 *   const panel = mountPlotConfigPanel({
 *     anchor    : HTMLElement,                // element to append the gear button+panel to
 *     defaults  : { markerSize: 7, ... },     // override any subset of defaults
 *     onUpdate  : (key, value, allConfig) => {},  // fired on every change
 *     onDownload: (allConfig) => {},              // fired when Download button clicked
 *   });
 *
 *   panel.getConfig()            // → snapshot of current config object
 *   panel.setConfig({ k: v })   // programmatically update fields + sync UI (no onUpdate fired)
 *   panel.destroy()              // remove from DOM and clean up listeners
 *
 * Config keys and defaults:
 *   markerSize     {number}  7     — base dot size (selected dots get +4)
 *   markerOpacity  {number}  0.82  — dot opacity
 *   axisFontSize   {number}  12    — axis title font size (px)
 *   labelFontSize  {number}  10    — annotation/label font size (px)
 *   legendFontSize {number}  12    — legend text font size (px)
 *   ellipseOpacity {number}  0.15  — ellipse fill opacity
 *   lineWidth      {number}  2     — line width (for line/ROC plots)
 *   imgWidth       {number}  1400  — download image width (px)
 *   imgHeight      {number}  900   — download image height (px)
 *   imgFormat      {string}  "svg" — download format: "svg" | "png" | "jpeg"
 *
 * options flags (all default true unless stated):
 *   showMarkerSize, showMarkerOpacity, showAxisFontSize, showLabelSize,
 *   showLegendFontSize — default true
 *   showEllipseOpacity, showLineWidth — default false
 */

export const PLOT_CONFIG_DEFAULTS = {
    markerSize    : 7,
    markerOpacity : 0.82,
    axisFontSize  : 12,
    labelFontSize : 10,
    legendFontSize: 12,
    groupLabelFontSize: 15,
    ellipseOpacity: 0.15,
    lineWidth     : 2,
    boxColor      : "#1e40af",
    imgWidth      : 1400,
    imgHeight     : 900,
    imgFormat     : "svg",
};

// Range-slider fields (order determines rendering order).
// conditional key maps to an options.showXxx flag:
//   no conditional → always shown.
//   conditional present → shown only when the matching flag is true.
// Defaults: markerSize/markerOpacity/axisFontSize/labelSize/legendFontSize = true,
//           ellipseOpacity/lineWidth = false (opt-in).
const RANGE_FIELDS = [
    { key: "markerSize",     label: "Dot size",             min: 3,    max: 20,  step: 1,    conditional: "markerSize"     },
    { key: "markerOpacity",  label: "Dot opacity",          min: 0.05, max: 1,   step: 0.05, conditional: "markerOpacity"  },
    { key: "axisFontSize",   label: "Axis title font size", min: 8,    max: 24,  step: 1,    conditional: "axisFontSize" },
    { key: "labelFontSize",  label: "Label font size",      min: 6,    max: 20,  step: 1,    conditional: "labelSize"      },
    { key: "legendFontSize", label: "Legend font size",     min: 6,    max: 20,  step: 1,    conditional: "legendFontSize" },
    { key: "groupLabelFontSize", label: "Group label font size", min: 6, max: 30, step: 1,   conditional: "groupLabelSize"  },
    { key: "ellipseOpacity", label: "Ellipse opacity",      min: 0,    max: 0.5, step: 0.05, conditional: "ellipseOpacity" },
    { key: "lineWidth",      label: "Line width",           min: 0.5,  max: 5,   step: 0.5,  conditional: "lineWidth"      },
];

let _uidCounter = 0;

/**
 * Intercept the next Plotly.downloadImage call made by `triggerDownload` to
 * capture the plot element + image options, then build a preview data URL via
 * Plotly.toImage using those exact options. This lets the Preview button reuse
 * each page's existing onDownload logic without any per-page changes.
 * Returns a Promise<string|null> (data URL, or null if nothing was captured).
 */
async function capturePlotPreview(triggerDownload) {
    const Plotly = window.Plotly;
    if (!Plotly || typeof Plotly.toImage !== "function" || typeof Plotly.downloadImage !== "function") {
        return null;
    }
    let captured = null;
    const original = Plotly.downloadImage;
    Plotly.downloadImage = function (gd, opts) {
        if (!captured) captured = { gd, opts: opts || {} };
        return Promise.resolve();
    };
    try {
        await Promise.resolve(triggerDownload());
    } finally {
        Plotly.downloadImage = original;
    }
    if (!captured) return null;
    try {
        return await Plotly.toImage(captured.gd, captured.opts);
    } catch (err) {
        console.error("[plot-config-panel] preview toImage failed:", err);
        return null;
    }
}

/**
 * Open a compact 500x400 preview modal showing the generated plot image, with a
 * centered Download button beneath it (which triggers the real download).
 * Closes on ESC or overlay click. Clicks inside this modal are isolated so
 * they never close the parent plot-settings panel.
 */
function openImagePreviewModal(dataURL, onDownloadClick) {
    document.getElementById("__plotPreviewModal")?.remove();
    const modal = document.createElement("div");
    modal.id = "__plotPreviewModal";
    modal.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483000",
        "background:rgba(0,0,0,0.55)", "display:flex",
        "align-items:center", "justify-content:center", "padding:12px",
    ].join(";");
    modal.innerHTML = `
        <div id="__plotPreviewCard" style="background:#fff;border-radius:10px;padding:10px;width:524px;max-width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.4);position:relative;">
            <button type="button" id="__plotPreviewClose"
                style="position:absolute;top:2px;right:8px;border:0;background:transparent;font-size:1.2rem;color:#888;cursor:pointer;line-height:1;">&times;</button>
            <div style="width:600px;height:500px;max-width:100%;display:flex;align-items:center;justify-content:center;overflow:auto;background:#fafafa;border-radius:10px;border:1px solid #eee;">
                <img src="${dataURL}" style="max-width:100%;max-height:100%;object-fit:contain;" alt="Plot preview"/>
            </div>
            <div style="text-align:center;margin-top:10px;">
                <button type="button" id="__plotPreviewDownload" class="btn btn-sm btn-primary px-4 fw-bold">
                    <i class="fa-solid fa-download me-1"></i>Download
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const close = () => {
        document.removeEventListener("keydown", onKey);
        modal.remove();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);

    modal.querySelector("#__plotPreviewClose").onclick = (e) => { e.stopPropagation(); close(); };
    // Clicking the overlay (outside the card) closes; ALL clicks inside the
    // modal are stopped from bubbling to the document so they never trigger
    // the plot-settings panel's outside-click-to-close handler.
    modal.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target === modal) close();
    });
    const card = modal.querySelector("#__plotPreviewCard");
    if (card) card.addEventListener("click", (e) => e.stopPropagation());
    modal.querySelector("#__plotPreviewDownload").onclick = (e) => {
        e.stopPropagation();
        onDownloadClick?.();
    };
}

/**
 * Mount a gear-button config panel into `anchor` and return the public API.
 */
export function mountPlotConfigPanel({ anchor, defaults = {}, onUpdate, onDownload, onPreview, options = {} } = {}) {
    const {
        showMarkerSize     = true,
        showMarkerOpacity  = true,
        showAxisFontSize   = true,
        showLabelSize      = true,
        showLegendFontSize = true,
        showGroupLabelSize = false,
        showEllipseOpacity = false,
        showLineWidth      = false,
        showColorPicker    = false,
        colorPickerKey     = "boxColor",
        colorPickerLabel   = "Color",
        showColorList      = false,
        colorList          = [], // [{ key, label, value }]
        showDownloadSection = true,
        showTestType       = false,
        testTypeList       = [], // [{ value, label }]
        testTypeLabel      = "Test type",
        defaultTestType    = "auto",
    } = options;
    if (!anchor) throw new Error("mountPlotConfigPanel: `anchor` element is required");

    const cfg = { ...PLOT_CONFIG_DEFAULTS, ...defaults };
    const pfx = `pcfg${++_uidCounter}`;

    // ── Generate stable element IDs (for ALL fields so setConfig always works) ─
    const IDS = {};
    [...RANGE_FIELDS.map(f => f.key), "imgWidth", "imgHeight", "imgFormat", "dlBtn", "previewBtn"]
        .forEach(k => (IDS[k] = `${pfx}_${k}`));

    // Condition map: conditional key → whether that field is shown
    const conditionMap = {
        markerSize:     showMarkerSize,
        markerOpacity:  showMarkerOpacity,
        axisFontSize:   showAxisFontSize,
        labelSize:      showLabelSize,
        legendFontSize: showLegendFontSize,
        groupLabelSize: showGroupLabelSize,
        ellipseOpacity: showEllipseOpacity,
        lineWidth:      showLineWidth,
    };

    // Determine which fields are active based on options
    const activeFields = RANGE_FIELDS.filter(f => {
        if (f.conditional) return conditionMap[f.conditional] !== false;
        return true;
    });

    // ── Build inner panel HTML ───────────────────────────────────────────────
    let rangeRows = "";
    activeFields.forEach(({ key, label, min, max, step }) => {
        rangeRows += `
        <div class="mb-2">
            <div class="d-flex justify-content-between mb-1">
                <span>${label}</span>
                <b id="${IDS[key]}_v">${cfg[key]}</b>
            </div>
            <input id="${IDS[key]}" type="range" class="form-range"
                min="${min}" max="${max}" step="${step}" value="${cfg[key]}"
                style="cursor:pointer;height:4px">
        </div>`;
    });

    let testTypeRow = "";
    if (showTestType && Array.isArray(testTypeList) && testTypeList.length > 0) {
        testTypeRow = `
        <div class="mb-2">
            <label class="d-block mb-1" style="font-size:0.74rem;color:#666">${testTypeLabel}</label>
            <select id="${pfx}_testType" class="form-select form-select-sm">
                ${testTypeList.map(opt => `<option value="${opt.value}"${(cfg.testType||defaultTestType)===opt.value?" selected": ""}>${opt.label}</option>`).join("")}
            </select>
        </div>`;
    }

    let colorPickerRow = "";
    if (showColorPicker) {
        const colorValue = String(cfg[colorPickerKey] || cfg.boxColor || "#1e40af");
        colorPickerRow = `
        <div class="mb-2 d-flex align-items-center justify-content-between" style="gap:8px;">
            <label class="mb-0" style="font-size:0.74rem;color:#666">${colorPickerLabel}</label>
            <input id="${pfx}_colorPicker" type="color" class="form-control form-control-color" value="${colorValue}" style="width:2.2rem;height:1.6rem;padding:0;border:0;background:transparent;">
        </div>`;
    }

    let colorListRows = "";
    if (showColorList && Array.isArray(colorList) && colorList.length > 0) {
        colorListRows = colorList.map((item, idx) => {
            const key = String(item?.key || `color_${idx}`);
            const label = String(item?.label || key);
            const value = String(cfg[key] || item?.value || "#1e40af");
            cfg[key] = value;
            return `
        <div class="mb-2 d-flex align-items-center justify-content-between" style="gap:8px;">
            <label class="mb-0" style="font-size:0.74rem;color:#666">${label}</label>
            <input id="${pfx}_colorList_${idx}" data-color-key="${key}" type="color" class="form-control form-control-color" value="${value}" style="width:2.2rem;height:1.6rem;padding:0;border:0;background:transparent;">
        </div>`;
        }).join("");
    }

    const downloadSectionHTML = showDownloadSection
        ? `
    <hr style="margin:8px 0">
    <div style="font-weight:600;margin-bottom:8px;font-size:0.8rem;">
        <i class="fa-solid fa-image me-1"></i> Download image
    </div>
    <div class="row g-2 mb-2">
        <div class="col-6">
            <label class="d-block mb-1" style="font-size:0.74rem;color:#666">Width (px)</label>
            <input id="${IDS.imgWidth}" type="number" class="form-control form-control-sm"
                min="400" max="8000" step="100" value="${cfg.imgWidth}">
        </div>
        <div class="col-6">
            <label class="d-block mb-1" style="font-size:0.74rem;color:#666">Height (px)</label>
            <input id="${IDS.imgHeight}" type="number" class="form-control form-control-sm"
                min="300" max="6000" step="100" value="${cfg.imgHeight}">
        </div>
    </div>
    <div class="mb-2">
        <label class="d-block mb-1" style="font-size:0.74rem;color:#666">Format</label>
        <div class="btn-group w-100" role="group">
            <input type="radio" class="btn-check" name="${IDS.imgFormat}" id="${IDS.imgFormat}_svg"  value="svg"  ${cfg.imgFormat === "svg"  ? "checked" : ""}>
            <label class="btn btn-sm btn-outline-secondary" for="${IDS.imgFormat}_svg">SVG</label>
            <input type="radio" class="btn-check" name="${IDS.imgFormat}" id="${IDS.imgFormat}_png"  value="png"  ${cfg.imgFormat === "png"  ? "checked" : ""}>
            <label class="btn btn-sm btn-outline-secondary" for="${IDS.imgFormat}_png">PNG</label>
            <input type="radio" class="btn-check" name="${IDS.imgFormat}" id="${IDS.imgFormat}_jpeg" value="jpeg" ${cfg.imgFormat === "jpeg" ? "checked" : ""}>
            <label class="btn btn-sm btn-outline-secondary" for="${IDS.imgFormat}_jpeg">JPEG</label>
        </div>
        <div style="font-size:0.68rem;color:#888;margin-top:4px;">SVG: vector (recommended). PNG/JPEG: raster ×6 scale (~600 PPI at print size).</div>
    </div>
    <button id="${IDS.dlBtn}" class="btn btn-sm btn-outline-primary w-100">
        <i class="fa-solid fa-download me-1"></i>Download ${cfg.imgFormat.toUpperCase()}
    </button>
    <button id="${IDS.previewBtn}" class="btn btn-sm btn-outline-secondary w-100 mt-1">
        <i class="fa-solid fa-eye me-1"></i>Preview
    </button>`
        : "";

    const panelHTML = `
    <div style="font-weight:700;font-size:0.82rem;border-bottom:1px solid #eee;padding-bottom:7px;margin-bottom:10px;">
        <i class="fa-solid fa-sliders me-1"></i> Plot Settings
    </div>
    ${rangeRows}
    ${colorPickerRow}
    ${colorListRows}
    ${testTypeRow}
    ${downloadSectionHTML}`;

    // ── Build wrapper, gear button, panel container ──────────────────────────
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:relative;display:inline-block;";

    const gearBtn = document.createElement("button");
    gearBtn.type = "button";
    gearBtn.className = "btn btn-sm btn-outline-secondary";
    gearBtn.title = "Plot settings";
    gearBtn.innerHTML = '<i class="fa-solid fa-gear"></i>';

    const panel = document.createElement("div");
    panel.style.cssText = [
        "position:fixed",
        "z-index:9999", "background:#fff",
        "border:1px solid #dee2e6", "border-radius:8px",
        "box-shadow:0 4px 18px rgba(0,0,0,.15)",
        "padding:14px 16px", "width:275px",
        "font-size:0.78rem", "color:#343a40", "display:none",
        "box-sizing:border-box", "overflow-y:auto", "overflow-x:hidden",
    ].join(";");
    panel.innerHTML = panelHTML;

    wrapper.appendChild(gearBtn);
    anchor.appendChild(wrapper);
    document.body.appendChild(panel);

    // ── Shortcut to get element inside panel by its ID ───────────────────────
    const $el = id => panel.querySelector(`#${id}`);

    // ── Bind range sliders ───────────────────────────────────────────────────
    activeFields.forEach(({ key }) => {
        const input   = $el(IDS[key]);
        const display = $el(`${IDS[key]}_v`);
        input.addEventListener("input", () => {
            const v = Number(input.value);
            if (display) display.textContent = v;
            cfg[key] = v;
            onUpdate?.(key, v, { ...cfg });
        });
    });

    // ── Bind testType dropdown ─────────────────────────────────────────────-
    if (showTestType && Array.isArray(testTypeList) && testTypeList.length > 0) {
        const sel = panel.querySelector(`#${pfx}_testType`);
        if (sel) {
            sel.addEventListener("change", () => {
                cfg.testType = sel.value;
                onUpdate?.("testType", sel.value, { ...cfg });
            });
        }
    }

    if (showColorPicker) {
        const colorInput = panel.querySelector(`#${pfx}_colorPicker`);
        if (colorInput) {
            colorInput.addEventListener("change", () => {
                const nextColor = colorInput.value || "#1e40af";
                cfg[colorPickerKey] = nextColor;
                if (colorPickerKey !== "boxColor") cfg.boxColor = cfg.boxColor || nextColor;
                onUpdate?.(colorPickerKey, nextColor, { ...cfg });
            });
        }
    }

    if (showColorList && Array.isArray(colorList) && colorList.length > 0) {
        colorList.forEach((item, idx) => {
            const key = String(item?.key || `color_${idx}`);
            const input = panel.querySelector(`#${pfx}_colorList_${idx}`);
            if (!input) return;
            input.addEventListener("change", () => {
                const nextColor = input.value || String(item?.value || "#1e40af");
                cfg[key] = nextColor;
                onUpdate?.(key, nextColor, { ...cfg });
            });
        });
    }

    // ── Bind number inputs (img size) ────────────────────────────────────────
    if (showDownloadSection) {
        ["imgWidth", "imgHeight"].forEach(key => {
            const input = $el(IDS[key]);
            const minVal = key === "imgWidth" ? 400 : 300;
            input.addEventListener("change", () => {
                const v = Math.max(minVal, Number(input.value) || cfg[key]);
                input.value = v;
                cfg[key] = v;
                onUpdate?.(key, v, { ...cfg });
            });
        });
    }

    // ── Bind format radio buttons ────────────────────────────────────────────
    const updateDlBtnLabel = () => {
        const btn = $el(IDS.dlBtn);
        if (btn) btn.innerHTML = `<i class="fa-solid fa-download me-1"></i>Download ${cfg.imgFormat.toUpperCase()}`;
    };
    if (showDownloadSection) {
        ["svg", "png", "jpeg"].forEach(fmt => {
            const radio = $el(`${IDS.imgFormat}_${fmt}`);
            if (!radio) return;
            radio.addEventListener("change", () => {
                if (!radio.checked) return;
                cfg.imgFormat = fmt;
                updateDlBtnLabel();
                onUpdate?.("imgFormat", fmt, { ...cfg });
            });
        });
    }

    // ── Download button ──────────────────────────────────────────────────────
    if (showDownloadSection) {
        $el(IDS.dlBtn).addEventListener("click", () => onDownload?.({ ...cfg }));
        // Preview button: capture the plot via Plotly.toImage (reusing the
        // page's onDownload to find the element + options) and show it in an
        // 800x800 modal with a centered Download button.
        const previewBtn = $el(IDS.previewBtn);
        if (previewBtn) {
            previewBtn.addEventListener("click", async () => {
                previewBtn.disabled = true;
                const original = previewBtn.innerHTML;
                previewBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Rendering…';
                try {
                    // Prefer an explicit onPreview (returns a data URL). Fall back
                    // to intercepting Plotly.downloadImage via the page's onDownload.
                    let dataURL = null;
                    if (typeof onPreview === "function") {
                        dataURL = await Promise.resolve(onPreview({ ...cfg }));
                    } else {
                        dataURL = await capturePlotPreview(() => onDownload?.({ ...cfg }));
                    }
                    if (dataURL) {
                        openImagePreviewModal(dataURL, () => onDownload?.({ ...cfg }));
                    } else {
                        alert("Preview is not available for this plot.");
                    }
                } finally {
                    previewBtn.disabled = false;
                    previewBtn.innerHTML = original;
                }
            });
        }
    }

    // ── Toggle panel open / close ────────────────────────────────────────────
    gearBtn.addEventListener("click", e => {
        e.stopPropagation();
        if (panel.style.display === "none") {
            const rect = gearBtn.getBoundingClientRect();
            const viewportPadding = 8;
            const panelWidth = 275;
            const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding);
            const spaceAbove = Math.max(0, rect.top - viewportPadding);

            let left = rect.right - panelWidth;
            if (left < viewportPadding) left = viewportPadding;
            const maxLeft = Math.max(viewportPadding, window.innerWidth - panelWidth - viewportPadding);
            if (left > maxLeft) left = maxLeft;

            panel.style.left = `${left}px`;
            panel.style.top = `${rect.bottom + 6}px`;
            panel.style.display = "block";

            const renderedHeight = panel.getBoundingClientRect().height;
            const fitsBelow = renderedHeight <= spaceBelow || spaceBelow >= spaceAbove;
            let top = fitsBelow ? (rect.bottom + 6) : (rect.top - renderedHeight - 6);
            if (top < viewportPadding) top = viewportPadding;
            const maxHeight = Math.max(180, fitsBelow ? spaceBelow : spaceAbove);
            panel.style.maxHeight = `${maxHeight}px`;
            panel.style.top = `${top}px`;
        } else {
            panel.style.display = "none";
        }
    });

    const closeOnOutsideClick = e => {
        if (!wrapper.contains(e.target) && !panel.contains(e.target)) panel.style.display = "none";
    };
    document.addEventListener("click", closeOnOutsideClick);

    // ── Public API ───────────────────────────────────────────────────────────
    return {
        /** Returns a snapshot of the current config. */
        getConfig: () => ({ ...cfg }),

        /**
         * Programmatically update one or more config keys and sync the UI.
         * Does NOT fire onUpdate.
         * @param {Partial<typeof PLOT_CONFIG_DEFAULTS>} partial
         */
        setConfig(partial) {
            Object.assign(cfg, partial);
            for (const [key, val] of Object.entries(partial)) {
                if (key === "imgFormat") {
                    const radio = $el(`${IDS.imgFormat}_${val}`);
                    if (radio) radio.checked = true;
                    updateDlBtnLabel();
                    continue;
                }
                if (showColorPicker && key === colorPickerKey) {
                    const colorInput = panel.querySelector(`#${pfx}_colorPicker`);
                    if (colorInput) colorInput.value = val;
                    continue;
                }
                if (showColorList) {
                    const colorIndex = colorList.findIndex((item, idx) => String(item?.key || `color_${idx}`) === key);
                    if (colorIndex >= 0) {
                        const colorInput = panel.querySelector(`#${pfx}_colorList_${colorIndex}`);
                        if (colorInput) colorInput.value = val;
                        continue;
                    }
                }
                if (!(key in IDS)) continue;
                const el = $el(IDS[key]);
                if (!el) continue;
                if (el.type === "checkbox") el.checked = val;
                else el.value = val;
                const disp = $el(`${IDS[key]}_v`);
                if (disp) disp.textContent = val;
            }
        },

        /** Remove the panel from DOM and detach all listeners. */
        destroy() {
            document.removeEventListener("click", closeOnOutsideClick);
            panel.remove();
            wrapper.remove();
        },
    };
}
