import { db, storage } from "./firebase-config.js";
import { doc, getDoc, getDownloadURL, ref, getToken, API_BASE } from "./firebase-config.js";

const PREPROCESS_MODE = "preprocess_portal";
const MODAL_ID = "project-file-actions-modal";

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export async function getProjectData(projectId) {
    const projectSnap = await getDoc(doc(db, "projects", projectId));
    return projectSnap.exists() ? projectSnap.data() : null;
}

export function getReviewArtifacts(projectData) {
    const isPreprocessed = projectData?.uploadMode === PREPROCESS_MODE;
    return [
        {
            key: "matrix",
            label: isPreprocessed ? "Preprocessed Matrix" : "Matrix",
            path: isPreprocessed ? projectData.matrixPreprocessedPath : projectData.matrixPath,
        },
        {
            key: "metadata",
            label: "Metadata",
            path: projectData.metaPath,
        },
    ];
}

export function getFilteringArtifacts(projectData) {
    const isPreprocessed = projectData?.uploadMode === PREPROCESS_MODE;
    return [
        {
            key: "matrix",
            label: isPreprocessed ? "Preprocessed Matrix" : "Matrix",
            path: isPreprocessed ? projectData.matrixPreprocessedPath : projectData.matrixPath,
        },
        {
            key: "metadata",
            label: projectData.metaCheckedPath ? "Checked Metadata" : "Metadata",
            path: projectData.metaCheckedPath || projectData.metaPath,
        },
    ];
}

export function getNormalizationArtifacts(projectData) {
    return [
        {
            key: "matrix",
            label: "Normalized Matrix",
            path: projectData.matrixNormPath || projectData.matrixCheckedPath,
        },
        {
            key: "metadata",
            label: projectData.metaCheckedPath ? "Checked Metadata" : "Metadata",
            path: projectData.metaCheckedPath || projectData.metaPath,
        },
    ];
}

export function getFinalDownloadArtifacts(projectData) {
    return {
        matrix: {
            label: "Final Matrix (Pre-scale)",
            path: projectData.matrixPreScalePath || projectData.matrixNormPath || projectData.matrixCheckedPath || projectData.matrixPath,
        },
        metadata: {
            label: "Final Metadata",
            path: projectData.metaCheckedPath || projectData.metaPath,
        },
    };
}

function getFileNameFromPath(path) {
    return (path || "download.csv").split("/").pop() || "download.csv";
}

export async function downloadStorageFile(path, preferredFileName) {
    if (!path) {
        throw new Error("The requested file is not available yet.");
    }

    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!response.ok) throw new Error("Unable to download the requested file.");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = preferredFileName || getFileNameFromPath(path);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function getFilePreviewText(path, maxLines = 30) {
    const url = await getDownloadURL(ref(storage, path));
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
    });
    const text = await response.text();
    const lines = text.split(/\r?\n/).slice(0, maxLines);
    return lines.join("\n");
}

function ensureActionModal() {
    let modalElement = document.getElementById(MODAL_ID);
    if (!modalElement) {
        modalElement = document.createElement("div");
        modalElement.className = "modal fade";
        modalElement.id = MODAL_ID;
        modalElement.tabIndex = -1;
        modalElement.innerHTML = `
            <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content border-0 shadow">
                    <div class="modal-header bg-dark text-white border-0">
                        <h5 class="modal-title" id="project-file-modal-title">Project Files</h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div id="project-file-modal-actions" class="d-grid gap-2 mb-3"></div>
                        <div class="border rounded bg-light p-3">
                            <div class="small text-uppercase text-muted fw-bold mb-2" id="project-file-preview-title">Preview</div>
                            <pre id="project-file-preview" class="mb-0 small" style="min-height: 320px; max-height: 420px; overflow: auto; white-space: pre-wrap;"></pre>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modalElement);
    }

    return {
        modalElement,
        modalInstance: bootstrap.Modal.getOrCreateInstance(modalElement),
        titleElement: modalElement.querySelector("#project-file-modal-title"),
        actionsElement: modalElement.querySelector("#project-file-modal-actions"),
        previewTitleElement: modalElement.querySelector("#project-file-preview-title"),
        previewElement: modalElement.querySelector("#project-file-preview"),
    };
}

export async function openProjectFileActions(title, files) {
    const availableFiles = files.filter((file) => file && file.path);
    const modal = ensureActionModal();
    modal.titleElement.textContent = title;

    if (!availableFiles.length) {
        modal.actionsElement.innerHTML = '<div class="alert alert-warning mb-0">Files are not available yet.</div>';
        modal.previewTitleElement.textContent = "Preview";
        modal.previewElement.textContent = "No files available.";
        modal.modalInstance.show();
        return;
    }

    modal.actionsElement.innerHTML = availableFiles.map((file, index) => `
        <div class="d-flex justify-content-between align-items-center gap-2 border rounded p-2 bg-white">
            <div>
                <div class="fw-bold small">${escapeHtml(file.label)}</div>
                <div class="text-muted" style="font-size: 0.75rem;">${escapeHtml(getFileNameFromPath(file.path))}</div>
            </div>
            <div class="d-flex gap-2">
                <button type="button" class="btn btn-outline-primary btn-sm" data-role="preview" data-index="${index}">
                    <i class="fa-solid fa-eye me-1"></i>Preview
                </button>
                <button type="button" class="btn btn-primary btn-sm" data-role="download" data-index="${index}">
                    <i class="fa-solid fa-download me-1"></i>Download
                </button>
            </div>
        </div>
    `).join("");

    modal.previewTitleElement.textContent = "Preview";
    modal.previewElement.textContent = "Select a file to preview.";

    modal.actionsElement.querySelectorAll("button[data-role='preview']").forEach((button) => {
        button.onclick = async () => {
            const file = availableFiles[Number(button.dataset.index)];
            modal.previewTitleElement.textContent = `${file.label} Preview`;
            modal.previewElement.textContent = "Loading preview...";
            try {
                modal.previewElement.textContent = await getFilePreviewText(file.path);
            } catch (error) {
                console.error(error);
                modal.previewElement.textContent = error.message || "Unable to load preview.";
            }
        };
    });

    modal.actionsElement.querySelectorAll("button[data-role='download']").forEach((button) => {
        button.onclick = async () => {
            const file = availableFiles[Number(button.dataset.index)];
            try {
                await downloadStorageFile(file.path, getFileNameFromPath(file.path));
            } catch (error) {
                console.error(error);
                alert(error.message || "Unable to download the selected file.");
            }
        };
    });

    modal.modalInstance.show();
}