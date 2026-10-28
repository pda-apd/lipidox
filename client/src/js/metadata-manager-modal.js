import { normalizeMetaLabel, sortMetadataLabels, orderLabelsByGroups } from "./meta-label-utils.js";

let ensured = null;

function getEl(id) { return document.getElementById(id); }

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(value) { return escapeHtml(value); }

function colorFromText(text) {
    let hash = 0;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash) + value.charCodeAt(i);
    return `hsl(${Math.abs(hash) % 360}, 68%, 55%)`;
}

const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function buildColumnStats(metadataRows, columnName, savedGroups) {
    const counts = new Map();
    (metadataRows || []).forEach((row) => {
        const label = normalizeMetaLabel(row?.[columnName]);
        counts.set(label, (counts.get(label) || 0) + 1);
    });
    const labels = orderLabelsByGroups([...counts.keys()], savedGroups);
    return labels.map((label) => ({ label, count: counts.get(label) || 0 }));
}

async function ensureModal() {
    if (ensured) return ensured;
    const holder = getEl("metadataManagerModal");
    if (holder) { ensured = holder; return holder; }
    const response = await fetch("./metadata-manager-modal.html", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load metadata manager modal template.");
    document.body.insertAdjacentHTML("beforeend", await response.text());
    ensured = getEl("metadataManagerModal");
    if (!ensured) throw new Error("Metadata manager modal init failed.");
    if (!document.getElementById("mmgr-inline-style")) {
        const style = document.createElement("style");
        style.id = "mmgr-inline-style";
        style.textContent = `
        .mmgr-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:8px 10px;margin-bottom:10px;}
        .mmgr-toolbar .mmgr-sel-name{font-weight:600;font-size:.82rem;color:#0d6efd;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .mmgr-col-item{display:flex;align-items:center;gap:6px;border:1px solid #e9ecef;border-radius:8px;padding:7px 10px;margin-bottom:6px;cursor:pointer;background:#fff;}
        .mmgr-col-item.active{border-color:#0d6efd;background:#f0f6ff;}
        .mmgr-col-item .mmgr-col-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.82rem;}
        .mmgr-rename-row{display:flex;gap:4px;align-items:center;width:100%;}
        .mmgr-del-confirm{background:#fff5f5;border:1px solid #f5c2c7;border-radius:6px;padding:8px;margin-top:6px;}
        .mmgr-label-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #e9ecef;border-radius:8px;margin-bottom:6px;background:#fff;}
        .mmgr-label-row.is-dragging{opacity:.35;}
        .mmgr-label-row.drag-over{border-color:#0d6efd;border-style:dashed;}
        .mmgr-drag-handle{cursor:grab;color:#9aa3ad;flex-shrink:0;padding:0 2px;}
        .mmgr-drag-handle:active{cursor:grabbing;}
        .mmgr-count{font-size:.72rem;color:#6c757d;min-width:30px;text-align:right;flex-shrink:0;}
        .mmgr-label-input{flex:1 1 auto;min-width:0;}
        .mmgr-drop-zone{min-height:40px;}`;
        document.head.appendChild(style);
    }
    return ensured;
}

export async function openMetadataManagerModal({
    metadataColumns = [],
    metadataRows = [],
    activeColumn = "",
    colorMap = new Map(),
    metaMetadata = [],
} = {}) {
    const modalRoot = await ensureModal();
    const summaryEl = getEl("metadataManagerSummary");
    const leftTitleEl = getEl("metadataManagerLeftTitle");
    const rightTitleEl = getEl("metadataManagerRightTitle");
    const leftEl = getEl("metadataManagerLeft");
    const rightEl = getEl("metadataManagerRight");
    const errorEl = getEl("metadataManagerError");
    const okBtn = getEl("metadataManagerOkBtn");
    const createBtn = getEl("metadataManagerCreateBtn");

    let columns = sortMetadataLabels((metadataColumns || []).map((n) => String(n || "").trim()).filter(Boolean));
    const savedGroupsByCol = new Map();
    (metaMetadata || []).forEach((m) => {
        if (m?.name) savedGroupsByCol.set(String(m.name), Array.isArray(m.groups) ? [...m.groups] : []);
    });

    const state = {
        mode: "edit",
        selectedColumn: columns.includes(activeColumn) ? activeColumn : (columns[0] || ""),
        createMode: "duplicate",
        createName: "",
        level1: "",
        level2: "",
        level3: "",
    };

    // summaryEl.textContent = "Click a column to select it. Use Rename / Delete at the top (acts on the selected column). Edit & drag labels on the right, then Apply.";
    errorEl.textContent = "";
    okBtn.textContent = "Apply";
    okBtn.className = "btn btn-primary btn-sm";

    // ── Action resolution (hoisted so all handlers can finish the modal) ──
    let _resolve = null;
    let _done = false;
    const cleanup = () => {
        okBtn.removeEventListener("click", onOk);
        createBtn.removeEventListener("click", onCreateToggle);
        modalRoot.removeEventListener("hidden.bs.modal", onHidden);
    };
    const finish = (value) => {
        if (_done) return;
        _done = true;
        cleanup();
        bsModal.hide();
        if (_resolve) { _resolve(value); _resolve = null; }
    };
    const onHidden = () => { if (!_done) { _done = true; cleanup(); if (_resolve) { _resolve(null); _resolve = null; } } };
    const onOk = () => { errorEl.textContent = ""; handleApply(); };
    const onCreateToggle = () => { state.mode = state.mode === "create" ? "edit" : "create"; renderAll(); };
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalRoot);

    // ── LEFT (edit mode): toolbar + column list ─────────────────────────
    function renderLeftEdit() {
        leftTitleEl.textContent = "Metadata columns";
        const sel = state.selectedColumn || "";

        // Toolbar lives OUTSIDE the scrollable list so it never overlaps the
        // column items. Lazily create a dedicated container above #left.
        let toolbarHost = getEl("metadataManagerToolbar");
        if (!toolbarHost) {
            toolbarHost = document.createElement("div");
            toolbarHost.id = "metadataManagerToolbar";
            leftEl.parentNode.insertBefore(toolbarHost, leftEl);
        }
        toolbarHost.innerHTML = `
            <div class="mmgr-toolbar">
                <span class="small text-muted">Selected:</span>
                <span class="mmgr-sel-name" title="${escapeAttr(sel)}">${escapeHtml(sel || "—")}</span>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="mmgrRenameBtn" ${sel ? "" : "disabled"} title="Rename selected column"><i class="fa-solid fa-pen me-1"></i>Rename</button>
                <button type="button" class="btn btn-sm btn-outline-danger" id="mmgrDeleteBtn" ${sel ? "" : "disabled"} title="Delete selected column"><i class="fa-solid fa-trash me-1"></i>Delete</button>
            </div>`;

        // Column list (scrollable) — only the items, no toolbar inside.
        leftEl.innerHTML = columns.length
            ? columns.map((col) => {
                const active = state.selectedColumn === col;
                return `<div class="mmgr-col-item ${active ? "active" : ""}" data-select-col="${escapeAttr(col)}" data-rename-col="${escapeAttr(col)}">
                    <span class="mmgr-col-name">${escapeHtml(col)}</span>
                </div>`;
            }).join("")
            : '<div class="small text-muted">No metadata columns.</div>';

        leftEl.querySelectorAll("[data-select-col]").forEach((item) => {
            item.addEventListener("click", () => {
                state.selectedColumn = String(item.getAttribute("data-select-col") || "");
                renderLeftEdit();
                renderRightEdit();
            });
            item.addEventListener("dblclick", () => startRenameColumn(String(item.getAttribute("data-rename-col") || "")));
        });
        const renameBtn = getEl("mmgrRenameBtn");
        const deleteBtn = getEl("mmgrDeleteBtn");
        if (renameBtn) renameBtn.addEventListener("click", () => { if (state.selectedColumn) startRenameColumn(state.selectedColumn); });
        if (deleteBtn) deleteBtn.addEventListener("click", () => { if (state.selectedColumn) startDeleteColumn(state.selectedColumn); });
    }

    function startRenameColumn(col) {
        const item = leftEl.querySelector(`.mmgr-col-item[data-select-col="${CSS.escape(col)}"]`);
        if (!item) return;
        item.classList.remove("active");
        item.innerHTML = `
            <div class="mmgr-rename-row">
                <input class="form-control form-control-sm mmgr-rename-input" type="text" value="${escapeAttr(col)}">
                <button type="button" class="btn btn-sm btn-success mmgr-rename-ok"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="btn btn-sm btn-outline-secondary mmgr-rename-cancel"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
        const input = item.querySelector(".mmgr-rename-input");
        input.focus(); input.select();
        const cancel = () => renderLeftEdit();
        item.querySelector(".mmgr-rename-cancel").addEventListener("click", cancel);
        item.querySelector(".mmgr-rename-ok").addEventListener("click", () => commitRename(col, input.value));
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") commitRename(col, input.value);
            else if (ev.key === "Escape") cancel();
        });
    }

    function commitRename(oldName, rawNew) {
        const newName = String(rawNew || "").trim().replace(/\s+/g, "_");
        errorEl.textContent = "";
        if (!newName) { errorEl.textContent = "Name is required."; return; }
        if (newName === oldName) { renderLeftEdit(); return; }
        if (!NAME_REGEX.test(newName)) { errorEl.textContent = "Name may only contain letters, digits, '_' or '-'. Changes not saved."; return; }
        if (columns.includes(newName)) { errorEl.textContent = "A column with that name already exists."; return; }
        finish({ action: "renameColumn", oldName, newName });
    }

    function startDeleteColumn(col) {
        const item = leftEl.querySelector(`.mmgr-col-item[data-select-col="${CSS.escape(col)}"]`);
        if (!item) return;
        item.innerHTML = `
            <div class="mmgr-del-confirm">
                <div class="small fw-bold text-danger mb-1"><i class="fa-solid fa-triangle-exclamation me-1"></i>Delete "${escapeHtml(col)}"?</div>
                <div class="small text-muted mb-2">Type the column name to confirm:</div>
                <input class="form-control form-control-sm mmgr-del-input mb-2" type="text" placeholder="${escapeAttr(col)}">
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-sm btn-danger mmgr-del-ok" disabled>Delete</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary mmgr-del-cancel">Cancel</button>
                </div>
            </div>`;
        const input = item.querySelector(".mmgr-del-input");
        const ok = item.querySelector(".mmgr-del-ok");
        item.querySelector(".mmgr-del-cancel").addEventListener("click", () => renderLeftEdit());
        input.addEventListener("input", () => { ok.disabled = String(input.value).trim() !== col; });
        input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ok.disabled) finish({ action: "delete", columnsToDelete: [col] }); });
        ok.addEventListener("click", () => finish({ action: "delete", columnsToDelete: [col] }));
        input.focus();
    }

    // ── RIGHT (edit mode): editable labels + drag reorder (no color dot) ─
    function renderRightEdit() {
        rightTitleEl.textContent = `Labels: ${state.selectedColumn || "-"}`;
        const col = state.selectedColumn;
        if (!col) { rightEl.innerHTML = '<div class="small text-muted">No metadata column selected.</div>'; return; }
        const stats = buildColumnStats(metadataRows, col, savedGroupsByCol.get(col));
        const countByLabel = new Map(stats.map((s) => [s.label, s.count]));
        const rowsHtml = stats.map((s) => `
            <div class="mmgr-label-row" draggable="true" data-label="${escapeAttr(s.label)}">
                <span class="mmgr-drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                <span class="mmgr-count" title="sample count">${s.count}</span>
                <input class="form-control form-control-sm mmgr-label-input" type="text" value="${escapeAttr(s.label)}" data-label="${escapeAttr(s.label)}">
            </div>`).join("");
        rightEl.innerHTML = `
            // <div class="small text-muted mb-2">Click a label to edit it. Drag <i class="fa-solid fa-grip-vertical"></i> to reorder. Apply to save.</div>
            <div id="mmgr-label-list" class="mmgr-drop-zone">${rowsHtml}</div>`;

        const listEl = rightEl.querySelector("#mmgr-label-list");
        let dragSrc = null;
        listEl.querySelectorAll(".mmgr-label-row").forEach((row) => {
            row.addEventListener("dragstart", (e) => {
                dragSrc = row;
                row.classList.add("is-dragging");
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", row.dataset.label);
            });
            row.addEventListener("dragend", () => {
                row.classList.remove("is-dragging");
                listEl.querySelectorAll(".mmgr-label-row").forEach((r) => r.classList.remove("drag-over"));
                dragSrc = null;
            });
            row.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragSrc && row !== dragSrc) row.classList.add("drag-over");
            });
            row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("drag-over");
                if (!dragSrc || dragSrc === row) return;
                // Decide insert position based on cursor relative to row midpoint.
                const rect = row.getBoundingClientRect();
                const after = (e.clientY - rect.top) > rect.height / 2;
                if (after && row.nextSibling) row.parentNode.insertBefore(dragSrc, row.nextSibling);
                else if (after && !row.nextSibling) row.parentNode.appendChild(dragSrc);
                else row.parentNode.insertBefore(dragSrc, row);
            });
        });
    }

    // Collect labels in current DOM order with their (possibly edited) values.
    rightEl._commitLabels = () => {
        const rows = Array.from(rightEl.querySelectorAll("#mmgr-label-list .mmgr-label-row"));
        const orderedLabels = [];
        const renameMap = {};
        const seen = new Set();
        rows.forEach((row) => {
            const orig = row.dataset.label;
            const input = row.querySelector(".mmgr-label-input");
            const val = normalizeMetaLabel(input ? input.value : orig);
            renameMap[orig] = val;
            if (!seen.has(val)) { orderedLabels.push(val); seen.add(val); }
        });
        return { orderedLabels, renameMap };
    };

    // ── Create mode ─────────────────────────────────────────────────────
    function buildCreateColumnOptions(selected) {
        return ['<option value="">-- Select --</option>']
            .concat(columns.map((col) => `<option value="${escapeAttr(col)}" ${selected === col ? "selected" : ""}>${escapeHtml(col)}</option>`))
            .join("");
    }
    function renderLeftCreate() {
        leftTitleEl.textContent = "Create config";
        // Hide the edit-mode toolbar (Rename/Delete) — create mode has its own config.
        const tbHost = getEl("metadataManagerToolbar");
        if (tbHost) tbHost.innerHTML = "";
        leftEl.innerHTML = `
            <div class="mb-2">
                <label class="form-label small mb-1">New metadata name <span class="text-muted">(letters, digits, _ or -)</span></label>
                <input id="metaCreateName" class="form-control form-control-sm" type="text" value="${escapeAttr(state.createName)}" placeholder="new_meta_name">
            </div>
            <div class="mb-2">
                <div class="form-check mb-1">
                    <input class="form-check-input" type="radio" name="metaCreateMode" id="metaCreateDuplicate" value="duplicate" ${state.createMode === "duplicate" ? "checked" : ""}>
                    <label class="form-check-label small" for="metaCreateDuplicate">Duplicate from 1 column</label>
                </div>
                <div class="form-check mb-1">
                    <input class="form-check-input" type="radio" name="metaCreateMode" id="metaCreateMerge" value="merge" ${state.createMode === "merge" ? "checked" : ""}>
                    <label class="form-check-label small" for="metaCreateMerge">Merge by level 1 / 2 / 3</label>
                </div>
            </div>
            <div class="mb-2">
                <label class="form-label small mb-1">Level 1</label>
                <select id="metaCreateLevel1" class="form-select form-select-sm">${buildCreateColumnOptions(state.level1)}</select>
            </div>
            <div class="mb-2 ${state.createMode === "merge" ? "" : "d-none"}">
                <label class="form-label small mb-1">Level 2</label>
                <select id="metaCreateLevel2" class="form-select form-select-sm">${buildCreateColumnOptions(state.level2)}</select>
            </div>
            <div class="mb-2 ${state.createMode === "merge" ? "" : "d-none"}">
                <label class="form-label small mb-1">Level 3 (optional)</label>
                <select id="metaCreateLevel3" class="form-select form-select-sm">${buildCreateColumnOptions(state.level3)}</select>
            </div>`;
        const nameInput = getEl("metaCreateName");
        if (nameInput) nameInput.addEventListener("input", () => { state.createName = String(nameInput.value || ""); });
        leftEl.querySelectorAll("input[name='metaCreateMode']").forEach((radio) => {
            radio.addEventListener("change", () => { state.createMode = radio.value === "merge" ? "merge" : "duplicate"; renderLeftCreate(); renderRightCreate(); });
        });
        [["metaCreateLevel1", "level1"], ["metaCreateLevel2", "level2"], ["metaCreateLevel3", "level3"]].forEach(([id, key]) => {
            const sel = getEl(id);
            if (sel) sel.addEventListener("change", () => { state[key] = String(sel.value || ""); renderRightCreate(); });
        });
    }
    function renderRightCreate() {
        rightTitleEl.textContent = "Preview labels";
        const sourceColumns = [];
        if (state.level1) sourceColumns.push(state.level1);
        if (state.createMode === "merge" && state.level2) sourceColumns.push(state.level2);
        if (state.createMode === "merge" && state.level3) sourceColumns.push(state.level3);
        if (!sourceColumns.length) { rightEl.innerHTML = '<div class="small text-muted">Choose level columns to preview.</div>'; return; }
        const previewMap = new Map();
        (metadataRows || []).forEach((row) => {
            const parts = sourceColumns.map((c) => normalizeMetaLabel(row?.[c]));
            previewMap.set(parts.join(" - "), (previewMap.get(parts.join(" - ")) || 0) + 1);
        });
        const labels = sortMetadataLabels([...previewMap.keys()]);
        rightEl.innerHTML = labels.length
            ? labels.map((label) => `
                <div class="small mb-1 d-flex align-items-center gap-2">
                    <span class="d-inline-block rounded-circle" style="width:9px;height:9px;background:${escapeAttr(colorFromText(label))};"></span>
                    <span>${escapeHtml(label)} (${previewMap.get(label) || 0})</span>
                </div>`).join("")
            : '<div class="small text-muted">No preview rows.</div>';
    }

    function renderAll() {
        errorEl.textContent = "";
        if (state.mode === "create") {
            renderLeftCreate(); renderRightCreate();
            summaryEl.textContent = "Create mode: configure a new column, then Apply. It becomes the active column.";
            createBtn.classList.remove("btn-outline-primary"); createBtn.classList.add("btn-primary");
        } else {
            renderLeftEdit(); renderRightEdit();
            // summaryEl.textContent = "Edit mode: Rename / Delete act on the selected column. Edit & drag labels on the right, then Apply.";
            createBtn.classList.add("btn-outline-primary"); createBtn.classList.remove("btn-primary");
        }
    }

    function handleApply() {
        if (state.mode === "create") {
            const newMetaName = String(state.createName || "").trim().replace(/\s+/g, "_");
            if (!newMetaName) { errorEl.textContent = "New metadata name is required."; return; }
            if (!NAME_REGEX.test(newMetaName)) { errorEl.textContent = "Name may only contain letters, digits, '_' or '-'."; return; }
            if (columns.includes(newMetaName)) { errorEl.textContent = "Metadata name already exists."; return; }
            const sourceColumns = [];
            if (state.level1) sourceColumns.push(state.level1);
            if (state.createMode === "merge") { if (state.level2) sourceColumns.push(state.level2); if (state.level3) sourceColumns.push(state.level3); }
            if (new Set(sourceColumns).size !== sourceColumns.length) { errorEl.textContent = "Level columns must be different."; return; }
            if (state.createMode === "duplicate") {
                if (sourceColumns.length !== 1) { errorEl.textContent = "Duplicate mode needs exactly Level 1."; return; }
            } else if (sourceColumns.length < 2 || sourceColumns.length > 3) { errorEl.textContent = "Merge mode needs Level 1 + Level 2, optional Level 3."; return; }
            finish({ action: "create", mode: state.createMode, newMetaName, sourceColumns });
            return;
        }
        if (!state.selectedColumn) { errorEl.textContent = "Select one metadata column first."; return; }
        const { orderedLabels, renameMap } = (rightEl._commitLabels || (() => ({ orderedLabels: [], renameMap: {} })))();
        if (!orderedLabels.length) { errorEl.textContent = "No labels to update."; return; }
        finish({
            action: "edit",
            sourceColumn: state.selectedColumn,
            targetColumn: state.selectedColumn,
            renameMap,
            groupOrder: orderedLabels,
        });
    }

    return await new Promise((resolve) => {
        _resolve = resolve;
        okBtn.addEventListener("click", onOk);
        createBtn.addEventListener("click", onCreateToggle);
        modalRoot.addEventListener("hidden.bs.modal", onHidden, { once: true });
        renderAll();
        bsModal.show();
    });
}
