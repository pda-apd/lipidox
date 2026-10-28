import "./auth-gate.js";
import { auth, db, storage } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { doc, getDoc, onSnapshot, updateDoc } from "./firebase-config.js";
import { ref, getDownloadURL, uploadString } from "./firebase-config.js";
import { vpsUrl, RUN_SUBMIT_COOLDOWN_MS, TASK_STALE_TIMEOUT_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get("id");
const DEFAULT_PLOT_MESSAGE = "Run a VIP analysis or select a run from history to render the S-Plot.";
const DEFAULT_STATUS_MESSAGE = "Select a run and pair, then click RUN. Or load one from History.";

// ---------------------------------------------------------------------------
// Plot visual config (synced with the gear-button settings panel)
// ---------------------------------------------------------------------------
const plotConfig = { ...PLOT_CONFIG_DEFAULTS };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const vipLabelPositions = new Map(); // feature → { ax, ay } in data coords — persists dragged label positions

const state = {
    projectData: null,
    plsRuns: [],          // normalized PLS-DA / OPLS-DA run records
    vipHistory: [],       // vip_combined_history from database
    selectedHistoryId: null,
    selectedSourceRun: null,
    tableRows: [],
    selectedFeatures: new Set(),
    sortBy: "vip_desc",
    minVip: 1,
    maxFdr: 0.05,
    searchText: "",
    loadRequestId: 0,
    _currentRun: null,    // run used for the active S-plot
    _currentPair: null,
    _csvUrl: null,
    _activeName: "",
    _forceAutoscaleSPlotOnce: false,
    _loadingToken: 0,
    _runInProgress: false,
    _runConfigLoading: false,
    _runQueued: false,
    _runCooldownUntil: 0,
    _runCooldownTimer: null,
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const dom = {
    sidebarPlaceholder: document.getElementById("sidebar-placeholder"),
    historyToggle: document.getElementById("history-toggle"),
    historyPopup: document.getElementById("history-popup"),
    vipAnalysisName: document.getElementById("vip-analysis-name"),
    sourceType: document.getElementById("vip-source-type"),
    runSelect: document.getElementById("vip-run-select"),
    runMeta: document.getElementById("vip-run-meta"),
    pairList: document.getElementById("vip-pair-list"),
    log2fcThreshold: document.getElementById("vip-log2fc-threshold"),
    runBtn: document.getElementById("btn-run-vip"),
    runStatus: document.getElementById("vip-run-status"),
    tableSort: document.getElementById("table-sort"),
    vipThreshold: document.getElementById("vip-threshold"),
    fdrThreshold: document.getElementById("fdr-threshold"),
    tableSearch: document.getElementById("table-search"),
    tableBody: document.querySelector("#vip-table tbody"),
    rowCount: document.getElementById("row-count"),
    csvBtn: document.getElementById("btn-dl-csv"),
    splotWrap: document.getElementById("splotWrap"),
    plotEmpty: document.getElementById("plot-empty"),
    plotSubtitle: document.getElementById("plot-subtitle"),
    splotConfigAnchor: document.getElementById("splot-config-anchor"),
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function toSafeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function fmtNum(value, digits = 4) {
    const num = toSafeNumber(value);
    return num === null ? "-" : num.toFixed(digits);
}

function sanitizeText(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function normalizeVipStatus(status) {
    const value = String(status || "done").toLowerCase();
    if (value === "pending") return "pending";
    if (value === "running" || value === "processing") return "running";
    if (value === "error") return "error";
    return "done";
}

function formatTaskId(item) {
    if (item?.task_id == null || item?.task_id === "") return "";
    return `ID ${item.task_id}`;
}

function getTaskStatusBadge(status) {
    if (status === "running") return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === "pending") return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === "error") return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

function normalizeVipHistoryEntry(entry) {
    return {
        ...entry,
        status: normalizeVipStatus(entry?.status),
    };
}

function dedupeVipHistory(entries) {
    const seen = new Set();
    return (entries || []).map(normalizeVipHistoryEntry).filter((entry) => {
        const key = entry?.run_id;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildTaskFallbackEntry(task) {
    if (!task?.run_id) return null;
    return normalizeVipHistoryEntry({
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        name: task.name || "Untitled",
        date: task.completed_at || task.started_at || new Date().toISOString(),
        target_meta: task.target_meta || null,
        comparison: task.comparison || null,
        method_src: task.method_src || null,
        run_id_src: task.run_id_src || null,
        source_run_name: task.source_run_name || null,
        results_url: task.results_url || null,
        csv_url: task.csv_url || null,
        status: task.status,
        message: task.message || "",
    });
}

function dedupeRuns(runs) {
    const seen = new Set();
    return runs.filter((run) => {
        const key = `${run.method}::${run.run_id}`;
        if (!run.run_id || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeRunRecord(record, method) {
    return {
        run_id: record.run_id,
        method,
        type: record.type || method,
        name: record.name || `${method}_${record.run_id || "run"}`,
        config: record.config || {},
        data: record.data || {},
        data_path: record.data_path || null,
        date: record.date || new Date().toISOString(),
    };
}

function getAllRunsFromProjectData(projectData) {
    const pls = (projectData.plsda_history || []).map((r) => normalizeRunRecord(r, "PLS-DA"));
    const opls = (projectData.oplsda_history || []).map((r) => normalizeRunRecord(r, "OPLS-DA"));
    return dedupeRuns([...pls, ...opls]).sort((a, b) =>
        new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );
}

function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function setRunBtnBusy(isBusy) {
    if (!dom.runBtn) return;
    dom.runBtn.disabled = Boolean(isBusy);
    dom.runBtn.innerHTML = isBusy
        ? '<i class="fa-solid fa-sync fa-spin me-1"></i>Running...'
        : '<i class="fa-solid fa-play me-1"></i>RUN VIP ANALYSIS';
}

function isRunCoolingDown() {
    return state._runCooldownUntil > Date.now();
}

function getRunCooldownSecondsRemaining() {
    return Math.max(1, Math.ceil((state._runCooldownUntil - Date.now()) / 1000));
}

function refreshRunBtnCooldownUi() {
    if (!dom.runBtn) return;
    if (isRunCoolingDown()) {
        dom.runBtn.disabled = true;
        dom.runBtn.innerHTML = `<i class="fa-solid fa-hourglass-half me-1"></i>Wait ${getRunCooldownSecondsRemaining()}s`;
        return;
    }
    state._runCooldownUntil = 0;
    validateRunBtn();
}

function startRunCooldown(durationMs = RUN_SUBMIT_COOLDOWN_MS) {
    state._runCooldownUntil = Date.now() + durationMs;
    if (state._runCooldownTimer) {
        window.clearInterval(state._runCooldownTimer);
    }
    refreshRunBtnCooldownUi();
    state._runCooldownTimer = window.setInterval(() => {
        if (!isRunCoolingDown()) {
            window.clearInterval(state._runCooldownTimer);
            state._runCooldownTimer = null;
            refreshRunBtnCooldownUi();
            return;
        }
        refreshRunBtnCooldownUi();
    }, 200);
}

function stopRunCooldown() {
    state._runCooldownUntil = 0;
    if (state._runCooldownTimer) {
        window.clearInterval(state._runCooldownTimer);
        state._runCooldownTimer = null;
    }
    validateRunBtn();
}

function tryAutoRunIfQueued() {
    if (!state._runQueued) return;
    if (state._runInProgress || state._runConfigLoading) return;
    const run = state.selectedSourceRun;
    const pair = getSelectedPair();
    if (!(run && pair)) return;
    state._runQueued = false;
    runVipAnalysis();
}

function setResultsLoading(message = "Loading...") {
    state.tableRows = [];
    state.selectedFeatures.clear();
    if (dom.rowCount) dom.rowCount.textContent = "0 rows";
    if (dom.csvBtn) dom.csvBtn.disabled = true;
    if (dom.tableBody) {
        dom.tableBody.innerHTML = `<tr><td colspan="5" class="text-muted py-3">${sanitizeText(message)}</td></tr>`;
    }
    clearPlot(message);
    if (dom.plotSubtitle) dom.plotSubtitle.textContent = message;
}

async function fetchJsonFromStorage(url) {
    if (!url) throw new Error("Missing results URL.");
    const cacheBustedUrl = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
    const response = await fetch(cacheBustedUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function deleteStorageArtifacts(urls) {
    const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
    if (!uniqueUrls.length) return;
    try {
        await fetch(`${vpsUrl}/storage/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: uniqueUrls }),
        });
    } catch (error) {
        console.error("Failed to delete storage artifacts:", error);
    }
}

function waitForVipTask(runId, timeoutMs = TASK_STALE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let unsub = null;
        const timeout = setTimeout(() => {
            if (typeof unsub === "function") unsub();
            reject(new Error("Timed out after 180 minutes while waiting for VIP results."));
        }, timeoutMs);

        unsub = onSnapshot(
            doc(db, "projects", projectId),
            (snap) => {
                const d = snap.data() || {};
                const taskFallback = buildTaskFallbackEntry(d.vip_combined_task || null);
                const history = dedupeVipHistory([
                    ...(Array.isArray(d.vip_combined_history) ? d.vip_combined_history : []),
                    ...(taskFallback ? [taskFallback] : []),
                ]);
                const entry = history.find((item) => item.run_id === runId) || null;
                const task = d.vip_combined_task?.run_id === runId ? d.vip_combined_task : null;
                const status = normalizeVipStatus(entry?.status || task?.status);

                if (status === "error") {
                    clearTimeout(timeout);
                    if (typeof unsub === "function") unsub();
                    reject(new Error(entry?.message || task?.message || d.vip_combined_error || "VIP combined analysis failed."));
                    return;
                }
                if (status !== "done") return;
                clearTimeout(timeout);
                if (typeof unsub === "function") unsub();
                resolve(d);
            },
            (err) => {
                clearTimeout(timeout);
                if (typeof unsub === "function") unsub();
                reject(err);
            }
        );
    });
}

async function uploadHistoryResultsToStorage(entry) {
    if (entry?.results_url || !Array.isArray(entry?.results) || !entry.results.length) {
        const nextEntry = { ...entry };
        delete nextEntry.results;
        return nextEntry;
    }

    const runKey = entry.run_id || `legacy_${Date.now()}`;
    const userId = auth.currentUser?.uid || "anonymous";
    const path = `projects/${userId}/${projectId}/vip_combined/history_${runKey}.json`;
    const storageRef = ref(storage, path);
    await uploadString(storageRef, JSON.stringify(entry.results), "raw", { contentType: "application/json" });
    const resultsUrl = await getDownloadURL(storageRef);

    const nextEntry = { ...entry, results_url: resultsUrl };
    delete nextEntry.results;
    return nextEntry;
}

async function compactVipHistoryEntries(entries) {
    const compacted = [];
    for (const entry of (entries || [])) {
        compacted.push(await uploadHistoryResultsToStorage(entry));
    }
    return compacted;
}

function buildProjectStateFromHistory() {
    const latest = state.vipHistory[0] || null;
    return {
        vip_combined_history: state.vipHistory.length ? state.vipHistory : null,
        vip_combined_results_url: latest?.results_url || null,
        vip_combined_csv_url: latest?.csv_url || null,
        vip_combined_status: latest ? normalizeVipStatus(latest.status) : null,
        vip_combined_error: null,
        vip_combined_task: null,
    };
}

function haveRunListChanged(previousRuns, nextRuns) {
    if ((previousRuns || []).length !== (nextRuns || []).length) return true;
    return (nextRuns || []).some((run, index) => {
        const prev = previousRuns[index];
        return !prev
            || prev.run_id !== run.run_id
            || prev.method !== run.method
            || prev.name !== run.name
            || prev.date !== run.date;
    });
}

async function getRunConfigDetails(run) {
    const cfg = run?.config || {};
    let targetMeta = cfg.target_meta || run?.data?.target_meta || null;
    let pairwiseCmp = cfg.pairwise_comparison || run?.data?.pairwise_comparison || null;

    if (!targetMeta && run) {
        const ok = await ensureRunData(run);
        if (!ok) return { targetMeta: null, pairwiseCmp: null, ok: false };
        targetMeta = cfg.target_meta || run?.data?.target_meta || null;
        pairwiseCmp = cfg.pairwise_comparison || run?.data?.pairwise_comparison || null;
    }

    return { targetMeta, pairwiseCmp, ok: true };
}

// ---------------------------------------------------------------------------
// Sidebar injection
// ---------------------------------------------------------------------------
async function injectSidebar(userId) {
    const response = await fetch("./sidebar.html");
    const html = await response.text();
    dom.sidebarPlaceholder.innerHTML = html;
    dom.sidebarPlaceholder.querySelectorAll("script").forEach(old => { const s = document.createElement("script"); s.textContent = old.textContent; document.head.appendChild(s); });

    dom.sidebarPlaceholder.querySelectorAll("#analysis-nav a").forEach((anchor) => {
        const href = anchor.getAttribute("href");
        if (href && href !== "#") anchor.href = `${href}?id=${projectId}&uid=${userId}`;
    });

    const activeLink = dom.sidebarPlaceholder.querySelector('a[href^="vip-score.html"]');
    if (activeLink) {
        dom.sidebarPlaceholder.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
        activeLink.classList.add("active");
    }

    const exitBtn = document.getElementById("btn-back-projects");
    if (exitBtn) exitBtn.href = `projectID.html?uid=${encodeURIComponent(userId)}`;

    const terminalHost = document.getElementById("sidebar-terminal-slot");
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

// ---------------------------------------------------------------------------
// History popup (vip_combined_history)
// ---------------------------------------------------------------------------
function renderHistoryPopup() {
    const popup = dom.historyPopup;
    if (!popup) return;

    const history = state.vipHistory;
    if (!history.length) {
        popup.innerHTML = '<div class="history-meta p-2 text-center">No VIP runs yet.</div>';
        return;
    }

    popup.innerHTML = history.map((item) => {
        const status = normalizeVipStatus(item.status);
        return `
        <div class="history-item d-flex align-items-start gap-2 ${state.selectedHistoryId === item.run_id ? "active" : ""}"
             data-run-id="${escapeHtmlAttr(item.run_id || "")}"
             title="${escapeHtmlAttr([
                 `Name: ${item.name || "-"}`,
                 `Source: ${item.method_src || "-"} | Run: ${item.source_run_name || item.run_id_src || "-"}`,
                 `Target: ${item.target_meta || "-"}`,
                 `Pair: ${item.comparison || "-"}`,
                 `Date: ${item.date ? new Date(item.date).toLocaleString() : "-"}`
             ].join("\n"))}">
            <div class="history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">${sanitizeText(item.name || "Untitled")}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getTaskStatusBadge(status)}<span>${sanitizeText(formatTaskId(item) || 'No ID')}</span></div>
                <div class="history-meta">${sanitizeText(item.method_src || "-")} | ${sanitizeText(item.target_meta || "-")}</div>
                <div class="history-meta">${sanitizeText(item.comparison || "-")}</div>
                <div class="history-meta">${sanitizeText(item.message || (status === 'done' ? 'Ready to open.' : status === 'error' ? 'Run failed.' : status === 'pending' ? 'Queued for processing.' : 'Task is running...'))}</div>
                <div class="history-meta">${item.date ? new Date(item.date).toLocaleString() : "-"}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete" data-run-id="${escapeHtmlAttr(item.run_id || "")}" title="Delete" style="font-size:0.63rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `;
    }).join("");

    popup.querySelectorAll(".history-info").forEach((node) => {
        node.onclick = async () => {
            const runId = node.parentElement.dataset.runId;
            const entry = state.vipHistory.find((h) => h.run_id === runId);
            if (!entry) return;
            const status = normalizeVipStatus(entry.status);
            if (status === "pending" || status === "running") return;
            if (status === "error") {
                setRunStatus(entry.message || "VIP combined analysis failed.", true);
                return;
            }
            state.selectedHistoryId = runId;
            await loadHistoryEntry(entry);
            popup.classList.remove("open");
            renderHistoryPopup();
        };
    });

    popup.querySelectorAll(".history-delete").forEach((btn) => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            const entry = state.vipHistory.find((h) => h.run_id === runId);
            if (!entry || !confirm(`Delete "${entry.name || "this run"}"?`)) return;
            const status = normalizeVipStatus(entry.status);
            if (status === "pending" || status === "running") {
                setRunStatus("This task is still processing and cannot be deleted yet.", true);
                return;
            }
            await deleteStorageArtifacts([entry.results_url, entry.csv_url]);
            state.vipHistory = state.vipHistory.filter((h) => h.run_id !== runId);
            if (state.selectedHistoryId === runId) {
                state.selectedHistoryId = null;
                clearResults();
                setRunStatus(DEFAULT_STATUS_MESSAGE);
            }
            await updateDoc(doc(db, "projects", projectId), buildProjectStateFromHistory());
            renderHistoryPopup();
        };
    });
}

// ---------------------------------------------------------------------------
// User config: populate run select
// ---------------------------------------------------------------------------
function populateRunSelect() {
    const source = dom.sourceType?.value || "PLS-DA";
    const runs = state.plsRuns.filter((r) => r.method === source);
    const preservedRunId = dom.runSelect?.value || "";

    if (!dom.runSelect) return;
    dom.runSelect.innerHTML = '<option value="">-- Select a run --</option>' +
        runs.map((r) => `<option value="${r.run_id}">${sanitizeText(r.name)}</option>`).join("");

    if (preservedRunId && runs.some((r) => r.run_id === preservedRunId)) {
        dom.runSelect.value = preservedRunId;
        state.selectedSourceRun = runs.find((r) => r.run_id === preservedRunId) || null;
        return;
    }

    if (dom.runMeta) dom.runMeta.innerHTML = "";
    if (dom.pairList) dom.pairList.innerHTML = "";
    state.selectedSourceRun = null;
    if (dom.runBtn) dom.runBtn.disabled = true;
}

async function onRunSelectChange() {
    const runId = dom.runSelect?.value;
    if (!runId) {
        if (dom.runMeta) dom.runMeta.innerHTML = "";
        if (dom.pairList) dom.pairList.innerHTML = "";
        state.selectedSourceRun = null;
        state._runConfigLoading = false;
        if (dom.runBtn) dom.runBtn.disabled = true;
        return;
    }

    const source = dom.sourceType?.value || "PLS-DA";
    const run = state.plsRuns.find((r) => r.run_id === runId && r.method === source);
    if (!run) return;

    state.selectedSourceRun = run;
    state._runConfigLoading = true;
    if (dom.runMeta) dom.runMeta.textContent = "Loading run configuration...";
    const { targetMeta, pairwiseCmp, ok } = await getRunConfigDetails(run);
    state._runConfigLoading = false;
    if (!ok) {
        if (dom.runMeta) dom.runMeta.textContent = "Failed to load run configuration.";
        validateRunBtn();
        return;
    }

    if (dom.runMeta) {
        dom.runMeta.innerHTML = `<span class="text-muted extra-small">Target: <b>${sanitizeText(targetMeta || "-")}</b>${pairwiseCmp ? ` | Pairwise: <b>${sanitizeText(pairwiseCmp)}</b>` : ""}</span>`;
    }

    renderPairList(run);
    validateRunBtn();
    tryAutoRunIfQueued();
}

function renderPairList(run) {
    if (!dom.pairList) return;
    dom.pairList.innerHTML = "";

    const cfg = run.config || {};
    const targetMeta = cfg.target_meta || run.data?.target_meta || null;
    if (!targetMeta) {
        dom.pairList.innerHTML = '<div class="history-meta text-danger extra-small">Run has no target_meta info.</div>';
        return;
    }

    // If run was done with pairwise_comparison, only that pair is valid
    const pairwiseCmp = cfg.pairwise_comparison || run.data?.pairwise_comparison || null;
    if (pairwiseCmp) {
        dom.pairList.innerHTML = `<div class="form-check"><input class="form-check-input pair-check" type="radio" name="vip-pair" value="${escapeHtmlAttr(pairwiseCmp)}" id="pair-only" checked><label class="form-check-label extra-small" for="pair-only">${sanitizeText(pairwiseCmp)}</label></div>`;
        dom.pairList.querySelector(".pair-check").addEventListener("change", validateRunBtn);
        return;
    }

    // Derive pairs from project meta_metadata groups for that column
    const metaMeta = (state.projectData?.meta_metadata || []).find((m) => m.name === targetMeta);
    const groups = metaMeta
        ? [...new Set((metaMeta.groups || []).map((g) => String(g)).filter((g) => g && g.toLowerCase() !== "nan"))]
        : (run.data?.encoded_labels ? [...new Set(run.data.encoded_labels.map(String))] : []);

    if (groups.length < 2) {
        dom.pairList.innerHTML = '<div class="history-meta extra-small">Not enough groups to form a comparison pair.</div>';
        return;
    }

    let html = "";
    for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            const pair = `${groups[i]} vs ${groups[j]}`;
            html += `<div class="form-check"><input class="form-check-input pair-check" type="radio" name="vip-pair" value="${escapeHtmlAttr(pair)}" id="pair-${i}-${j}"><label class="form-check-label extra-small" for="pair-${i}-${j}">${sanitizeText(pair)}</label></div>`;
        }
    }
    dom.pairList.innerHTML = html;
    const radios = dom.pairList.querySelectorAll(".pair-check");
    if (radios.length) {
        radios[0].checked = true;
    }
    radios.forEach((r) => r.addEventListener("change", () => {
        validateRunBtn();
        tryAutoRunIfQueued();
    }));
}

function getSelectedPair() {
    const checked = dom.pairList?.querySelector(".pair-check:checked");
    return checked ? checked.value : null;
}

function validateRunBtn() {
    const run = state.selectedSourceRun;
    const pair = getSelectedPair();
    if (isRunCoolingDown()) {
        refreshRunBtnCooldownUi();
        return;
    }
    if (!dom.runBtn) return;
    dom.runBtn.disabled = !(run && pair) || state._runInProgress || state._runConfigLoading || state._runQueued;
    dom.runBtn.innerHTML = '<i class="fa-solid fa-play me-1"></i>RUN VIP ANALYSIS';
}

// ---------------------------------------------------------------------------
// Load run data from storage
// ---------------------------------------------------------------------------
async function ensureRunData(run) {
    if (run.data && (run.data.s_plot_data || run.data.vip_scores || run.data.vip_top)) return true;
    if (!run.data_path) return false;
    if (run._loadPromise) return run._loadPromise;

    run._loadPromise = (async () => {
    try {
        let data = null;
        try {
            let url = "";
            if (String(run.data_path).startsWith("http://") || String(run.data_path).startsWith("https://")) {
                url = run.data_path;
            } else {
                url = await getDownloadURL(ref(storage, run.data_path));
            }
            const resp = await fetch(url, { cache: "no-store" });
            if (!resp.ok) throw new Error("Failed to load run data from storage URL");
            data = await resp.json();
        } catch (storageError) {
            const loadPath = encodeURIComponent(run.data_path);
            const endpoint = run.method === "OPLS-DA" ? "oplsda" : "plsda";
            const resp = await fetch(`${vpsUrl}/${endpoint}/load-run?data_path=${loadPath}`, { cache: "no-store" });
            if (!resp.ok) {
                throw storageError;
            }
            data = await resp.json();
        }

        run.data = data;

        const stateRun = state.plsRuns.find((r) => r.run_id === run.run_id && r.method === run.method);
        if (stateRun && stateRun !== run) stateRun.data = run.data;
        return true;
    } catch (err) {
        console.error("Failed to load run data", err);
        return false;
    } finally {
        run._loadPromise = null;
    }
    })();

    return run._loadPromise;
}

// ---------------------------------------------------------------------------
// Run VIP analysis
// ---------------------------------------------------------------------------
async function runVipAnalysis() {
    if (state._runInProgress || state._runQueued) return;
    if (state._runConfigLoading) {
        state._runQueued = true;
        setRunBtnBusy(true);
        setRunStatus("Processing...");
        return;
    }

    const run = state.selectedSourceRun;
    let pair = getSelectedPair();
    if (!pair) {
        const firstPair = dom.pairList?.querySelector(".pair-check");
        if (firstPair) {
            firstPair.checked = true;
            pair = firstPair.value;
        }
    }
    if (!run || !pair) {
        validateRunBtn();
        return;
    }

    state._runInProgress = true;
    startRunCooldown();
    setRunStatus("Processing...");

    let loadingToken = state._loadingToken;
    let handoffAccepted = false;

    try {
        const matrixPath = state.projectData?.matrixPreScalePath;
        const metaPath = state.projectData?.metaCheckedPath;
        if (!matrixPath || !metaPath) {
            throw new Error("No normalized matrix or metadata path in project.");
        }

        const cfg = run.config || {};
        const targetMeta = cfg.target_meta || run.data?.target_meta;
        if (!targetMeta) {
            throw new Error("Selected run has no target_meta info.");
        }

        const ok = await ensureRunData(run);
        if (!ok) {
            throw new Error("Failed to load VIP scores from the selected run.");
        }

        const vipScores = run.data?.vip_scores || run.data?.vip_top || [];
        if (!vipScores.length) {
            throw new Error("Selected run has no VIP scores data.");
        }

        loadingToken = ++state._loadingToken;
        setResultsLoading("Loading...");
        setRunStatus("Processing...");

        const analysisName = dom.vipAnalysisName?.value.trim() || `VIP_${pair}_${Date.now()}`;

        const response = await fetch(`${vpsUrl}/vip-score/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project_id: projectId,
                uid: auth.currentUser.uid,
                name: analysisName,
                matrix_path: matrixPath,
                meta_path: metaPath,
                target_meta: targetMeta,
                comparison: pair,
                vip_scores: vipScores,
                run_id_src: run.run_id,
                method_src: run.method,
            }),
        });
        if (!response.ok) {
            const txt = await response.text().catch(() => "");
            throw new Error(txt || `VIP run failed (${response.status})`);
        }

        const startPayload = await response.json();
        const runId = startPayload.run_id;
        const taskId = startPayload.task_id;

        state.vipHistory = dedupeVipHistory([
            {
                run_id: runId,
                task_id: taskId,
                name: analysisName,
                date: new Date().toISOString(),
                target_meta: targetMeta,
                comparison: pair,
                method_src: run.method,
                run_id_src: run.run_id,
                source_run_name: run.name || null,
                source_run_data_path: run.data_path || null,
                status: "pending",
                message: "Queued for processing.",
            },
            ...state.vipHistory.filter((h) => h.run_id !== runId),
        ]);
        state.selectedHistoryId = runId;
        renderHistoryPopup();
        handoffAccepted = true;
        state._runInProgress = false;
        validateRunBtn();

        void (async () => {
            try {
                const d = await waitForVipTask(runId);

                state.projectData = { ...(state.projectData || {}), ...d };
                const taskFallback = buildTaskFallbackEntry(d.vip_combined_task || null);
                state.vipHistory = dedupeVipHistory([
                    ...(Array.isArray(d.vip_combined_history) ? d.vip_combined_history : []),
                    ...(taskFallback ? [taskFallback] : []),
                ]);
                renderHistoryPopup();

                const completedEntry = state.vipHistory.find((item) => item.run_id === runId) || null;
                if (!completedEntry) throw new Error("VIP completed but history entry was not found.");

                const count = await loadCombinedResults({
                    results_url: completedEntry.results_url,
                    csv_url: completedEntry.csv_url,
                    run,
                    pair,
                    name: completedEntry.name || analysisName,
                });
                stopRunCooldown();
                setRunStatus(`Done — ${count} features`);
            } catch (err) {
                stopRunCooldown();
                setRunStatus(err.message || String(err), true);
            } finally {
                state._runQueued = false;
                validateRunBtn();
                tryAutoRunIfQueued();
            }
        })();
        return;
    } catch (err) {
        stopRunCooldown();
        setRunStatus(err.message || String(err), true);
    } finally {
        state._runInProgress = false;
        if (!handoffAccepted) {
            stopRunCooldown();
        }
        if (loadingToken === state._loadingToken && !isRunCoolingDown()) {
            setRunBtnBusy(false);
        }
        validateRunBtn();
        tryAutoRunIfQueued();
    }
}

// ---------------------------------------------------------------------------
// Load results from a history entry
// ---------------------------------------------------------------------------
async function loadHistoryEntry(entry) {
    const loadingToken = ++state._loadingToken;
    setResultsLoading("Loading...");

    const srcRun = state.plsRuns.find(
        (r) => r.run_id === entry.run_id_src && r.method === entry.method_src
    ) || null;

    try {
        const count = await loadCombinedResults({
            results: entry.results || null,
            results_url: entry.results_url || null,
            csv_url: entry.csv_url || null,
            run: srcRun,
            pair: entry.comparison || null,
            name: entry.name || "Untitled",
        });

        if (dom.vipAnalysisName) dom.vipAnalysisName.value = entry.name || "";
        setRunStatus(`Loaded history: ${entry.name || "Untitled"} (${count} features)`);
    } catch (err) {
        setRunStatus(err.message || String(err), true);
    } finally {
        if (loadingToken !== state._loadingToken) return;
    }
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------
async function loadCombinedResults({ results, results_url, csv_url, run, pair, name }) {
    const resolvedResults = Array.isArray(results) && results.length
        ? results
        : (results_url ? await fetchJsonFromStorage(results_url) : []);

    state.tableRows = (resolvedResults || []).map((r) => ({
        feature: String(r.feature || ""),
        vip: toSafeNumber(r.vip),
        log2fc: toSafeNumber(r.log2fc),
        p_value: toSafeNumber(r.p_value),
        fdr: toSafeNumber(r.fdr),
        method: r.method || "",
    }));

    state._csvUrl = csv_url || null;
    state._activeName = name || "";
    state.selectedFeatures.clear();
    state._forceAutoscaleSPlotOnce = true;

    if (dom.csvBtn) dom.csvBtn.disabled = !state.tableRows.length;
    renderTable(state.tableRows);

    if (run) {
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = "Loading source run for S-Plot...";
        const ok = await ensureRunData(run);
        if (ok) {
            renderSPlot(run, pair || "");
        } else {
            clearPlot("Failed to load source run data for S-Plot.");
            if (dom.plotSubtitle) dom.plotSubtitle.textContent = "Failed to load source run data for S-Plot.";
        }
    } else {
        clearPlot("Source run data not available for S-Plot.");
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = "Source run data not available for S-Plot.";
    }

    return state.tableRows.length;
}

function clearResults() {
    state.tableRows = [];
    state.selectedFeatures.clear();
    state._currentRun = null;
    state._currentPair = null;
    state._csvUrl = null;
    if (dom.tableBody) dom.tableBody.innerHTML = "";
    if (dom.rowCount) dom.rowCount.textContent = "0 rows";
    if (dom.csvBtn) dom.csvBtn.disabled = true;
    clearPlot();
    if (dom.plotSubtitle) dom.plotSubtitle.textContent = DEFAULT_PLOT_MESSAGE;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------
function filterAndSortRows(rows) {
    const search = state.searchText.trim().toLowerCase();
    const minVip = Number.isFinite(state.minVip) ? state.minVip : 0;
    const maxFdr = Number.isFinite(state.maxFdr) ? state.maxFdr : 1;

    let output = [...rows].filter((row) => {
        const vip = toSafeNumber(row.vip);
        const fdr = toSafeNumber(row.fdr);
        const passVip = vip === null ? minVip <= 0 : vip >= minVip;
        const passFdr = fdr === null ? true : fdr <= maxFdr;
        const passSearch = !search || row.feature.toLowerCase().includes(search);
        return passVip && passFdr && passSearch;
    });

    const sorters = {
        vip_desc:    (a, b) => (toSafeNumber(b.vip) ?? -Infinity) - (toSafeNumber(a.vip) ?? -Infinity),
        vip_asc:     (a, b) => (toSafeNumber(a.vip) ?? Infinity)  - (toSafeNumber(b.vip) ?? Infinity),
        fdr_asc:     (a, b) => (toSafeNumber(a.fdr) ?? Infinity)  - (toSafeNumber(b.fdr) ?? Infinity),
        abs_fc_desc: (a, b) => Math.abs(toSafeNumber(b.log2fc) ?? 0) - Math.abs(toSafeNumber(a.log2fc) ?? 0),
        fc_desc:     (a, b) => (toSafeNumber(b.log2fc) ?? -Infinity) - (toSafeNumber(a.log2fc) ?? -Infinity),
        fc_asc:      (a, b) => (toSafeNumber(a.log2fc) ?? Infinity)  - (toSafeNumber(b.log2fc) ?? Infinity),
    };
    const sorterFn = sorters[state.sortBy] || sorters.vip_desc;
    output.sort((a, b) => sorterFn(a, b) || a.feature.localeCompare(b.feature));

    return output;
}

function renderTable(rows) {
    const data = filterAndSortRows(rows);
    if (dom.rowCount) dom.rowCount.textContent = `${data.length} rows`;

    if (!data.length) {
        if (dom.tableBody) dom.tableBody.innerHTML = '<tr><td colspan="5" class="text-muted py-3">No features match current filter.</td></tr>';
        return;
    }

    dom.tableBody.innerHTML = data.map((row) => {
        const isChecked = state.selectedFeatures.has(row.feature);
        const vip = toSafeNumber(row.vip);
        const fdr = toSafeNumber(row.fdr);
        const log2fc = toSafeNumber(row.log2fc);
        const vipBadge = vip !== null && vip >= 1 ? "bg-warning text-dark" : "bg-light text-muted";
        const fcClass = log2fc !== null ? (log2fc > 0 ? "text-danger" : "text-primary") : "";

        return `
            <tr data-feature="${escapeHtmlAttr(row.feature)}" style="cursor:pointer;">
                <td><input type="checkbox" class="feature-check" value="${escapeHtmlAttr(row.feature)}" ${isChecked ? "checked" : ""}></td>
                <td class="text-start fw-bold">${sanitizeText(row.feature)}</td>
                <td><span class="badge ${vipBadge}">${fmtNum(row.vip, 3)}</span></td>
                <td class="${fcClass}">${fmtNum(row.log2fc, 3)}</td>
                <td>${fmtNum(row.fdr, 4)}</td>
            </tr>
        `;
    }).join("");

    dom.tableBody.querySelectorAll("tr").forEach((rowEl) => {
        rowEl.addEventListener("click", (event) => {
            if (event.target.classList.contains("feature-check")) return;
            toggleFeature(rowEl.dataset.feature);
            renderTable(state.tableRows);
            renderSPlot(state._currentRun, state._currentPair);
        });
    });

    dom.tableBody.querySelectorAll(".feature-check").forEach((cb) => {
        cb.addEventListener("change", () => {
            toggleFeature(cb.value, cb.checked);
            renderSPlot(state._currentRun, state._currentPair);
        });
    });
}

function toggleFeature(feature, checked) {
    if (!feature) return;
    if (typeof checked === "boolean") {
        if (checked) state.selectedFeatures.add(feature);
        else state.selectedFeatures.delete(feature);
        return;
    }
    if (state.selectedFeatures.has(feature)) state.selectedFeatures.delete(feature);
    else state.selectedFeatures.add(feature);
}

// ---------------------------------------------------------------------------
// CSV download
// ---------------------------------------------------------------------------
function downloadCsv(rows) {
    // Build S-plot coordinate lookup from current run's s_plot_data
    const splotMap = new Map();
    const splotData = state._currentRun?.data?.s_plot_data;
    if (Array.isArray(splotData)) {
        splotData.forEach((r) => {
            const feat = String(r.feature || "").trim();
            if (feat) splotMap.set(feat, { p: r.p ?? null, p_corr: r.p_corr ?? null });
        });
    }

    const header = ["Feature", "VIP", "log2FC", "p_value", "FDR", "Method", "splot_cov_p", "splot_corr_p"];
    const lines = [header.join(",")];
    rows.forEach((row) => {
        const coords = splotMap.get(String(row.feature || "").trim()) || {};
        lines.push([
            csvEscape(row.feature),
            csvEscape(row.vip != null ? Number(row.vip).toFixed(6) : ""),
            csvEscape(row.log2fc != null ? Number(row.log2fc).toFixed(6) : ""),
            csvEscape(row.p_value != null ? Number(row.p_value).toFixed(6) : ""),
            csvEscape(row.fdr != null ? Number(row.fdr).toFixed(6) : ""),
            csvEscape(row.method || ""),
            csvEscape(coords.p != null ? Number(coords.p).toFixed(6) : ""),
            csvEscape(coords.p_corr != null ? Number(coords.p_corr).toFixed(6) : ""),
        ].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vip_combined_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// S-Plot rendering (from source run's s_plot_data)
// ---------------------------------------------------------------------------
function clearPlot(message = DEFAULT_PLOT_MESSAGE) {
    try { if (window.Plotly && dom.splotWrap) Plotly.purge(dom.splotWrap); } catch {}
    if (dom.splotWrap) { dom.splotWrap.innerHTML = ""; dom.splotWrap.classList.add("d-none"); }
    if (dom.plotEmpty) {
        dom.plotEmpty.textContent = message;
        dom.plotEmpty.classList.remove("d-none");
    }
}

function renderSPlot(run, pair) {
    state._currentRun = run || null;
    state._currentPair = pair || null;

    if (!run || !run.data) {
        clearPlot();
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = "Source run not loaded.";
        return;
    }

    const sPlot = Array.isArray(run.data.s_plot_data) ? run.data.s_plot_data : [];
    const vipScores = Array.isArray(run.data.vip_scores) ? run.data.vip_scores : (run.data.vip_top || []);

    const byFeature = new Map();
    sPlot.forEach((row) => {
        const feature = String(row.feature || "").trim();
        if (!feature) return;
        byFeature.set(feature, { feature, p: toSafeNumber(row.p), p_corr: toSafeNumber(row.p_corr), vip: toSafeNumber(row.vip) });
    });
    vipScores.forEach((row) => {
        const feature = String(row.feature || "").trim();
        if (!feature) return;
        const existing = byFeature.get(feature) || { feature, p: null, p_corr: null, vip: null };
        const vip = toSafeNumber(row.vip);
        if (vip !== null) existing.vip = vip;
        byFeature.set(feature, existing);
    });

    let rows = Array.from(byFeature.values());
    if (!rows.length) {
        clearPlot();
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = "No S-Plot data available for this run.";
        return;
    }

    // Merge combined stats (fdr, log2fc) for coloring
    const combinedMap = new Map(state.tableRows.map((r) => [r.feature, r]));
    rows = rows.map((row) => {
        const combined = combinedMap.get(row.feature);
        return { ...row, fdr: combined?.fdr ?? null, log2fc: combined?.log2fc ?? null };
    });

    const hasReal = rows.some((r) => r.p !== null && r.p_corr !== null);
    if (!hasReal) {
        const sorted = [...rows].sort((a, b) => (b.vip || 0) - (a.vip || 0));
        const n = sorted.length;
        rows = sorted.map((row, idx) => ({
            ...row,
            p: n > 1 ? -1 + (2 * idx) / (n - 1) : 0,
            p_corr: Math.tanh(((row.vip || 0) - 1) * 1.5),
        }));
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = `${run.name} | Fallback coords (run created before s_plot_data support).`;
    } else {
        if (dom.plotSubtitle) dom.plotSubtitle.textContent = `${run.name} (${run.method}) | Pair: ${pair || "N/A"} | Select rows to label.`;
    }

    const selectedSet = state.selectedFeatures;
    const selectedRows = rows.filter((r) => selectedSet.has(r.feature));

    const sigVip = Number.isFinite(state.minVip) ? state.minVip : 1;
    const sigFdr = Number.isFinite(state.maxFdr) ? state.maxFdr : 0.05;
    const isSignificant = (row) => {
        const vip = toSafeNumber(row.vip);
        const fdr = toSafeNumber(row.fdr);
        return vip !== null && vip >= sigVip && fdr !== null && fdr <= sigFdr;
    };
    const sigLabel = `VIP ≥ ${sigVip} & FDR ≤ ${sigFdr}`;

    const sigRows = rows.filter((row) => isSignificant(row));
    const otherRows = rows.filter((row) => !isSignificant(row));

    const makePointsTrace = (traceRows, name, color, opacity) => ({
        x: traceRows.map((r) => r.p),
        y: traceRows.map((r) => r.p_corr),
        text: traceRows.map((r) => r.feature),
        mode: "markers",
        type: "scattergl",
        name,
        marker: {
            color,
            size: traceRows.map((r) => (selectedSet.has(r.feature) ? plotConfig.markerSize + 4 : plotConfig.markerSize)),
            line: { color: "rgba(0,0,0,0.2)", width: 0.4 },
            opacity,
        },
        // Prevent Plotly from dimming unselected points when any point is highlighted
        selected: { marker: { opacity } },
        unselected: { marker: { opacity } },
        hovertemplate: "<b>%{text}</b><br>p: %{x:.4f}<br>p(corr): %{y:.4f}<br>VIP: %{customdata[0]:.3f}<br>FDR: %{customdata[1]}<extra></extra>",
        customdata: traceRows.map((r) => [
            toSafeNumber(r.vip) === null ? NaN : r.vip,
            toSafeNumber(r.fdr) === null ? "-" : Number(r.fdr).toFixed(4),
        ]),
    });

    // Others (non-significant): always gray, fixed opacity 0.5, rendered first (below)
    const pointsOtherTrace = makePointsTrace(otherRows, "Others", "#7a7a7a", 0.5);
    // Significant: configurable opacity, rendered on top
    const pointsSigTrace = makePointsTrace(sigRows, sigLabel, "#d62728", plotConfig.markerOpacity);

    const xVals = rows.map((r) => toSafeNumber(r.p)).filter((v) => v !== null);
    const yVals = rows.map((r) => toSafeNumber(r.p_corr)).filter((v) => v !== null);
    const xMin = Math.min(...xVals) - 0.01;
    const xMax = Math.max(...xVals) + 0.01;
    const yMin = Math.min(...yVals) - 0.1;
    const yMax = Math.max(...yVals) + 0.1;

    const selectedAnnotations = selectedRows.map((row) => {
        const saved = vipLabelPositions.get(row.feature);
        return {
            // Arrowhead tip: always locked to the data point
            x: row.p,
            y: row.p_corr,
            xref: "x", yref: "y",
            // Text box: absolute data coordinates — user drags this part
            ax: saved ? saved.ax : row.p,
            ay: saved ? saved.ay : row.p_corr + (yMax - yMin) * 0.06,
            axref: "x", ayref: "y",
            text: row.feature,
            showarrow: true,
            arrowhead: 2,
            arrowsize: 1,
            arrowwidth: 1,
            arrowcolor: "#000000",
            font: { size: plotConfig.labelFontSize, color: "#000000" },
            bgcolor: "rgba(255,255,255,0.8)",
            borderpad: 2,
        };
    });

    // Preserve zoom/pan state across re-renders (e.g. when toggling a label)
    const prevLayout = dom.splotWrap.layout;
    const prevXRange = prevLayout?.xaxis?.range;
    const prevYRange = prevLayout?.yaxis?.range;
    const keepPrevZoom = !state._forceAutoscaleSPlotOnce && Array.isArray(prevXRange) && prevXRange.length === 2 && Array.isArray(prevYRange) && prevYRange.length === 2;

    const axisTitleFont = { size: plotConfig.axisFontSize };

    const layout = {
        margin: { t: 10, b: 55, l: 65, r: 20 },
        autosize: true,
        hovermode: "closest",
        xaxis: {
            title: { text: "p (Covariance)", font: axisTitleFont },
            zeroline: true,
            ...(keepPrevZoom ? { range: prevXRange, autorange: false } : { autorange: true }),
        },
        yaxis: {
            title: { text: "p(corr) (Correlation)", font: axisTitleFont },
            zeroline: true,
            ...(keepPrevZoom ? { range: prevYRange, autorange: false } : { autorange: true }),
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        showlegend: true,
        legend: {
            x: 0.99,
            y: 0.01,
            xanchor: "right",
            yanchor: "bottom",
            bgcolor: "rgba(255,255,255,0.85)",
            bordercolor: "#d0d6df",
            borderwidth: 1,
            orientation: "v",
            font: { size: plotConfig.legendFontSize },
        },
        shapes: [
            { type: "line", x0: 0, x1: 0, y0: yMin, y1: yMax, line: { color: "#8d99a6", dash: "dash", width: 1 } },
            { type: "line", x0: xMin, x1: xMax, y0: 0, y1: 0, line: { color: "#8d99a6", dash: "dash", width: 1 } },
        ],
        annotations: selectedAnnotations,
    };

    dom.splotWrap.classList.remove("d-none");
    dom.plotEmpty.classList.add("d-none");

    if (typeof dom.splotWrap.removeAllListeners === "function") {
        dom.splotWrap.removeAllListeners("plotly_click");
        dom.splotWrap.removeAllListeners("plotly_relayout");
    }

    Plotly.newPlot(dom.splotWrap, [pointsOtherTrace, pointsSigTrace], layout, {
        responsive: true,
        displayModeBar: "hover",
        displaylogo: false,
        scrollZoom: true,
        toImageButtonOptions: { format: plotConfig.imgFormat, width: plotConfig.imgWidth, height: plotConfig.imgHeight, scale: plotConfig.imgFormat === "svg" ? 1 : 6 },
        edits: {
            annotationPosition: false, // keep arrowhead locked to data point
            annotationTail: true,      // allow dragging the text box (ax, ay in data coords)
            annotationText: false,     // disable text editing
            legendPosition: true,      // allow dragging the legend box
        },
    });

    if (state._forceAutoscaleSPlotOnce) {
        state._forceAutoscaleSPlotOnce = false;
        try {
            Plotly.relayout(dom.splotWrap, {
                "xaxis.autorange": true,
                "yaxis.autorange": true,
            });
        } catch {
            // Ignore relayout race errors.
        }
    }

    requestAnimationFrame(() => { try { Plotly.Plots.resize(dom.splotWrap); } catch {} });

    dom.splotWrap.on("plotly_click", (eventData) => {
        const pt = eventData?.points?.[0];
        if (!pt?.text) return;
        toggleFeature(String(pt.text));
        renderTable(state.tableRows);
        renderSPlot(run, pair);
    });

    // Save dragged text-box positions so they survive re-renders
    dom.splotWrap.on("plotly_relayout", (eventdata) => {
        const keys = Object.keys(eventdata || {});
        if (!keys.some((k) => /^annotations\[/.test(k))) return;
        const current = dom.splotWrap.layout?.annotations || [];
        keys.filter((k) => /^annotations\[/.test(k)).forEach((k) => {
            const m = k.match(/annotations\[(\d+)\]/);
            if (!m) return;
            const ann = current[Number(m[1])];
            if (ann?.text) vipLabelPositions.set(ann.text, { ax: ann.ax, ay: ann.ay });
        });
    });
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setRunStatus(msg, isError = false) {
    if (!dom.runStatus) return;
    dom.runStatus.textContent = msg || "";
    dom.runStatus.classList.toggle("error", Boolean(isError));
}

// ---------------------------------------------------------------------------
// bindEvents
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Realtime plot-config updates (from gear-button panel)
// ---------------------------------------------------------------------------
function applyPlotConfigUpdate(key, value, allCfg) {
    const el = dom.splotWrap;
    if (!el || el.classList.contains("d-none") || !el.data) return;

    switch (key) {
        case "markerSize": {
            el.data.forEach((trace, i) => {
                if (!Array.isArray(trace.text)) return;
                const newSizes = trace.text.map(f =>
                    state.selectedFeatures.has(f) ? value + 4 : value
                );
                Plotly.restyle(el, { "marker.size": [newSizes] }, i);
            });
            break;
        }
        case "axisFontSize": {
            Plotly.relayout(el, {
                "xaxis.title.font.size"  : allCfg.axisFontSize,
                "xaxis.tickfont.size"    : allCfg.axisFontSize,
                "yaxis.title.font.size"  : allCfg.axisFontSize,
                "yaxis.tickfont.size"    : allCfg.axisFontSize,
            });
            break;
        }
        case "labelFontSize": {
            const annotations = (el.layout?.annotations || []).map(a => ({
                ...a, font: { ...a.font, size: value },
            }));
            Plotly.relayout(el, { annotations });
            break;
        }
        case "legendFontSize": {
            Plotly.relayout(el, { "legend.font.size": value });
            break;
        }
        case "markerOpacity": {
            // Trace 0 = Others (non-sig): always fixed at 0.5 — skip
            // Trace 1 = Significant: apply configurable opacity
            el.data.forEach((trace, i) => {
                if (i === 0) return; // Others trace is always 0.5
                Plotly.restyle(el, {
                    "marker.opacity": value,
                    "selected.marker.opacity": value,
                    "unselected.marker.opacity": value,
                }, i);
            });
            break;
        }
        // imgWidth / imgHeight: applied on next renderSPlot and via custom download button
        default:
            break;
    }
}

function bindEvents() {
    // Mount gear-button config panel into the plot toolbar
    if (dom.splotConfigAnchor) {
        mountPlotConfigPanel({
            anchor: dom.splotConfigAnchor,
            defaults: { ...plotConfig },
            onUpdate(key, value, allCfg) {
                Object.assign(plotConfig, allCfg);
                applyPlotConfigUpdate(key, value, allCfg);
            },
            onDownload(cfg) {
                if (!dom.splotWrap || dom.splotWrap.classList.contains("d-none")) return;
                const fmt = cfg.imgFormat || "svg";
                const scale = fmt === "svg" ? 1 : 6; // ×6 → ~600 PPI for raster
                Plotly.downloadImage(dom.splotWrap, {
                    format  : fmt,
                    width   : cfg.imgWidth,
                    height  : cfg.imgHeight,
                    scale,
                    filename: `vip_splot_${Date.now()}`,
                });
            },
        });
    }

    if (dom.historyToggle) {
        dom.historyToggle.addEventListener("click", (e) => {
            e.stopPropagation();
            dom.historyPopup?.classList.toggle("open");
        });
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".history-anchor")) {
            dom.historyPopup?.classList.remove("open");
        }
    });

    if (dom.sourceType) {
        dom.sourceType.addEventListener("change", populateRunSelect);
    }

    if (dom.runSelect) {
        dom.runSelect.addEventListener("change", onRunSelectChange);
    }

    if (dom.runBtn) {
        dom.runBtn.addEventListener("click", runVipAnalysis);
    }

    if (dom.tableSort) {
        dom.tableSort.addEventListener("change", () => {
            state.sortBy = dom.tableSort.value;
            renderTable(state.tableRows);
            renderSPlot(state._currentRun, state._currentPair);
        });
    }

    if (dom.vipThreshold) {
        dom.vipThreshold.addEventListener("change", () => {
            const v = Number(dom.vipThreshold.value);
            state.minVip = Number.isFinite(v) ? Math.max(0, v) : 1;
            dom.vipThreshold.value = String(state.minVip);
            renderTable(state.tableRows);
            renderSPlot(state._currentRun, state._currentPair);
        });
    }

    if (dom.fdrThreshold) {
        dom.fdrThreshold.addEventListener("change", () => {
            const v = Number(dom.fdrThreshold.value);
            state.maxFdr = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.05;
            dom.fdrThreshold.value = String(state.maxFdr);
            renderTable(state.tableRows);
            renderSPlot(state._currentRun, state._currentPair);
        });
    }

    if (dom.tableSearch) {
        dom.tableSearch.addEventListener("input", () => {
            state.searchText = dom.tableSearch.value || "";
            renderTable(state.tableRows);
            renderSPlot(state._currentRun, state._currentPair);
        });
    }

    if (dom.csvBtn) {
        dom.csvBtn.addEventListener("click", () => {
            const data = filterAndSortRows(state.tableRows);
            if (!data.length) { alert("No rows to export."); return; }
            downloadCsv(data);
        });
    }

    window.addEventListener("resize", () => {
        if (dom.splotWrap && !dom.splotWrap.classList.contains("d-none") && window.Plotly) {
            Plotly.Plots.resize(dom.splotWrap);
        }
    });
}

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------
async function initProject(user) {
    await injectSidebar(user.uid);

    const snapshot = await getDoc(doc(db, "projects", projectId));
    state.projectData = snapshot.data() || {};
    if (window.renderNormSummary) window.renderNormSummary(state.projectData.norm_settings, state.projectData.normality_stat);
    state.plsRuns = getAllRunsFromProjectData(state.projectData);
    state.vipHistory = dedupeVipHistory([
        ...(Array.isArray(state.projectData.vip_combined_history) ? state.projectData.vip_combined_history : []),
        ...(state.projectData.vip_combined_task ? [buildTaskFallbackEntry(state.projectData.vip_combined_task)] : []),
    ]);

    renderHistoryPopup();
    populateRunSelect();
    clearResults();
    setRunStatus(DEFAULT_STATUS_MESSAGE);

    // Live updates
    onSnapshot(doc(db, "projects", projectId), (snap) => {
        const data = snap.data() || {};
        state.projectData = { ...(state.projectData || {}), ...data };

        // Sync PLS runs (preserve loaded data)
        const prevRuns = state.plsRuns;
        const incoming = getAllRunsFromProjectData(state.projectData);
        state.plsRuns = incoming.map((inc) => {
            const ex = prevRuns.find((r) => r.run_id === inc.run_id && r.method === inc.method);
            if (ex?.data && Object.keys(ex.data).length > 0) return { ...inc, data: ex.data };
            return inc;
        });

        // Sync VIP history and task state
        const taskFallback = buildTaskFallbackEntry(data.vip_combined_task || null);
        state.vipHistory = dedupeVipHistory([
            ...(Array.isArray(data.vip_combined_history) ? data.vip_combined_history : []),
            ...(taskFallback ? [taskFallback] : []),
        ]);
        renderHistoryPopup();

        // Refresh run select without losing current selection
        if (haveRunListChanged(prevRuns, state.plsRuns)) {
            populateRunSelect();
        }
    });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
bindEvents();

onAuthStateChanged(auth, async (user) => {
    if (!user || !projectId) return;
    await initProject(user);
    document.body.classList.add("loaded");
});
