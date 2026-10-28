import "./auth-gate.js";
import { db, auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import {
    collection, addDoc, serverTimestamp, onSnapshot, doc, query, where, getDocs, deleteDoc
} from "./firebase-config.js";
import { getStorage, ref, listAll, deleteObject } from "./firebase-config.js";
import { vpsUrl } from "./auth-gate.js";

const storage = getStorage();

const DATASETS = {
    normal_vs_chb: {
        projectName: "example_normal_vs_chb",
        matrixPath: "Example/Normal_vs_CHB/matrix.csv",
        metaPath:   "Example/Normal_vs_CHB/meta.csv",
    },
    gse136434: {
        projectName: "example_gse136434",
        matrixPath: "Example/gse136434/matrix_GSE136434.csv",
        metaPath:   "Example/gse136434/metadata_GSE136434.csv",
    },
    gse308711: {
        projectName: "example_gse308711",
        matrixPath: "Example/gse308711/matrix_GSE308711.csv",
        metaPath:   "Example/gse308711/metadata_GSE308711.csv",
    },
    olink_cardiometabolic: {
        projectName: "example_olink_cardiometabolic",
        matrixPath: "Example/Olink_Cardiometabolic/matrix.csv",
        metaPath:   "Example/Olink_Cardiometabolic/metadata.csv",
    },
};

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    renderUserMenu(user);
    document.getElementById("btn-load-normal_vs_chb").onclick = () => loadExample("normal_vs_chb", user);
    document.getElementById("btn-load-gse136434").onclick = () => loadExample("gse136434", user);
    document.getElementById("btn-load-gse308711").onclick = () => loadExample("gse308711", user);
    document.getElementById("btn-load-olink_cardiometabolic").onclick = () => loadExample("olink_cardiometabolic", user);
});

function renderUserMenu(user) {
    const tryRender = () => {
        const menu = document.getElementById("author-menu-drd");
        if (!menu) return;
        menu.innerHTML = `
            <li class="px-3 py-2 small fw-bold text-primary border-bottom mb-1">${user.email}</li>
            <li><button id="logout-btn" class="dropdown-item text-danger py-2">
                <i class="fa-solid fa-right-from-bracket me-2"></i> Sign Out
            </button></li>
        `;
        document.getElementById("logout-btn").onclick = async () => {
            await signOut(auth);
            localStorage.removeItem("userSession");
            window.location.href = "./index.html";
        };
    };
    if (document.getElementById("author-menu-drd")) tryRender();
    else window.addEventListener("headerLoaded", tryRender);
}

async function loadExample(datasetKey, user) {
    const dataset = DATASETS[datasetKey];
    if (!dataset) return;

    const btn = document.getElementById(`btn-load-${datasetKey}`);
    const statusEl = document.getElementById(`status-${datasetKey}`);

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Creating project…`;
    setStatus(statusEl, "info", "Creating project…");

    try {
        // Create project
        const projectRef = await addDoc(collection(db, "projects"), {
            uid: user.uid,
            projectName: dataset.projectName,
            is_example: true,
            status: "pending",
            uploadMode: "standard_upload",
            matrixPath: dataset.matrixPath,
            matrixRawPath: "",
            matrixPreprocessedPath: "",
            metaPath: dataset.metaPath,
            nistPath: "",
            isPath: "",
            createdAt: serverTimestamp(),
        });
        const projectId = projectRef.id;

        setStatus(statusEl, "info", "Triggering validation…");
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Validating…`;

        // Trigger backend validation
        const response = await fetch(`${vpsUrl}/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: user.uid,
                upload_mode: "standard_upload",
                matrix_path: dataset.matrixPath,
                matrix_raw_path: null,
                nist_path: null,
                is_path: null,
                meta_path: dataset.metaPath,
            }),
        });

        if (!response.ok) {
            let detail = "Validation request failed.";
            try { const j = await response.json(); detail = j.detail || j.message || detail; } catch (_) {}
            throw new Error(detail);
        }

        setStatus(statusEl, "info", "Waiting for integrity check…");

        // Watch for completion
        const unsub = onSnapshot(doc(db, "projects", projectId), (snap) => {
            const data = snap.data();
            if (!data) return;

            if (data.status === "integrity_success" || data.status === "meta_check_ready") {
                unsub();
                setStatus(statusEl, "success", "Ready! Redirecting…");
                setTimeout(() => {
                    window.location.href = `dataintegritycheck.html?id=${projectId}&uid=${user.uid}`;
                }, 800);
            } else if (data.status === "integrity_error" || data.status === "error") {
                unsub();
                const msg = data.message || "Integrity check failed.";
                setStatus(statusEl, "danger", msg);
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-bolt me-2"></i>Load Example`;
            }
        });

    } catch (err) {
        console.error(err);
        setStatus(statusEl, "danger", err.message || "Unexpected error.");
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-bolt me-2"></i>Load Example`;
    }
}

function setStatus(el, type, message) {
    if (!el) return;
    const colorMap = { info: "text-primary", success: "text-success", danger: "text-danger" };
    el.className = `status-area small ${colorMap[type] || "text-muted"}`;
    el.innerHTML = message;
}
