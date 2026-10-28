import { isNanLikeLabel } from "./meta-label-utils.js";

let ensured = null;

function getEl(id) {
    return document.getElementById(id);
}

async function ensureModal() {
    if (ensured) return ensured;
    const holder = getEl("appendMetaModal");
    if (holder) {
        ensured = holder;
        return holder;
    }

    const response = await fetch("./append-meta-modal.html", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load append metadata modal template.");
    const html = await response.text();
    document.body.insertAdjacentHTML("beforeend", html);
    ensured = getEl("appendMetaModal");
    if (!ensured) throw new Error("Append metadata modal init failed.");
    return ensured;
}

export async function openAppendMetaModal({ metadataColumns = [], defaultColumn = "", selectedCount = 0, defaultLabel = "" } = {}) {
    const modalRoot = await ensureModal();
    const modeEl = getEl("appendMetaMode");
    const existingWrap = getEl("appendMetaExistingWrap");
    const existingColEl = getEl("appendMetaExistingCol");
    const createWrap = getEl("appendMetaCreateWrap");
    const createColEl = getEl("appendMetaCreateCol");
    const labelEl = getEl("appendMetaLabel");
    const summaryEl = getEl("appendMetaSummary");
    const errorEl = getEl("appendMetaError");
    const okBtn = getEl("appendMetaOkBtn");

    summaryEl.textContent = `${selectedCount} selected samples will be updated.`;
    errorEl.textContent = "";
    labelEl.value = String(defaultLabel || "").trim();
    createColEl.value = "";

    const cols = [...new Set((metadataColumns || []).map((col) => String(col || "").trim()).filter(Boolean))];
    existingColEl.innerHTML = cols.length
        ? cols.map((col) => `<option value="${col.replace(/"/g, "&quot;")}">${col}</option>`).join("")
        : '<option value="">-- No metadata columns --</option>';

    if (defaultColumn && cols.includes(defaultColumn)) existingColEl.value = defaultColumn;

    const syncModeUi = () => {
        const isCreate = modeEl.value === "create";
        existingWrap.classList.toggle("d-none", isCreate);
        createWrap.classList.toggle("d-none", !isCreate);
        errorEl.textContent = "";
    };

    modeEl.value = "append";
    syncModeUi();

    const bsModal = bootstrap.Modal.getOrCreateInstance(modalRoot);

    return await new Promise((resolve) => {
        const onHidden = () => {
            modeEl.removeEventListener("change", syncModeUi);
            okBtn.removeEventListener("click", onOk);
            modalRoot.removeEventListener("hidden.bs.modal", onHidden);
            resolve(null);
        };

        const finish = (value) => {
            modeEl.removeEventListener("change", syncModeUi);
            okBtn.removeEventListener("click", onOk);
            modalRoot.removeEventListener("hidden.bs.modal", onHidden);
            bsModal.hide();
            resolve(value);
        };

        const onOk = () => {
            errorEl.textContent = "";
            const mode = modeEl.value === "create" ? "create" : "append";
            const label = String(labelEl.value || "").trim();
            if (!label) {
                errorEl.textContent = "Label name is required.";
                return;
            }
            if (isNanLikeLabel(label)) {
                errorEl.textContent = 'Label cannot be "nan"/"NaN".';
                return;
            }

            let column = "";
            if (mode === "create") {
                column = String(createColEl.value || "").trim().replace(/\s+/g, "_");
                if (!column) {
                    errorEl.textContent = "New metadata name is required.";
                    return;
                }
                if (cols.includes(column)) {
                    errorEl.textContent = "New metadata name already exists.";
                    return;
                }
            } else {
                column = String(existingColEl.value || "").trim();
                if (!column) {
                    errorEl.textContent = "Please choose an existing metadata column.";
                    return;
                }
            }

            finish({ mode, column, label });
        };

        modeEl.addEventListener("change", syncModeUi);
        okBtn.addEventListener("click", onOk);
        modalRoot.addEventListener("hidden.bs.modal", onHidden, { once: true });
        bsModal.show();
    });
}
