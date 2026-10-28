import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { downloadStorageFile, getFinalDownloadArtifacts, getProjectData } from "./project-files.js";

export const vpsUrl = window.location.origin.startsWith("http://localhost:5")
    ? "http://localhost:8000"
    : window.location.origin; // Same origin when served from backend or tunnel
export const DEFAULT_LOG_URL = `${vpsUrl}/log-stream`;
export const RUN_SUBMIT_COOLDOWN_MS = 3000;
export const TASK_STALE_TIMEOUT_MS = 180 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT_PATHS — Registry tập trung tất cả các field paths
// Khi cần đổi tên field, chỉ cần sửa tại đây.
//
// Các file phân tích import và dùng: import { PROJECT_PATHS } from "./auth-gate.js"
// rồi thay projectData?.matrixNormPath → projectData?.[PROJECT_PATHS.matrixNorm]
// ─────────────────────────────────────────────────────────────────────────────
export const PROJECT_PATHS = {

    // ── MATRIX PATHS (theo thứ tự pipeline) ──────────────────────────────────

    /** Matrix gốc sau khi upload (chưa qua bước nào).
     *  Dùng trong: upload.js, projectID.js, matrixcheck.js, feature-in.js */
    matrixRaw: "matrixRawPath",

    /** Matrix sau upload mode Preprocess (NIST/IS normalization).
     *  Dùng trong: projectID.js, matrixcheck.js, project-files.js */
    matrixPreprocessed: "matrixPreprocessedPath",

    /** Matrix sau bước Matrix Integrity Check (dataintegritycheck).
     *  Dùng trong: normalize.js, feature-in.js, project-files.js */
    matrixChecked: "matrixCheckedPath",

    /** Matrix sau bước Normalize — đầu vào chính cho hầu hết phân tích.
     *  Dùng trong: pca.js, kmeans.js, heatmap.js, heatmapexpression.js,
     *              random-forest.js, biomarker.js, t-test.js, som.js,
     *              vip-score.js, project-files.js */
    matrixNorm: "matrixNormPath",

    /** Matrix trước bước standardization (scale) — dùng để hiển thị đơn vị gốc.
     *  Dùng trong: pca.js, plsda.js, oplsda.js, anova.js, heatmap.js, biomarker.js */
    matrixPreScale: "matrixPreScalePath",

    /** Matrix upload thông thường (standard mode, trước integrity check).
     *  Dùng trong: projectID.js, matrixcheck.js, project-files.js */
    matrix: "matrixPath",

    // ── METADATA PATHS ────────────────────────────────────────────────────────

    /** Metadata gốc sau khi upload.
     *  Dùng trong: upload.js, projectID.js, metacheck.js, dataintegritycheck.js,
     *              project-files.js, example.js */
    meta: "metaPath",

    /** Metadata sau bước Metadata Integrity Check — đầu vào chính cho phân tích.
     *  Dùng trong: pca.js, plsda.js, oplsda.js, kmeans.js, som.js, anova.js,
     *              t-test.js, heatmap.js, heatmapexpression.js, random-forest.js,
     *              biomarker.js, normalize.js, vip-score.js, project-files.js */
    metaChecked: "metaCheckedPath",

    // ── PREPROCESSING PATHS (chỉ dùng cho upload mode preprocessing) ─────────

    /** File NIST reference (preprocessing pipeline).
     *  Dùng trong: projectID.js */
    nist: "nistPath",

    /** File Internal Standard (preprocessing pipeline).
     *  Dùng trong: projectID.js */
    internalStandard: "isPath",

};

let sidebarObserverStarted = false;

function getProjectIdFromUrl() {
    return new URLSearchParams(window.location.search).get("id");
}

function bindSidebarDownload(buttonId, artifactKey) {
    const button = document.getElementById(buttonId);
    if (!button || button.dataset.bound === "true") return;

    button.dataset.bound = "true";
    button.addEventListener("click", async (event) => {
        event.preventDefault();

        const projectId = getProjectIdFromUrl();
        if (!projectId) {
            alert("Project information is missing.");
            return;
        }

        try {
            const projectData = await getProjectData(projectId);
            const artifact = getFinalDownloadArtifacts(projectData || {})[artifactKey];
            if (!artifact?.path) {
                throw new Error(`${artifact?.label || "The requested file"} is not available yet.`);
            }
            await downloadStorageFile(artifact.path);
        } catch (error) {
            console.error(error);
            alert(error.message || "Unable to download the requested file.");
        }
    });
}

function startSidebarDownloadObserver() {
    if (sidebarObserverStarted) return;
    sidebarObserverStarted = true;

    const bindWhenReady = () => {
        bindSidebarDownload("analysis-download-matrix", "matrix");
        bindSidebarDownload("analysis-download-meta", "metadata");
    };

    bindWhenReady();

    const observer = new MutationObserver(() => {
        bindWhenReady();
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

function blockDeveloperTools() {
    window.addEventListener("keydown", (event) => {
        if (event.key === "F12" || event.keyCode === 123) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    });
}

// DevTools blocked in production; disabled for local development/testing.
// Re-enable by calling blockDeveloperTools() again if needed.
// blockDeveloperTools();

onAuthStateChanged(auth, (user) => {
    if (user) {
        // QUAN TRỌNG: Cho hiện trang web ngay khi xác thực thành công
        document.body.style.display = "block";
        console.log("Auth-gate: User OK, showing body.");
        startSidebarDownloadObserver();
    } else {
        const currentPage = window.location.pathname.split("/").pop();
        const publicPages = ["login.html", "register.html", "index.html"];
        
        if (!publicPages.includes(currentPage) && currentPage !== "") {
            window.location.href = "./login.html";
        } else {
            // Nếu là trang chủ, vẫn phải hiện body
            document.body.style.display = "block";
        }
    }
});