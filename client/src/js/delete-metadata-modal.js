import { normalizeMetaLabel, sortMetadataLabels } from "./meta-label-utils.js";

let ensured = null;

function getEl(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function colorFromText(text) {
    let hash = 0;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash) + value.charCodeAt(i);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 68%, 55%)`;
}

async function ensureModal() {
    if (ensured) return ensured;
    const holder = getEl("deleteMetadataModal");
    if (holder) {
        ensured = holder;
        return holder;
    }

    const response = await fetch("./delete-metadata-modal.html", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load delete metadata modal template.");
    const html = await response.text();
    document.body.insertAdjacentHTML("beforeend", html);
    ensured = getEl("deleteMetadataModal");
    if (!ensured) throw new Error("Delete metadata modal init failed.");
    return ensured;
}

function buildColumnStats(metadataRows, columnName) {
    const counts = new Map();
    (metadataRows || []).forEach((row) => {
        const label = normalizeMetaLabel(row?.[columnName]);
        counts.set(label, (counts.get(label) || 0) + 1);
    });
    return sortMetadataLabels([...counts.keys()]).map((label) => ({ label, count: counts.get(label) || 0 }));
}

export async function openDeleteMetadataModal({ metadataColumns = [], metadataRows = [], protectedColumns = [] } = {}) {
    const modalRoot = await ensureModal();
    const summaryEl = getEl("deleteMetaSummary");
    const columnsEl = getEl("deleteMetaColumns");
    const previewEl = getEl("deleteMetaPreview");
    const errorEl = getEl("deleteMetaError");
    const okBtn = getEl("deleteMetaOkBtn");

    const protectedSet = new Set((protectedColumns || []).map((name) => String(name || "").trim()));
    const columns = sortMetadataLabels((metadataColumns || []).map((name) => String(name || "").trim()).filter((name) => name && !protectedSet.has(name)));

    summaryEl.textContent = `${columns.length} metadata columns can be deleted. You can choose multiple columns.`;
    errorEl.textContent = "";

    const selected = new Set();

    const renderPreview = () => {
        if (!selected.size) {
            previewEl.innerHTML = '<div class="small text-muted">Select one or more metadata columns to preview labels.</div>';
            return;
        }

        previewEl.innerHTML = [...selected].map((columnName) => {
            const stats = buildColumnStats(metadataRows, columnName);
            return `
                <div class="mb-3">
                    <div class="small fw-semibold mb-1">${escapeHtml(columnName)}</div>
                    <div class="d-flex flex-wrap gap-2">
                        ${stats.map((item) => `
                            <span class="badge rounded-pill text-bg-light border d-inline-flex align-items-center gap-1">
                                <span class="d-inline-block rounded-circle" style="width:9px;height:9px;background:${escapeHtml(colorFromText(item.label))};"></span>
                                ${escapeHtml(item.label)} (${item.count})
                            </span>
                        `).join("")}
                    </div>
                </div>
            `;
        }).join("");
    };

    columnsEl.innerHTML = columns.length
        ? columns.map((name, idx) => `
            <div class="form-check mb-1">
                <input class="form-check-input" type="checkbox" value="${escapeHtml(name)}" id="deleteMetaCol_${idx}">
                <label class="form-check-label small" for="deleteMetaCol_${idx}">${escapeHtml(name)}</label>
            </div>
        `).join("")
        : '<div class="small text-muted">No metadata columns available.</div>';

    columnsEl.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.addEventListener("change", () => {
            const colName = String(input.value || "").trim();
            if (!colName) return;
            if (input.checked) selected.add(colName);
            else selected.delete(colName);
            renderPreview();
        });
    });

    renderPreview();

    const bsModal = bootstrap.Modal.getOrCreateInstance(modalRoot);

    return await new Promise((resolve) => {
        const onHidden = () => {
            okBtn.removeEventListener("click", onOk);
            modalRoot.removeEventListener("hidden.bs.modal", onHidden);
            resolve(null);
        };

        const finish = (value) => {
            okBtn.removeEventListener("click", onOk);
            modalRoot.removeEventListener("hidden.bs.modal", onHidden);
            bsModal.hide();
            resolve(value);
        };

        const onOk = () => {
            errorEl.textContent = "";
            const columnsToDelete = [...selected];
            if (!columnsToDelete.length) {
                errorEl.textContent = "Please choose at least one metadata column.";
                return;
            }
            finish({ columnsToDelete });
        };

        okBtn.addEventListener("click", onOk);
        modalRoot.addEventListener("hidden.bs.modal", onHidden, { once: true });
        bsModal.show();
    });
}
