import { normalizeMetaLabel } from "./meta-label-utils.js";

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

async function ensureModal() {
    if (ensured) return ensured;
    const holder = getEl("editMetadataModal");
    if (holder) {
        ensured = holder;
        return holder;
    }

    const response = await fetch("./edit-metadata-modal.html", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load edit metadata modal template.");
    const html = await response.text();
    document.body.insertAdjacentHTML("beforeend", html);
    ensured = getEl("editMetadataModal");
    if (!ensured) throw new Error("Edit metadata modal init failed.");
    return ensured;
}

export async function openEditMetadataModal({
    metadataColumns = [],
    activeColumn = "",
    labels = [],
    colorMap = new Map(),
} = {}) {
    const modalRoot = await ensureModal();
    const summaryEl = getEl("editMetaSummary");
    const currentNameEl = getEl("editMetaCurrentName");
    const newNameEl = getEl("editMetaNewName");
    const rowsEl = getEl("editMetaRows");
    const errorEl = getEl("editMetaError");
    const okBtn = getEl("editMetaOkBtn");

    const normalizedColumns = [...new Set((metadataColumns || []).map((col) => String(col || "").trim()).filter(Boolean))];
    const distinctLabels = [...new Set((labels || []).map((label) => normalizeMetaLabel(label)))];

    summaryEl.textContent = `${distinctLabels.length} labels in metadata column "${activeColumn}".`;
    currentNameEl.value = activeColumn || "";
    newNameEl.value = activeColumn || "";
    errorEl.textContent = "";

    rowsEl.innerHTML = distinctLabels.map((label, index) => {
        const color = colorMap.get(label) || "#9ca3af";
        return `
            <div class="d-flex align-items-center gap-2" data-row-index="${index}">
                <span class="d-inline-block rounded-circle border" style="width:12px;height:12px;background:${escapeHtml(color)};"></span>
                <input class="form-control form-control-sm" type="text" value="${escapeHtml(label)}" disabled>
                <span class="small text-muted">-></span>
                <input class="form-control form-control-sm" data-role="new-label" data-old-label="${escapeHtml(label)}" type="text" value="${escapeHtml(label)}" placeholder="--Name--">
            </div>
        `;
    }).join("");

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
            const targetColumn = String(newNameEl.value || "").trim().replace(/\s+/g, "_");
            if (!targetColumn) {
                errorEl.textContent = "Metadata name is required.";
                return;
            }
            if (targetColumn !== activeColumn && normalizedColumns.includes(targetColumn)) {
                errorEl.textContent = "Metadata name already exists.";
                return;
            }

            const renameMap = {};
            const inputs = [...rowsEl.querySelectorAll("[data-role='new-label']")];
            for (const input of inputs) {
                const oldLabel = normalizeMetaLabel(input.dataset.oldLabel || "");
                const newLabel = String(input.value || "").trim();
                if (!newLabel) {
                    errorEl.textContent = "Each label must have a new name.";
                    return;
                }
                const normalizedNew = normalizeMetaLabel(newLabel);
                renameMap[oldLabel] = normalizedNew;
            }

            finish({ sourceColumn: activeColumn, targetColumn, renameMap });
        };

        okBtn.addEventListener("click", onOk);
        modalRoot.addEventListener("hidden.bs.modal", onHidden, { once: true });
        bsModal.show();
    });
}
