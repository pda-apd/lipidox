import "./auth-gate.js";
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import {
    collection, query, where, getDocs, orderBy,
    deleteDoc, doc, getDoc, updateDoc, serverTimestamp
} from "./firebase-config.js";
// BỔ SUNG: Import local storage
import { getStorage, ref, listAll, deleteObject } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { vpsUrl } from "./auth-gate.js";

const storage = getStorage();
let selectedProjects = new Set();
let allProjects = [];
let allProjectsData = [];  // raw data for client-side filter/sort
let deleteModal;
let renameModal;
let renameTargetId = null;

// Project names and account email are user-supplied: never render them as markup.
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

initializeTerminalWidget();

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (document.getElementById("author-menu-drd")) {
            initPage(user.uid);
        } else {
            window.addEventListener('headerLoaded', () => initPage(user.uid));
        }
    }
});

async function initPage(uid) {
    const createBtn = document.getElementById("btn-create-new");
    if (createBtn) createBtn.href = `./upload.html?uid=${uid}`;

    const exampleBtn = document.getElementById("btn-example-data");
    if (exampleBtn) exampleBtn.href = `./example.html?uid=${uid}`;

    const idcBtn = document.getElementById("btn-idconvert");
    if (idcBtn) idcBtn.href = `./idconvert.html?uid=${uid}`;

    deleteModal = new bootstrap.Modal(document.getElementById("deleteModal"));
    renameModal = new bootstrap.Modal(document.getElementById("renameModal"));
    renderUserMenu();
    // Note: Example project cleanup is disabled in v2 — example projects persist
    // so users can revisit them. Previous version cleaned them up each session.
    await fetchUserProjects(uid);
    setupActions(uid);
}

function renderUserMenu() {
    const menu = document.getElementById("author-menu-drd");
    const user = auth.currentUser;
    if (!user || !menu) return;

    menu.innerHTML = `
        <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${escapeHtml(user.email)}</li>
        <li><button id="logout-btn" class="dropdown-item text-danger py-2">
            <i class="fa-solid fa-right-from-bracket me-2"></i> Sign Out
        </button></li>
    `;

    document.getElementById("logout-btn").onclick = async () => {
        await signOut(auth);
        localStorage.removeItem("userSession");
        window.location.href = "./index.html";
    };
}

async function fetchUserProjects(uid) {
    const container = document.getElementById("project-list-container");
    container.innerHTML = "";
    selectedProjects.clear();
    allProjects = [];
    allProjectsData = [];

    try {
        const q = query(
            collection(db, "projects"),
            where("uid", "==", uid),
            orderBy("createdAt", "desc")
        );

        const snapshot = await getDocs(q);
        if (snapshot.empty) {
            container.innerHTML = `<div class="col-12 text-center py-5"><p class="text-muted">No projects found.</p></div>`;
            return;
        }

        snapshot.forEach(docSnap => {
            allProjects.push(docSnap.id);
            allProjectsData.push({ id: docSnap.id, data: docSnap.data() });
        });

        renderProjectCards(uid);
        setupSearchSort(uid);
    } catch (err) {
        console.error(err);
        container.innerHTML = `<p class="text-danger text-center">Failed to load projects.</p>`;
    }
}

function setupSearchSort(uid) {
    const searchEl = document.getElementById("project-search");
    const sortEl = document.getElementById("project-sort");
    if (!searchEl || !sortEl) return;
    // prevent double-binding on re-renders
    if (searchEl.dataset.bound) return;
    searchEl.dataset.bound = "1";
    sortEl.dataset.bound = "1";
    searchEl.addEventListener("input", () => renderProjectCards(uid));
    sortEl.addEventListener("change", () => renderProjectCards(uid));
}

function getFilteredSorted() {
    const q = (document.getElementById("project-search")?.value || "").toLowerCase();
    const sort = document.getElementById("project-sort")?.value || "lastAccessed";

    let list = allProjectsData.filter(({ data }) =>
        !q || (data.projectName || "").toLowerCase().includes(q)
    );

    list.sort((a, b) => {
        const da = a.data, db2 = b.data;
        switch (sort) {
            case "lastAccessed": {
                const ta = da.lastAccessedAt?.toMillis?.() ?? da.createdAt?.toMillis?.() ?? 0;
                const tb = db2.lastAccessedAt?.toMillis?.() ?? db2.createdAt?.toMillis?.() ?? 0;
                return tb - ta;
            }
            case "createdDesc": {
                const ta = da.createdAt?.toMillis?.() ?? 0;
                const tb = db2.createdAt?.toMillis?.() ?? 0;
                return tb - ta;
            }
            case "createdAsc": {
                const ta = da.createdAt?.toMillis?.() ?? 0;
                const tb = db2.createdAt?.toMillis?.() ?? 0;
                return ta - tb;
            }
            case "nameAZ":
                return (da.projectName || "").localeCompare(db2.projectName || "");
            case "nameZA":
                return (db2.projectName || "").localeCompare(da.projectName || "");
            default:
                return 0;
        }
    });
    return list;
}

function renderProjectCards(uid) {
    const container = document.getElementById("project-list-container");
    container.innerHTML = "";
    selectedProjects.clear();

    const list = getFilteredSorted();

    if (list.length === 0) {
        container.innerHTML = `<div class="col-12 text-center py-5"><p class="text-muted">No matching projects.</p></div>`;
        return;
    }

    list.forEach(({ id, data }) => {
        const uploadDate = data.createdAt ? data.createdAt.toDate().toLocaleDateString("vi-VN") : "---";
        const accessDate = data.lastAccessedAt
            ? data.lastAccessedAt.toDate().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
            : null;

        const statusConfig = getStatusUI(data, id, uid);
        const isActionDisabled = statusConfig.link === "#" && statusConfig.action !== "resume-processing";

        const el = document.createElement("div");
        el.className = "col-md-6 col-lg-4 mb-4";
        el.innerHTML = `
            <div class="card project-card h-100" data-id="${id}">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-3">
                        <div class="form-check">
                            <input class="form-check-input project-checkbox" type="checkbox" value="${id}">
                        </div>
                        <span class="badge ${statusConfig.class} status-badge">${statusConfig.label}</span>
                    </div>
                    <div class="d-flex align-items-center gap-2 mb-1">
                        <h5 class="fw-bold text-truncate mb-0 flex-grow-1">${escapeHtml(data.projectName)}</h5>
                        <button class="btn btn-link btn-sm p-0 text-muted rename-btn" data-id="${escapeHtml(id)}" data-name="${escapeHtml(data.projectName)}" title="Rename">
                            <i class="fa-solid fa-pen fa-xs"></i>
                        </button>
                    </div>
                    <p class="extra-small text-muted mb-1">
                        <i class="fa-regular fa-calendar-check me-1"></i> Uploaded: ${uploadDate}
                    </p>
                    ${accessDate ? `<p class="extra-small text-muted mb-3">
                        <i class="fa-regular fa-clock me-1"></i> Last accessed: ${accessDate}
                    </p>` : `<p class="extra-small text-muted mb-3"></p>`}
                    <div class="d-grid">
                        <a href="${statusConfig.link}"
                           class="btn btn-outline-primary btn-sm fw-bold ${isActionDisabled ? "disabled" : ""}"
                           data-project-action="${statusConfig.action || "open"}"
                           data-project-id="${id}">
                            ${statusConfig.btnText} <i class="fa-solid fa-arrow-right-long ms-1"></i>
                        </a>
                    </div>
                </div>
            </div>`;
        container.appendChild(el);
    });
    bindCheckbox();
    bindProjectActions(uid);
    bindRenameButtons();
    bindOpenProjectLinks(uid);
}

function hasNormalizedOutput(projectData) {
    return Boolean(
        projectData?.matrixNormPath ||
        projectData?.normality_stat ||
        projectData?.norm_settings ||
        projectData?.status === 'norm_ready'
    );
}

function getStatusUI(projectData, projectId, uid) {
    const status = projectData?.status;
    const params = `id=${projectId}&uid=${uid}`;

    if (hasNormalizedOutput(projectData)) {
        return {
            class: "bg-success text-white",
            label: "Ready",
            link: `./pca.html?${params}`,
            btnText: "Access"
        };
    }

    switch (status) {
        case "integrity_success": 
            return { class: "bg-info text-dark", label: "Integrity OK", link: `./dataintegritycheck.html?${params}`, btnText: "Review Data" };

        case "meta_check_ready": 
            return { class: "bg-primary text-white", label: "Metadata Ready", link: `./dataintegritycheck.html?${params}`, btnText: "Review Data" };

        case "integrity_error":
        case "error":
            return { class: "bg-danger text-white", label: "Error", link: `./upload.html?${params}`, btnText: "Upload Again" };

        case "matrix_check_ready": 
            return { class: "bg-grey text-white", label: "Filtered", link: `./normalize.html?${params}`, btnText: "Normalize" };
        
        // ĐÃ CHẠY XONG PHÂN TÍCH: Dẫn thẳng vào xem kết quả
        case "anova_success":
        case "univariate_success":
        case "norm_ready":
            return { class: "bg-success text-white", label: "Ready", link: `./pca.html?${params}`, btnText: "Access" };

        case "pending":
        case "processing_integrity":
        case "processing_preprocessing":
            return {
                class: "bg-secondary text-white",
                label: "Waiting for server",
                link: "#",
                btnText: "Continue Check",
                action: "resume-processing"
            };

        // TRẠNG THÁI CHỜ: Hiện đang xử lý
        default: 
            return { 
                class: "bg-secondary text-white", 
                label: "Processing", 
                link: "#",
                btnText: "Continue Check",
                action: "resume-processing"
            };
    }
}

function bindOpenProjectLinks(uid) {
    // Intercept open/access links, stamp lastAccessedAt, then navigate
    document.querySelectorAll('[data-project-action="open"]').forEach(link => {
        link.addEventListener("click", async (e) => {
            if (link.classList.contains("disabled")) return;
            const id = link.dataset.projectId;
            const dest = link.getAttribute("href");
            if (!id || !dest || dest === "#") return;
            e.preventDefault();
            try {
                await updateDoc(doc(db, "projects", id), { lastAccessedAt: serverTimestamp() });
            } catch (_) {}
            window.location.href = dest;
        });
    });
}

function bindRenameButtons() {
    document.querySelectorAll(".rename-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            renameTargetId = btn.dataset.id;
            const input = document.getElementById("rename-input");
            input.value = btn.dataset.name;
            renameModal.show();
            setTimeout(() => { input.select(); }, 300);
            input.onkeydown = (ev) => { if (ev.key === "Enter") confirmRenameBtn.click(); };
            const confirmRenameBtn = document.getElementById("confirm-rename-btn");
        });
    });
}

function bindProjectActions(uid) {
    document.querySelectorAll('[data-project-action="resume-processing"]').forEach((button) => {
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            await resumeProjectProcessing(uid, button.dataset.projectId, button);
        });
    });
}

async function resumeProjectProcessing(uid, projectId, button) {
    if (!projectId) return;

    const originalContent = button.innerHTML;
    button.classList.add('disabled');
    button.setAttribute('aria-disabled', 'true');
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Checking...';

    try {
        const projectRef = doc(db, 'projects', projectId);
        const projectSnap = await getDoc(projectRef);

        if (!projectSnap.exists()) {
            throw new Error('Project ID not found.');
        }

        const projectData = projectSnap.data();
        const payload = buildResumeValidationPayload(projectId, uid, projectData);

        const response = await fetch(`${vpsUrl}/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorPayload = await readErrorPayload(response);
            const message = errorPayload || 'Unable to continue backend processing.';

            await updateDoc(projectRef, {
                status: 'integrity_error',
                message,
                details: [message],
            });

            throw new Error(message);
        }

        window.location.href = `./dataintegritycheck.html?id=${projectId}&uid=${uid}`;
    } catch (error) {
        console.error(error);
        alert(error.message || 'Unable to continue this project.');
        button.classList.remove('disabled');
        button.removeAttribute('aria-disabled');
        button.innerHTML = originalContent;
        await fetchUserProjects(uid);
    }
}

function buildResumeValidationPayload(projectId, uid, projectData) {
    const uploadMode = projectData.uploadMode || 'standard_upload';
    const metaPath = projectData.metaPath;

    if (!metaPath) {
        throw new Error('Metadata path is missing for this project.');
    }

    if (uploadMode === 'preprocess_portal') {
        if (!projectData.matrixRawPath || !projectData.nistPath || !projectData.isPath) {
            throw new Error('Project files are incomplete for preprocessing.');
        }

        return {
            project_id: projectId,
            uid,
            upload_mode: uploadMode,
            matrix_path: null,
            matrix_raw_path: projectData.matrixRawPath,
            nist_path: projectData.nistPath,
            is_path: projectData.isPath,
            meta_path: metaPath,
        };
    }

    if (!projectData.matrixPath) {
        throw new Error('Matrix path is missing for this project.');
    }

    return {
        project_id: projectId,
        uid,
        upload_mode: uploadMode,
        matrix_path: projectData.matrixPath,
        matrix_raw_path: null,
        nist_path: null,
        is_path: null,
        meta_path: metaPath,
    };
}

async function readErrorPayload(response) {
    try {
        const payload = await response.json();

        if (typeof payload?.detail === 'string') {
            return payload.detail;
        }
        if (Array.isArray(payload?.detail)) {
            return payload.detail.map((item) => item.msg || JSON.stringify(item)).join('; ');
        }
        if (typeof payload?.message === 'string') {
            return payload.message;
        }
    } catch (error) {
        console.warn('Unable to parse backend error payload.', error);
    }

    return null;
}

function bindCheckbox() {
    document.querySelectorAll(".project-checkbox").forEach(cb => {
        cb.addEventListener("change", e => {
            const id = e.target.value;
            const card = e.target.closest(".project-card");
            if (e.target.checked) { selectedProjects.add(id); card.classList.add("selected"); }
            else { selectedProjects.delete(id); card.classList.remove("selected"); }
        });
    });
}

function setupActions(uid) {
    const selectAllBtn = document.getElementById("select-all-btn");
    if (selectAllBtn) {
        selectAllBtn.onclick = () => {
            const checkboxes = document.querySelectorAll(".project-checkbox");
            const visibleCheckboxes = document.querySelectorAll(".project-checkbox");
            const allSelected = visibleCheckboxes.length > 0 && selectedProjects.size === visibleCheckboxes.length;
            checkboxes.forEach(cb => {
                cb.checked = !allSelected;
                cb.dispatchEvent(new Event("change"));
            });
        };
    }

    const deleteBtn = document.getElementById("delete-selected-btn");
    if (deleteBtn) {
        deleteBtn.onclick = () => {
            if (selectedProjects.size === 0) return alert("Please select at least one project.");
            document.getElementById("delete-count").innerText = selectedProjects.size;
            deleteModal.show();
        };
    }

    const confirmRenameBtn = document.getElementById("confirm-rename-btn");
    if (confirmRenameBtn) {
        confirmRenameBtn.onclick = async () => {
            const newName = document.getElementById("rename-input").value.trim();
            if (!newName) return;
            confirmRenameBtn.disabled = true;
            confirmRenameBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Saving...`;
            try {
                await updateDoc(doc(db, "projects", renameTargetId), { projectName: newName });
                renameModal.hide();
                await fetchUserProjects(uid);
            } catch (err) {
                console.error(err);
                alert("Failed to rename project.");
            } finally {
                confirmRenameBtn.disabled = false;
                confirmRenameBtn.innerHTML = "Save";
            }
        };
    }

    const confirmDeleteBtn = document.getElementById("confirm-delete-btn");
    if (confirmDeleteBtn) {
        confirmDeleteBtn.onclick = async () => {
            confirmDeleteBtn.disabled = true;
            confirmDeleteBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Deleting data...`;
            
            try {
                for (const id of selectedProjects) {
                    // DELETE /projects/{id} removes both the DB record and all
                    // associated storage files on the backend.
                    await deleteDoc(doc(db, "projects", id));
                }
                
                deleteModal.hide();
                await fetchUserProjects(uid);
                alert("The project and its related files were deleted successfully.");
            } catch (err) {
                console.error(err);
                alert("Failed to delete project data.");
            } finally {
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.innerText = "Delete Now";
            }
        };
    }
}

function initializeTerminalWidget() {
    const host = document.getElementById('shared-terminal-host');
    if (!host || host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';
    mountTerminalWidget({
        host,
        logUrl: `${vpsUrl}/log-stream`,
        variant: 'floating-left'
    }).catch((error) => {
        console.error('Failed to mount terminal widget.', error);
        delete host.dataset.mounted;
    });
}

async function cleanupExampleProjects(uid) {
    if (!uid) return;
    try {
        const q = query(
            collection(db, "projects"),
            where("uid", "==", uid),
            where("is_example", "==", true)
        );
        const snap = await getDocs(q);
        if (snap.empty) return;
        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            // Client-side filter: the REST backend returns all user projects
            // (not filtered by is_example), so we must check here.
            if (!data || !(data.is_example === true || data.extra?.is_example === true)) continue;
            const projectId = docSnap.id;
            // Storage cleanup is handled by DELETE /projects/{id} on the backend.
            await deleteDoc(doc(db, "projects", projectId));
        }
    } catch (err) {
        console.warn("[cleanupExampleProjects] Non-fatal error:", err.message);
    }
}