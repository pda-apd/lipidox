import "./auth-gate.js";
import { db, auth, storage } from "./firebase-config.js";
import { mountPlotConfigPanel, PLOT_CONFIG_DEFAULTS } from "./plot-config-panel.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { onAuthStateChanged } from "./firebase-config.js";
import { doc, getDoc, updateDoc, onSnapshot, deleteField} from "./firebase-config.js";
import { ref, getDownloadURL, uploadString } from "./firebase-config.js";
import { vpsUrl, TASK_STALE_TIMEOUT_MS } from "./auth-gate.js";

const urlParams = new URLSearchParams(window.location.search);
const projectId = urlParams.get('id');

let projectData = null;
let olsDataGlobal = [];
let encSettings = {};
let activeVar = "";
let modalEnc = null;
let analysisHistory = [];
let currentRunId = null;
let currentStep = 'ols';
let selectedCorrOlsRunId = "";
let selectedRocOlsRunId = "";
let currentCorrMethod = 'spearman';
let currentOlsTargetMeta = "";
let selectedHistoryRunId = null;
let rocSnapshotUnsubscribe = null;
let rocResultsSourceKey = null;
let activeRunCount = 0;
let olsPlotConfig = { ...PLOT_CONFIG_DEFAULTS };
let corrPlotConfig = { ...PLOT_CONFIG_DEFAULTS };
let rocPlotConfig  = { ...PLOT_CONFIG_DEFAULTS };
let rocLegendPosition = { x: 0.65, y: 0.15 };
let historyLoadToken = 0;
let selectedOlsFeature = null;
let progressionLoadToken = 0;
let staleBiomarkerRunId = null;
let currentRocRunId = null;
const loadedAnalysisByStep = { ols: null, corr: null, roc: null };
const progressionMemoryCache = new Map();
const progressionInFlight = new Map();
const progressionDataset = {
    matrixRows: new Map(),
    sampleIds: [],
    metaBySample: new Map(),
    loaded: false,
    loadingPromise: null,
};

function toSafeNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function normalizeBiomarkerStatus(status) {
    const value = String(status || 'done').toLowerCase();
    if (value === 'pending') return 'pending';
    if (value === 'running' || value === 'processing') return 'running';
    if (value === 'error') return 'error';
    return 'done';
}

function isOlsHistoryItem(item) {
    return Boolean(item && (item.analysis_type === 'ols' || item.ols_results || item.ols_results_url || item.ols_csv_url));
}

function getAnalysisStep(item) {
    if (!item) return null;
    if (item.analysis_type === 'corr' || item.corr_html_url || item.corr_results_url || item.corr_results) return 'corr';
    if (item.analysis_type === 'roc' || item.roc_results || item.roc_results_url) return 'roc';
    if (isOlsHistoryItem(item)) return 'ols';
    return null;
}

function normalizeCorrMethod(value) {
    return String(value || 'spearman').toLowerCase() === 'pearson' ? 'pearson' : 'spearman';
}

function getCorrMethodLabel(value) {
    return normalizeCorrMethod(value) === 'pearson' ? 'Pearson' : 'Spearman';
}

function formatTaskId(item) {
    if (item?.task_id == null || item?.task_id === '') return '';
    return `ID ${item.task_id}`;
}

function getTaskStatusBadge(status) {
    if (status === 'running') return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Running</span>';
    if (status === 'pending') return '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">Pending</span>';
    if (status === 'error') return '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Error</span>';
    return '<span class="badge bg-success-subtle text-success border border-success-subtle">Done</span>';
}

function getTaskActivityTime(task) {
    const raw = task?.heartbeat_at || task?.updated_at || task?.started_at || task?.date || null;
    const ts = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ts) ? ts : null;
}

function isTaskStale(task) {
    const status = normalizeBiomarkerStatus(task?.status);
    if (status !== 'pending' && status !== 'running') return false;
    const activityTs = getTaskActivityTime(task);
    if (!activityTs) return false;
    return (Date.now() - activityTs) >= TASK_STALE_TIMEOUT_MS;
}

function getBiomarkerTaskField(step) {
    return `biomarker_${step}_task`;
}

function buildTaskFallbackEntry(task) {
    if (!task?.run_id) return null;
    return {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        analysis_type: task.analysis_type || null,
        name: task.name || 'Untitled',
        date: task.completed_at || task.started_at || new Date().toISOString(),
        target: task.target || null,
        covariates: task.covariates || [],
        source_ols_run_id: task.source_ols_run_id || null,
        source_ols_name: task.source_ols_name || null,
        corr_method: normalizeCorrMethod(task.corr_method),
        clinical_vars: task.clinical_vars || [],
        corr_top_n: task.corr_top_n || null,
        corr_sort_by: task.corr_sort_by || null,
        roc_target: task.roc_target || null,
        roc_comparisons: task.roc_comparisons || [],
        status: normalizeBiomarkerStatus(task.status),
        message: task.message || '',
        ols_results_url: task.ols_results_url || null,
        ols_csv_url: task.ols_csv_url || null,
        corr_html_url: task.corr_html_url || null,
        corr_csv_url: task.corr_csv_url || null,
        roc_results_url: task.roc_results_url || null,
        roc_csv_url: task.roc_csv_url || null,
    };
}

function formatOlsMetricSummary(info) {
    return `Adj R²: ${toSafeNum(info?.adj_r2).toFixed(3)} | Beta: ${toSafeNum(info?.beta).toExponential(2)} | FDR: ${toSafeNum(info?.fdr).toExponential(2)}`;
}

function getOlsVisualPanel() {
    return document.getElementById('ols-feature-visual-panel') || document.getElementById('ols-lipid-visual-panel');
}

function hashString(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function getProgressionCachePath(featureName, analysis) {
    const uid = auth.currentUser?.uid || 'anonymous';
    const runId = analysis?.run_id || selectedHistoryRunId || 'adhoc';
    const safeFeature = `${makeSafeId(featureName).slice(0, 80)}_${hashString(featureName)}`;
    return `projects/${uid}/${projectId}/ols_results/biomarker_progression/${runId}/${safeFeature}.json`;
}

function parseCsvRow(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    values.push(current);
    return values;
}

function parseCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) return { header: [], rows: [] };
    const header = parseCsvRow(lines[0]);
    const rows = lines.slice(1).map(parseCsvRow);
    return { header, rows };
}

async function fetchJsonNoStore(url) {
    if (!url) throw new Error('Missing JSON URL.');
    const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Cannot load JSON: HTTP ${resp.status}`);
    return resp.json();
}

function normalizeOlsResultRow(row) {
    if (!row) return null;
    const lipid = String(row.lipid ?? row.feature ?? row.Feature ?? '').trim();
    if (!lipid) return null;
    return {
        lipid,
        beta: Number(row.beta ?? row.Beta ?? row.coef ?? row.coefficient),
        p_value: Number(row.p_value ?? row.p ?? row.pvalue ?? row['P-value'] ?? row['p.value']),
        fdr: Number(row.fdr ?? row.FDR ?? row.q_value ?? row.qvalue ?? row.adj_p ?? row.adj_p_value),
        adj_r2: Number(row.adj_r2 ?? row.adj_r_squared ?? row.adjr2 ?? row['Adj R2'] ?? row['Adj R²'] ?? row.adj_R2),
    };
}

async function ensureOlsResultsLoaded(analysis) {
    if (!analysis) return [];
    if (Array.isArray(analysis.ols_results) && analysis.ols_results.length) {
        return analysis.ols_results;
    }

    let rows = [];
    if (analysis.ols_results_url) {
        const payload = await fetchJsonNoStore(analysis.ols_results_url);
        rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    } else if (analysis.ols_csv_url) {
        const text = await fetch(`${analysis.ols_csv_url}${analysis.ols_csv_url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' }).then((resp) => {
            if (!resp.ok) throw new Error(`Cannot load OLS CSV: HTTP ${resp.status}`);
            return resp.text();
        });
        const parsed = parseCsv(text);
        rows = parsed.rows.map((cells) => {
            const output = {};
            parsed.header.forEach((header, index) => {
                output[header] = cells[index];
            });
            return output;
        });
    } else if (Array.isArray(projectData?.ols_results) && analysis.run_id === (window._currentLoadedAnalysis?.run_id || null)) {
        rows = projectData.ols_results;
    }

    analysis.ols_results = rows.map(normalizeOlsResultRow).filter(Boolean);
    return analysis.ols_results;
}

async function uploadOlsHistoryResultsToStorage(entry) {
    if (!entry || !Array.isArray(entry.ols_results) || !entry.ols_results.length || entry.ols_results_url) {
        const nextEntry = { ...entry };
        if (nextEntry.ols_results_url) delete nextEntry.ols_results;
        return nextEntry;
    }

    const uid = auth.currentUser?.uid || 'anonymous';
    const runId = entry.run_id || `legacy_${Date.now()}`;
    const path = `projects/${uid}/${projectId}/ols_results/biomarker_ols_history_${runId}.json`;
    await uploadString(ref(storage, path), JSON.stringify(entry.ols_results), 'raw', { contentType: 'application/json' });
    const url = await getDownloadURL(ref(storage, path));

    const nextEntry = { ...entry, ols_results_url: url };
    delete nextEntry.ols_results;
    return nextEntry;
}

function toFiniteNumberOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function isMissingMeta(value) {
    const str = String(value ?? '').trim().toLowerCase();
    return !str || str === 'nan' || str === 'none' || str === 'null';
}

function fitLinearTrend(x, y) {
    const n = x.length;
    if (n < 2) {
        return { slope: 0, intercept: y[0] ?? 0, r2: 0 };
    }

    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;
    let cov = 0;
    let varX = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        cov += dx * (y[i] - meanY);
        varX += dx * dx;
    }
    const slope = varX === 0 ? 0 : cov / varX;
    const intercept = meanY - slope * meanX;

    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
        const pred = slope * x[i] + intercept;
        const dy = y[i] - pred;
        ssRes += dy * dy;
        const dMean = y[i] - meanY;
        ssTot += dMean * dMean;
    }
    const r2 = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);
    return { slope, intercept, r2 };
}

async function loadTextFromStoragePath(path) {
    if (!path) throw new Error('Missing storage path.');
    const url = await getDownloadURL(ref(storage, path));
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Cannot load file: HTTP ${resp.status}`);
    return resp.text();
}

async function ensureProgressionDatasetLoaded() {
    if (progressionDataset.loaded) return progressionDataset;
    if (progressionDataset.loadingPromise) return progressionDataset.loadingPromise;

    progressionDataset.loadingPromise = (async () => {
        const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath;
        const metaPath = projectData?.metaCheckedPath;
        if (!matrixPath || !metaPath) {
            throw new Error('Missing matrixNormPath/metaCheckedPath for progression.');
        }

        const [matrixText, metaText] = await Promise.all([
            loadTextFromStoragePath(matrixPath),
            loadTextFromStoragePath(metaPath)
        ]);

        const matrixParsed = parseCsv(matrixText);
        const metaParsed = parseCsv(metaText);

        if (matrixParsed.header.length < 2 || metaParsed.header.length < 2) {
            throw new Error('Invalid matrix/meta CSV format.');
        }

        const sampleIds = matrixParsed.header.slice(1);
        const matrixRows = new Map();
        matrixParsed.rows.forEach((row) => {
            const feature = String(row[0] ?? '').trim();
            if (!feature) return;
            const values = row.slice(1).map(toFiniteNumberOrNull);
            matrixRows.set(feature, values);
        });

        const metaCols = metaParsed.header.slice(1);
        const metaBySample = new Map();
        metaParsed.rows.forEach((row) => {
            const sampleId = String(row[0] ?? '').trim();
            if (!sampleId) return;
            const obj = {};
            metaCols.forEach((col, idx) => {
                obj[col] = row[idx + 1];
            });
            metaBySample.set(sampleId, obj);
        });

        progressionDataset.sampleIds = sampleIds;
        progressionDataset.matrixRows = matrixRows;
        progressionDataset.metaBySample = metaBySample;
        progressionDataset.loaded = true;
        return progressionDataset;
    })();

    try {
        return await progressionDataset.loadingPromise;
    } finally {
        progressionDataset.loadingPromise = null;
    }
}

function warmupProgressionDataset() {
    if (progressionDataset.loaded || progressionDataset.loadingPromise) return;
    ensureProgressionDatasetLoaded().catch((error) => {
        console.warn('Progression dataset warmup failed:', error);
    });
}

function buildProgressionTrendFrontend(featureName, targetMeta, encodingMap = {}) {
    const values = progressionDataset.matrixRows.get(featureName);
    if (!values) {
        throw new Error(`Feature '${featureName}' not found in matrix.`);
    }

    const pointsRaw = [];
    progressionDataset.sampleIds.forEach((sampleId, idx) => {
        const abundance = values[idx];
        if (abundance === null) return;
        const metaObj = progressionDataset.metaBySample.get(sampleId);
        if (!metaObj || !(targetMeta in metaObj)) return;
        const rawStage = metaObj[targetMeta];
        if (isMissingMeta(rawStage)) return;
        pointsRaw.push({ sample: sampleId, abundance, target_raw: rawStage });
    });

    if (!pointsRaw.length) {
        throw new Error('No overlap samples after filtering missing values.');
    }

    const conf = encodingMap?.[targetMeta] || { type: 'continuous' };
    const points = [];

    if (conf.type === 'ordinal') {
        const order = Array.isArray(conf.order) ? conf.order.map((v) => String(v)) : [];
        const mapping = new Map(order.map((label, i) => [label, i]));
        pointsRaw.forEach((p) => {
            const label = String(p.target_raw);
            if (!mapping.has(label)) return;
            points.push({
                sample: p.sample,
                stage_code: mapping.get(label),
                stage_label: label,
                abundance: p.abundance,
            });
        });
    } else {
        const numericCount = pointsRaw.reduce((acc, p) => acc + (toFiniteNumberOrNull(p.target_raw) !== null ? 1 : 0), 0);
        if (numericCount >= 3) {
            pointsRaw.forEach((p) => {
                const num = toFiniteNumberOrNull(p.target_raw);
                if (num === null) return;
                points.push({
                    sample: p.sample,
                    stage_code: num,
                    stage_label: String(p.target_raw),
                    abundance: p.abundance,
                });
            });
        } else {
            const uniq = [...new Set(pointsRaw.map((p) => String(p.target_raw)))];
            const mapping = new Map(uniq.map((label, i) => [label, i]));
            pointsRaw.forEach((p) => {
                const label = String(p.target_raw);
                points.push({
                    sample: p.sample,
                    stage_code: mapping.get(label),
                    stage_label: label,
                    abundance: p.abundance,
                });
            });
        }
    }

    if (!points.length) {
        throw new Error('No valid stage/lipid data available.');
    }

    const stageCodes = [...new Set(points.map((p) => Number(p.stage_code)))].sort((a, b) => a - b);
    const stages = stageCodes.map((code) => {
        const rows = points.filter((p) => Number(p.stage_code) === code);
        return {
            code,
            label: String(rows[0]?.stage_label ?? code),
            n: rows.length,
        };
    });

    const x = points.map((p) => Number(p.stage_code));
    const y = points.map((p) => Number(p.abundance));
    const regression = fitLinearTrend(x, y);

    return {
        lipid: featureName,
        target_meta: targetMeta,
        points,
        stages,
        regression,
    };
}

function getProgressionCacheKey(featureName, analysis) {
    const runId = analysis?.run_id || selectedHistoryRunId || 'adhoc';
    return `${runId}::${String(featureName || '').trim()}`;
}

async function loadProgressionCache(featureName, analysis) {
    const path = getProgressionCachePath(featureName, analysis);
    try {
        const url = await getDownloadURL(ref(storage, path));
        const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return null;
        const payload = await resp.json();
        return payload?.data || payload || null;
    } catch {
        return null;
    }
}

async function saveProgressionCache(featureName, analysis, trendData) {
    if (!trendData) return;
    const path = getProgressionCachePath(featureName, analysis);
    try {
        const payload = JSON.stringify({ data: trendData, cached_at: Date.now() });
        await uploadString(ref(storage, path), payload, 'raw', { contentType: 'application/json' });
    } catch (err) {
        console.warn('Cannot write progression cache to local storage:', err);
    }
}

function resetOlsProgressionPanel(message = 'Click one feature in OLS result table to visualize progression.') {
    const visualPanel = getOlsVisualPanel();
    if (!visualPanel) return;
    visualPanel.innerHTML = message;
    visualPanel.className = 'border rounded bg-light d-flex align-items-center justify-content-center text-muted small';
}

function setRunStatus(step, message = "", tone = "") {
    const map = {
        ols: document.getElementById('ols-run-status'),
        corr: document.getElementById('corr-run-status'),
        roc: document.getElementById('roc-run-status')
    };
    const el = map[step];
    if (!el) return;
    el.textContent = message;
    el.classList.remove('error', 'success');
    if (tone === 'error') el.classList.add('error');
    if (tone === 'success') el.classList.add('success');
}

function syncBiomarkerTaskStatusUi(step, task) {
    if (!task?.run_id) return;
    const status = normalizeBiomarkerStatus(task.status);
    const name = task.name || step.toUpperCase();
    if (status === 'pending') {
        setRunStatus(step, `${name} is pending...`);
        return;
    }
    if (status === 'running') {
        setRunStatus(step, `${name} is running...`);
        return;
    }
    if (status === 'error') {
        setRunStatus(step, task.message || `${name} failed.`, 'error');
        return;
    }
    setRunStatus(step, task.message || `${name} completed.`, 'success');
}

function setConfigInteractionLocked(locked) {
    return locked;
}

function beginRun() {
    activeRunCount += 1;
    setConfigInteractionLocked(true);
}

function endRun() {
    activeRunCount = Math.max(0, activeRunCount - 1);
    if (activeRunCount === 0) {
        setConfigInteractionLocked(false);
    }
}

function waitForProjectDoc(predicate, timeoutMs = TASK_STALE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let unsubscribe = null;
        const timeout = setTimeout(() => {
            if (unsubscribe) unsubscribe();
            reject(new Error('Timed out waiting for analysis result.'));
        }, timeoutMs);

        unsubscribe = onSnapshot(doc(db, "projects", projectId), (snap) => {
            const d = snap.data() || {};
            const outcome = predicate(d);
            if (!outcome?.done) return;
            clearTimeout(timeout);
            if (unsubscribe) unsubscribe();
            if (outcome.error) reject(new Error(outcome.error));
            else resolve(d);
        }, (err) => {
            clearTimeout(timeout);
            if (unsubscribe) unsubscribe();
            reject(err);
        });
    });
}

function waitForBiomarkerTaskCompletion(step, taskRunId, timeoutMs = TASK_STALE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let unsubscribe = null;
        const timeout = setTimeout(() => {
            if (unsubscribe) unsubscribe();
            reject(new Error(`Task timed out after ${Math.floor(timeoutMs / 60000)} minutes without completion.`));
        }, timeoutMs);

        unsubscribe = onSnapshot(doc(db, "projects", projectId), (snap) => {
            const d = snap.data() || {};
            
            // Check for stale task (stuck >180 min without heartbeat)
            const task = d[`biomarker_${step}_task`] || null;
            if (task?.run_id === taskRunId && isTaskStale(task)) {
                clearTimeout(timeout);
                if (unsubscribe) unsubscribe();
                const message = `Task timed out after 180 minutes without backend heartbeat. Click history delete to remove.`;
                syncBiomarkerTaskStatusUi(step, { ...task, status: 'error', message });
                return; // Keep listening for manual deletion
            }
            
            // Update UI with current task status
            if (task?.run_id === taskRunId) {
                syncBiomarkerTaskStatusUi(step, task);
            }
            
            // Check for completion (done or error)
            const status = task?.run_id === taskRunId ? normalizeBiomarkerStatus(task?.status) : null;
            if (status === 'done') {
                clearTimeout(timeout);
                if (unsubscribe) unsubscribe();
                return resolve(d);
            }
            if (status === 'error') {
                clearTimeout(timeout);
                if (unsubscribe) unsubscribe();
                return reject(new Error(task?.message || `${step.toUpperCase()} analysis failed.`));
            }
            
            // Also check legacy status fields as fallback
            const legacyStatusField = step === 'ols' ? 'ols_status' : step === 'corr' ? 'corr_status' : 'roc_status';
            if (d[legacyStatusField] === 'done') {
                clearTimeout(timeout);
                if (unsubscribe) unsubscribe();
                return resolve(d);
            }
            if (d[legacyStatusField] === 'error') {
                clearTimeout(timeout);
                if (unsubscribe) unsubscribe();
                const msgField = step === 'roc' ? 'roc_error_msg' : step === 'corr' ? 'corr_error_msg' : 'message';
                return reject(new Error(d[msgField] || `${step.toUpperCase()} analysis failed.`));
            }
        }, (err) => {
            clearTimeout(timeout);
            if (unsubscribe) unsubscribe();
            reject(err);
        });
    });
}

const dom = {
    rocHistoryToggle: () => document.getElementById('roc-history-toggle'),
    rocHistoryPopup: () => document.getElementById('roc-history-popup'),
    corrHistoryToggle: () => document.getElementById('corr-history-toggle'),
    corrHistoryPopup: () => document.getElementById('corr-history-popup')
};

// RAM cache for corr results — avoid re-fetching GCS on every history click
const corrMemoryCache = { runId: null, data: null };
let corrRawData = [];
let currentCorrDisplayKey = '__best__';

function isContinuousLikeMeta(meta) {
    if (!meta) return false;
    if (String(meta.type || '').trim().toLowerCase() === 'continuous') return true;

    const groups = Array.isArray(meta.groups) ? meta.groups : [];
    const cleaned = groups
        .map((value) => String(value ?? '').trim())
        .filter((text) => text && text.toLowerCase() !== 'nan');
    if (!cleaned.length) return false;

    const numericValues = [];
    let hasDecimalLike = false;
    for (const text of cleaned) {
        const numeric = Number(text);
        if (!Number.isFinite(numeric)) return false;
        numericValues.push(numeric);
        if (text.includes('.') || /e/i.test(text)) hasDecimalLike = true;
    }

    if (hasDecimalLike) return true;
    return new Set(numericValues.map((value) => String(value))).size > 5;
}

function isCategoricalLikeMeta(meta) {
    return !isContinuousLikeMeta(meta);
}

onAuthStateChanged(auth, async (user) => {
    if (user && projectId) {
        await injectSidebar(user.uid);
        await initBiomarkerSetup();
        setupTabNavigation();
        document.body.classList.add('loaded');
    }
});

async function initBiomarkerSetup() {
    const snap = await getDoc(doc(db, "projects", projectId));
    projectData = snap.data();
    if (window.renderNormSummary) window.renderNormSummary(projectData?.norm_settings, projectData?.normality_stat);
    modalEnc = new bootstrap.Modal(document.getElementById('modalEncoding'));

    // Load history
    analysisHistory = projectData.biomarker_history || [];
    renderAnalysisHistory();

    const targetSelect = document.getElementById('ols-target');
    const olsCovList = document.getElementById('ols-covariates-list');
    const corrMetaList = document.getElementById('corr-meta-list');
    const corrOlsInput = document.getElementById('corr-ols-input');
    const rocTargetSelect = document.getElementById('roc-target');
    const rocOlsInput = document.getElementById('roc-ols-input');
    const rocComparisonsList = document.getElementById('roc-comparisons-list');

    // Nạp Metadata
    rocTargetSelect.innerHTML = '<option value="">-- Select --</option>';
    projectData.meta_metadata.forEach((m, idx) => {
        targetSelect.innerHTML += `<option value="${m.name}">${m.name}</option>`;
        const isCat = isCategoricalLikeMeta(m);
        const safeName = makeSafeId(m.name);
        const itemHtml = (step) => `
            <div class="meta-item">
                <div class="d-flex align-items-center">
                    <input id="${step}-check-${safeName}-${idx}" class="form-check-input ${step}-check me-2" type="checkbox" value="${m.name}">
                    <label for="${step}-check-${safeName}-${idx}" class="mb-0" style="cursor:pointer;">
                        <div class="small fw-bold">${m.name}</div>
                        <div id="badge-${step}-${safeName}" class="badge-status ${isCat ? 'bg-warning text-dark' : 'bg-success text-white'} extra-small">${isCat ? 'Required Encode' : 'Ready'}</div>
                    </label>
                </div>
                <button class="btn btn-sm btn-link extra-small btn-open-enc" data-var="${m.name}"><i class="fa-solid fa-gear"></i> Encode</button>
            </div>`;
        olsCovList.innerHTML += itemHtml('cov');
        corrMetaList.innerHTML += itemHtml('corr');
        if (isCat) rocTargetSelect.innerHTML += `<option value="${m.name}">${m.name}</option>`;
    });

    // Numeric metadata columns available as clinical covariates for ROC panels
    const rocClinicalList = document.getElementById('roc-clinical-list');
    if (rocClinicalList) {
        rocClinicalList.innerHTML = projectData.meta_metadata
            .filter((m) => !isCategoricalLikeMeta(m))
            .map((m) => `<div class="form-check"><input class="form-check-input roc-clin-check" type="checkbox" value="${m.name}" id="roc-clin-${makeSafeId(m.name)}"><label class="form-check-label extra-small" for="roc-clin-${makeSafeId(m.name)}">${m.name}</label></div>`)
            .join('') || '<div class="extra-small text-muted">No numeric metadata column found.</div>';
    }

    targetSelect.onchange = () => {
        const val = targetSelect.value;
        document.querySelectorAll('#ols-covariates-list .meta-item').forEach(item => {
            const cb = item.querySelector('.cov-check');
            if (cb.value === val) { cb.checked = false; item.classList.add('disabled'); }
            else { item.classList.remove('disabled'); }
        });
        updateTargetStatusUI();
        validateOlsForm();
    };
    targetSelect.dispatchEvent(new Event('change'));

    populateOlsInputSelectors();
    corrOlsInput.onchange = () => {
        syncOlsInputLocks();
    };
    rocOlsInput.onchange = () => {
        syncOlsInputLocks();
    };
    syncOlsInputLocks();

    rocTargetSelect.onchange = () => {
        const val = rocTargetSelect.value;
        if (!val) { rocComparisonsList.innerHTML = ''; validateRocForm(); return; }
        const meta = projectData.meta_metadata.find(m => m.name === val);
        const groups = [...new Set(meta.groups.filter(g => g !== null && String(g).toLowerCase() !== 'nan'))];
        if (groups.length < 2) { rocComparisonsList.innerHTML = '<div class="text-danger small">Need ≥2 classes</div>'; validateRocForm(); return; }

        let html = '<div class="small fw-bold mb-2 text-primary">One-vs-Rest:</div>';
        groups.forEach(g => {
            html += `<div class="form-check"><input class="form-check-input roc-comp-check" type="radio" name="roc-comparison" value="${g} vs Rest" id="roc-${g}-rest"><label class="form-check-label small" for="roc-${g}-rest">${g} vs Rest</label></div>`;
        });
        html += '<div class="small fw-bold mb-2 mt-3 text-primary">Pairwise:</div>';
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const comp = `${groups[i]} vs ${groups[j]}`;
                html += `<div class="form-check"><input class="form-check-input roc-comp-check" type="radio" name="roc-comparison" value="${comp}" id="roc-${groups[i]}-${groups[j]}"><label class="form-check-label small" for="roc-${groups[i]}-${groups[j]}">${comp}</label></div>`;
            }
        }
        rocComparisonsList.innerHTML = html;
        validateRocForm();
    };

    document.addEventListener('change', e => {
        if (e.target.classList.contains('cov-check')) validateOlsForm();
        if (e.target.classList.contains('corr-check')) validateCorrForm();
        if (e.target.classList.contains('roc-comp-check')) validateRocForm();
    });
    document.getElementById('btn-config-target').onclick = () => openEncodingModal(targetSelect.value);
    document.addEventListener('click', e => {
        const btn = e.target.closest('.btn-open-enc');
        if (btn) openEncodingModal(btn.dataset.var);
    });

    bindRocHistoryEvents();
    bindCorrHistoryEvents();
    // Warm up matrix/meta in background so progression clicks are instant.
    warmupProgressionDataset();

    // Live-update project metadata after KMeans save or any other metadata edits
    onSnapshot(doc(db, "projects", projectId), async (snap) => {
        const d = snap.data() || {};
        if (await expireStaleBiomarkerTask('ols', d.biomarker_ols_task || null)) return;
        if (await expireStaleBiomarkerTask('corr', d.biomarker_corr_task || null)) return;
        if (await expireStaleBiomarkerTask('roc', d.biomarker_roc_task || null)) return;

        if (JSON.stringify(d.meta_metadata) !== JSON.stringify(projectData.meta_metadata)) {
            projectData = { ...projectData, meta_metadata: d.meta_metadata || [] };
            const targetSelect = document.getElementById('ols-target');
            const currentTarget = targetSelect?.value || '';
            if (targetSelect) {
                targetSelect.innerHTML = '';
                (projectData.meta_metadata || []).forEach((m) => {
                    targetSelect.innerHTML += `<option value="${m.name}">${m.name}</option>`;
                });
                if (currentTarget && (projectData.meta_metadata || []).some((m) => m.name === currentTarget)) {
                    targetSelect.value = currentTarget;
                }
                targetSelect.dispatchEvent(new Event('change'));
            }
            const rocTargetSelect = document.getElementById('roc-target');
            const currentRocTarget = rocTargetSelect?.value || '';
            if (rocTargetSelect) {
                rocTargetSelect.innerHTML = '<option value="">-- Select --</option>';
                (projectData.meta_metadata || []).forEach((m) => {
                    if (isCategoricalLikeMeta(m)) {
                        rocTargetSelect.innerHTML += `<option value="${m.name}">${m.name}</option>`;
                    }
                });
                if (currentRocTarget && (projectData.meta_metadata || []).some((m) => m.name === currentRocTarget && isCategoricalLikeMeta(m))) {
                    rocTargetSelect.value = currentRocTarget;
                }
            }
        }

        projectData = { ...projectData, ...d };
        analysisHistory = deduplicateHistory(d.biomarker_history || analysisHistory);
        renderAnalysisHistory();
        populateOlsInputSelectors();
        syncOlsInputLocks();
        syncBiomarkerTaskStatusUi('ols', d.biomarker_ols_task || null);
        syncBiomarkerTaskStatusUi('corr', d.biomarker_corr_task || null);
        syncBiomarkerTaskStatusUi('roc', d.biomarker_roc_task || null);
    });
}

// ==================== HISTORY ====================

function makeSafeId(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_');
}

function ensureHistoryRunId(item, index = 0) {
    if (item?.run_id) return String(item.run_id);
    const seed = `${item?.analysis_type || 'legacy'}_${item?.name || 'analysis'}_${item?.date || ''}_${index}`;
    return `legacy_${makeSafeId(seed)}`;
}

function deduplicateHistory(history) {
    const seen = new Set();
    return (history || []).map((item, index) => ({
        ...item,
        run_id: ensureHistoryRunId(item, index),
        status: normalizeBiomarkerStatus(item?.status)
    })).filter(item => {
        const key = item.run_id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function expireStaleBiomarkerTask(step, task) {
    if (!task?.run_id || !isTaskStale(task) || staleBiomarkerRunId === task.run_id) return false;

    staleBiomarkerRunId = task.run_id;
    const message = 'Task timed out after 180 minutes without backend heartbeat.';
    const nowIso = new Date().toISOString();
    const taskField = getBiomarkerTaskField(step);
    const legacyStatusField = step === 'ols' ? 'ols_status' : step === 'corr' ? 'corr_status' : 'roc_status';
    const legacyMessageField = step === 'roc' ? 'roc_error_msg' : step === 'corr' ? 'corr_error_msg' : 'message';
    const nextTask = {
        ...task,
        status: 'error',
        message,
        completed_at: nowIso,
        updated_at: nowIso,
    };
    const fallbackEntry = getHistoryByRunId(task.run_id) || buildTaskFallbackEntry(task) || {
        run_id: task.run_id,
        task_id: task.task_id ?? null,
        analysis_type: step,
        name: task.name || 'Untitled',
        date: task.started_at || nowIso,
    };
    const errorEntry = {
        ...fallbackEntry,
        status: 'error',
        message,
        date: fallbackEntry.date || task.started_at || nowIso,
    };
    const nextHistory = deduplicateHistory([
        errorEntry,
        ...analysisHistory.filter((item) => item.run_id !== task.run_id),
    ]);

    try {
        await updateDoc(doc(db, 'projects', projectId), {
            [taskField]: nextTask,
            biomarker_history: nextHistory,
            [legacyStatusField]: 'error',
            [legacyMessageField]: message,
        });
        analysisHistory = nextHistory;
        renderAnalysisHistory();
    } catch (error) {
        console.error(`Failed to expire stale biomarker ${step} task:`, error);
    } finally {
        staleBiomarkerRunId = null;
    }

    return true;
}

function getHistoryByStep(step) {
    if (step === 'corr') {
        return analysisHistory.filter(item => item.analysis_type === 'corr' || item.corr_html_url);
    }
    if (step === 'roc') {
        return analysisHistory.filter(item => item.analysis_type === 'roc' || item.roc_results || item.roc_results_url);
    }
    return analysisHistory.filter((item) => isOlsHistoryItem(item));
}

function getHistoryByRunId(runId) {
    if (!runId) return null;
    return analysisHistory.find(item => item.run_id === runId) || null;
}

function getLatestHistoryByType(type) {
    return getHistoryByStep(type)[0] || null;
}

function collectHistoryEntryUrls(entry) {
    if (!entry) return [];
    return [entry.ols_results_url, entry.ols_csv_url, entry.corr_html_url,entry.corr_results_url, entry.corr_csv_url, entry.roc_csv_url, entry.roc_results_url].filter(Boolean);
}

async function deleteStorageArtifacts(urls) {
    const uniqueUrls = [...new Set((urls || []).filter(Boolean))];
    if (!uniqueUrls.length) return;
    try {
        await fetch(`${vpsUrl}/storage/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: uniqueUrls })
        });
    } catch (error) {
        console.error('Failed to delete storage artifacts:', error);
    }
}

function buildBiomarkerProjectState() {
    const latestOls = getLatestHistoryByType('ols');
    const latestCorr = getLatestHistoryByType('corr');
    const latestRoc = getLatestHistoryByType('roc');
    return {
        biomarker_history: analysisHistory.length ? analysisHistory : null,
        ols_results: deleteField(),
        ols_results_url: latestOls?.ols_results_url || deleteField(),
        ols_csv_url: latestOls?.ols_csv_url || deleteField(),
        ols_sample_info: latestOls?.ols_sample_info || deleteField(),
        corr_results: deleteField(),
        corr_html_url: latestCorr?.corr_html_url || deleteField(),
        corr_csv_url: latestCorr?.corr_csv_url || deleteField(),
        roc_results: deleteField(),
        roc_results_url: latestRoc?.roc_results_url || deleteField(),
        roc_csv_url: latestRoc?.roc_csv_url || deleteField()
    };
}

function buildRocSummary(rows) {
    return (rows || []).map((r) => ({
        lipid: r.lipid,
        comparison: r.comparison,
        auc: toSafeNum(r.auc),
        cutoff: toSafeNum(r.cutoff),
        sensitivity: toSafeNum(r.sensitivity),
        specificity: toSafeNum(r.specificity),
    }));
}

async function compactBiomarkerHistory(history) {
    const output = [];
    for (const item of (history || [])) {
        const out = { ...item };
        if (isOlsHistoryItem(out)) {
            Object.assign(out, await uploadOlsHistoryResultsToStorage(out));
        }
        if (out.analysis_type === 'roc' || out.roc_results || out.roc_results_url) {
            if (Array.isArray(out.roc_results) && out.roc_results.length) {
                out.roc_results = buildRocSummary(out.roc_results).slice(0, 500);
            } else {
                out.roc_results = null;
            }
        }
        output.push(out);
    }
    return output;
}

async function saveBiomarkerHistory() {
    analysisHistory = await compactBiomarkerHistory(deduplicateHistory(analysisHistory));
    await updateDoc(doc(db, "projects", projectId), { biomarker_history: analysisHistory });
}

function sanitizeHtmlText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function setRocLoadingState(message = 'Loading ROC results...') {
    const tableBody = document.querySelector('#roc-table tbody');
    const rowCount = document.getElementById('roc-row-count');
    const plot = document.getElementById('roc-plot');

    window.rocResults = null;
    window.rocResultsFull = null;
    rocResultsSourceKey = null;
    if (rowCount) rowCount.innerText = '0 rows';
    if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="6" class="py-3 text-muted"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${sanitizeHtmlText(message)}</td></tr>`;
    }
    if (plot) {
        try { Plotly.purge('roc-plot'); } catch { }
        plot.innerHTML = `<div class="h-100 d-flex align-items-center justify-content-center text-muted"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${sanitizeHtmlText(message)}</div>`;
    }
}

function clearRocLoadingIndicators() {
    const tableBody = document.querySelector('#roc-table tbody');
    const plot = document.getElementById('roc-plot');
    if (tableBody) {
        tableBody.querySelectorAll('.spinner-border, .fa-spin').forEach((node) => node.remove());
    }
    if (plot && plot.querySelector('.spinner-border, .fa-spin')) {
        plot.innerHTML = '';
    }
}

function setRocEmptyState(message = 'No ROC results available.') {
    const plot = document.getElementById('roc-plot');
    if (plot) {
        try { Plotly.purge('roc-plot'); } catch { }
        plot.innerHTML = `<div class="h-100 d-flex align-items-center justify-content-center text-muted">${sanitizeHtmlText(message)}</div>`;
    }
}

async function fetchRocResultsFromUrl(url) {
    if (!url) return [];
    const maxRetries = 3;
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
        try {
            const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`Cannot load ROC results file (HTTP ${resp.status}).`);
            const text = await resp.text();
            const payload = JSON.parse(text);
            if (Array.isArray(payload)) return payload;
            if (Array.isArray(payload.results)) return payload.results;
            return [];
        } catch (e) {
            lastErr = e;
            console.error(`fetchRocResultsFromUrl attempt ${attempt + 1} failed:`, e.message, 'URL:', url);
        }
    }
    throw lastErr;
}

// Panel payloads live in the SAME JSON but were stripped by the legacy
// fetcher above; fetch them separately (small extra request, no-cache).
async function fetchRocPanelsFromUrl(url) {
    if (!url) return [];
    try {
        const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return [];
        const payload = JSON.parse(await resp.text());
        return Array.isArray(payload?.panels) ? payload.panels : [];
    } catch (e) {
        console.warn('fetchRocPanelsFromUrl failed:', e);
        return [];
    }
}

async function ensureRocFullResults(source) {
    const sourceKey = source?.run_id || source?.roc_results_url || source?.name || null;
    if (rocResultsSourceKey && sourceKey && rocResultsSourceKey === sourceKey && window.rocResultsFull && window.rocResultsFull.length) {
        return window.rocResultsFull;
    }
    if (!source?.roc_results_url) return Array.isArray(source?.roc_results) ? source.roc_results : [];
    try {
        const full = await fetchRocResultsFromUrl(source.roc_results_url);
        window.rocResultsFull = full;
        rocResultsSourceKey = sourceKey;
        return full;
    } catch (e) {
        console.error('Failed to load full ROC results from URL:', e);
        // Do NOT cache a failed fetch — allows retry on next call
        return Array.isArray(source?.roc_results) ? source.roc_results : [];
    }
}

function getOlsHistoryEntries() {
    return analysisHistory.filter((item) => isOlsHistoryItem(item));
}

function populateOlsInputSelectors() {
    const corrSelect = document.getElementById('corr-ols-input');
    const rocSelect = document.getElementById('roc-ols-input');
    if (!corrSelect || !rocSelect) return;

    const olsEntries = getOlsHistoryEntries();
    const options = ['<option value="">— All features —</option>']
        .concat(olsEntries.map(item => `<option value="${item.run_id}">${item.name} (${new Date(item.date).toLocaleString()})</option>`))
        .join('');

    corrSelect.innerHTML = options;
    rocSelect.innerHTML = options;

    const corrExists = olsEntries.some(item => item.run_id === selectedCorrOlsRunId);
    const rocExists = olsEntries.some(item => item.run_id === selectedRocOlsRunId);

    corrSelect.value = corrExists ? selectedCorrOlsRunId : '';
    rocSelect.value = rocExists ? selectedRocOlsRunId : '';

    selectedCorrOlsRunId = corrSelect.value;
    selectedRocOlsRunId = rocSelect.value;
}

function syncOlsInputLocks() {
    const corrSelect = document.getElementById('corr-ols-input');
    const rocSelect = document.getElementById('roc-ols-input');
    const corrFields = document.getElementById('corr-config-fields');
    const rocFields = document.getElementById('roc-config-fields');
    if (!corrSelect || !rocSelect || !corrFields || !rocFields) return;

    selectedCorrOlsRunId = corrSelect.value;
    selectedRocOlsRunId = rocSelect.value;

    corrFields.disabled = false;
    rocFields.disabled = false;

    document.getElementById('corr-ols-input-msg').innerText = selectedCorrOlsRunId
        ? 'Using significant OLS features (FDR < 0.05).'
        : 'No OLS selected — will run on all matrix features.';
    document.getElementById('roc-ols-input-msg').innerText = selectedRocOlsRunId
        ? 'Using significant OLS features (FDR < 0.05).'
        : 'No OLS selected — will run on all matrix features.';

    validateCorrForm();
    validateRocForm();
}

function buildHistoryConfigText(item) {
    const type = item.analysis_type || (item.roc_results || item.roc_results_url ? 'roc' : item.corr_html_url ? 'corr' : 'ols');
    let parts = [];
    if (type === 'ols') {
        parts.push(`Target: ${item.target || '-'}; Covariates: ${(item.covariates || []).join(', ') || '-'}`);
    }
    if (type === 'corr') {
        const rankMap = { fdr: 'p', adj_r2: 'R²', beta: 'β' };
        const rankLabel = rankMap[item.corr_sort_by] || item.corr_sort_by || 'p';
        const methodLabel = getCorrMethodLabel(item.corr_method);
        parts.push(`Method: ${methodLabel}; Source OLS: ${item.source_ols_name || item.source_ols_run_id || '-'}; ${item.corr_top_n || '?'}-${rankLabel}; Clin Meta: ${(item.clinical_vars || []).join(', ') || '-'}`);
    }
    if (type === 'roc') {
        parts.push(`Source OLS: ${item.source_ols_name || item.source_ols_run_id || '-'}; ROC: ${item.roc_target || '-'} / ${(item.roc_comparisons || []).join(', ') || '-'}`);
    }
    return parts.join('; ');
}

function escapeHtmlAttr(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getResidualNormalitySummary(item) {
    const check = item?.residual_normality_check;
    if (!check || typeof check !== 'object') return null;
    const tested = Number(check.tested);
    const failed = Number(check.n_failed ?? check.failed);
    const failedPct = Number(check.failed_pct);
    const isWarning = Boolean(check.warning) || (Number.isFinite(failedPct) && failedPct > 50);
    return {
        tested: Number.isFinite(tested) ? tested : null,
        failed: Number.isFinite(failed) ? failed : null,
        failedPct: Number.isFinite(failedPct) ? failedPct : null,
        isWarning
    };
}

function getVifSummary(item) {
    const vifWarnings = item?.vif_warnings;
    if (!vifWarnings || typeof vifWarnings !== 'object') return null;
    const entries = Object.entries(vifWarnings)
        .map(([name, value]) => [name, Number(value)])
        .filter(([, value]) => Number.isFinite(value));
    if (!entries.length) return null;
    const highEntries = entries.filter(([, value]) => value > 10);
    const maxEntry = entries.reduce((best, cur) => cur[1] > best[1] ? cur : best, entries[0]);
    return {
        highEntries,
        maxName: maxEntry[0],
        maxValue: maxEntry[1],
        hasWarning: highEntries.length > 0
    };
}

function buildOlsDiagnosticsTooltip(item) {
    if (!isOlsHistoryItem(item)) return '';
    const residual = getResidualNormalitySummary(item);
    const vif = getVifSummary(item);
    const lines = [];
    if (residual) {
        const testedText = residual.tested ?? '-';
        const failedPctText = residual.failedPct != null ? `${residual.failedPct.toFixed(1)}%` : '-';
        const failedCountText = residual.failed != null ? ` (${residual.failed}/${testedText})` : '';
        lines.push(residual.isWarning
            ? `Residual normality: WARNING — ${failedPctText} of all features failed Shapiro-Wilk (p<0.05)${failedCountText}`
            : `Residual normality: OK — ${failedPctText} failed Shapiro-Wilk, tested=${testedText}${failedCountText}`);
    }
    if (vif) {
        // Luôn luôn hiển thị toàn bộ VIF
        const allVif = Object.entries(item?.vif_warnings || {})
            .map(([name, value]) => `${name}=${Number(value).toFixed(2)}`)
            .join(', ');
        lines.push(`VIF: ${allVif}`);
    }
    return lines.join('\n');
}

function renderOlsDiagnosticsIcons(item) {
    if (!isOlsHistoryItem(item)) return '';
    const residual = getResidualNormalitySummary(item);
    const vif = getVifSummary(item);
    let html = '';
    if (residual?.isWarning) {
        const failedDetail = residual.failedPct != null ? `${residual.failedPct.toFixed(1)}% of all features failed Shapiro-Wilk (p<0.05)` + (residual.failed != null ? ` (${residual.failed}/${residual.tested})` : '') : '';
        const tip = escapeHtmlAttr(`Residual normality: WARNING\n${failedDetail}`);
        html += `<span class="text-warning" title="${tip}" style="cursor:default;"><i class="fa-solid fa-triangle-exclamation"></i></span>`;
    }
    if (vif?.hasWarning) {
        const offenders = vif.highEntries.map(([name, value]) => `${name}=${value.toFixed(2)}`).join(', ');
        const tip = escapeHtmlAttr(`VIF > 10: ${offenders}`);
        html += `<span class="text-danger ms-1" title="${tip}" style="cursor:default;"><i class="fa-solid fa-circle-exclamation"></i><span class="extra-small ms-1">VIF</span></span>`;
    }
    return html;
}

function buildRocTooltipText(item) {
    return [
        `Analysis: ${item.name || '-'}`,
        `Source OLS: ${item.source_ols_name || item.source_ols_run_id || '-'}`,
        `Target Metadata: ${item.roc_target || '-'}`,
        `Comparisons: ${(item.roc_comparisons || []).join(', ') || '-'}`,
        `Date: ${item.date ? new Date(item.date).toLocaleString() : '-'}`
    ].join('\n');
}

function renderAnalysisHistory() {
    analysisHistory = deduplicateHistory(analysisHistory);
    const container = document.getElementById('analysis-history');
    const visibleHistory = getHistoryByStep(currentStep);
    if (visibleHistory.length === 0) {
        container.innerHTML = '<div class="text-muted small">No history for this tab yet.</div>';
        updateDeleteButtons();
        return;
    }

    container.innerHTML = visibleHistory.map((item) => {
        const type = item.analysis_type || (item.roc_results || item.roc_results_url ? 'roc' : item.corr_html_url ? 'corr' : 'ols');
        const stepsHtml = type === 'ols'
            ? '<span class="badge bg-primary me-1">OLS</span>'
            : type === 'corr'
                ? '<span class="badge bg-success me-1">Corr</span>'
                : '<span class="badge bg-danger me-1">ROC</span>';
        const runId = item.run_id || '';
        const status = normalizeBiomarkerStatus(item.status);
        const diagTooltip = escapeHtmlAttr(buildOlsDiagnosticsTooltip(item));
        const diagIcons = renderOlsDiagnosticsIcons(item);
        return `
        <div class="history-item ${selectedHistoryRunId && runId === selectedHistoryRunId ? 'active' : ''}" data-run-id="${runId}" ${diagTooltip ? `title="${diagTooltip}"` : ''}>
            <div class="d-flex justify-content-between align-items-start">
                <div class="form-check">
                    <input class="form-check-input history-checkbox" type="checkbox" value="${runId}" id="bm-check-${makeSafeId(runId)}">
                    <label class="form-check-label fw-bold" for="bm-check-${makeSafeId(runId)}">${item.name}</label>
                </div>
                <div class="d-flex align-items-center gap-1">
                    <small class="text-muted">${new Date(item.date).toLocaleDateString()}</small>
                    <button class="btn btn-outline-danger btn-sm py-0 px-1 history-delete-single" data-run-id="${runId}" title="Delete" style="font-size:0.65rem; line-height:1;">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
            <div class="history-config">${buildHistoryConfigText(item)}</div>
            <div class="history-steps d-flex align-items-center gap-2 flex-wrap">${stepsHtml}${getTaskStatusBadge(status)}<span class="small text-muted">${formatTaskId(item) || 'No ID'}</span>${diagIcons}</div>
            <div class="history-config">${item.message || (status === 'done' ? 'Ready to open.' : status === 'error' ? 'Run failed.' : status === 'pending' ? 'Queued for processing.' : 'Task is running...')}</div>
        </div>`;
    }).join('');

    document.querySelectorAll('.history-item').forEach(item => {
        item.onclick = (e) => {
            if (e.target.type === 'checkbox') return;
            const runId = item.dataset.runId;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            if (status === 'pending' || status === 'running') return;
            if (status === 'error') {
                setRunStatus(entry.analysis_type || currentStep, entry.message || 'Task failed.', 'error');
                return;
            }
            selectedHistoryRunId = runId || null;
            setSharedHistoryActive(runId);
            loadAnalysisResults(entry);
        };
    });

    document.querySelectorAll('.history-checkbox').forEach(cb => {
        cb.onchange = updateDeleteButtons;
    });

    document.querySelectorAll('.history-delete-single').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            if (!runId) return;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            const isStale = isTaskStale(entry);
            if ((status === 'pending' || status === 'running') && !isStale) {
                setRunStatus(entry.analysis_type || currentStep, 'This task is still processing and cannot be deleted yet.', 'error');
                return;
            }
            const confirmMsg = isStale && (status === 'pending' || status === 'running') 
                ? `Delete this stuck task? (>180 min without heartbeat)`
                : 'Delete this run?';
            if (!confirm(confirmMsg)) return;
            await deleteHistoryRunIds(new Set([runId]));
            renderAnalysisHistory();
        };
    });

    updateDeleteButtons();
    renderRocHistoryPopup();
    renderCorrHistoryPopup();
}

function setSharedHistoryActive(runId) {
    document.querySelectorAll('#analysis-history .history-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.runId === runId);
    });
}

function renderRocHistoryPopup() {
    const popup = dom.rocHistoryPopup();
    if (!popup) return;

    const rocEntries = analysisHistory.filter(item => item.analysis_type === 'roc' || item.roc_results || item.roc_results_url);
    if (rocEntries.length === 0) {
        popup.innerHTML = '<div class="history-meta">No ROC runs yet.</div>';
        return;
    }

    popup.innerHTML = rocEntries.map(item => `
        <div class="history-item d-flex align-items-start gap-2 ${selectedHistoryRunId && item.run_id === selectedHistoryRunId ? 'active' : ''}" data-run-id="${item.run_id}" title="${escapeHtmlAttr(buildRocTooltipText(item))}">
            <div class="roc-history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">ROC: ${item.name}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getTaskStatusBadge(normalizeBiomarkerStatus(item.status))}<span>${formatTaskId(item) || 'No ID'}</span></div>
                <div class="history-meta">${new Date(item.date).toLocaleString()}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 roc-history-delete" data-run-id="${item.run_id}" title="Delete this run" style="font-size:0.65rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `).join('');

    popup.querySelectorAll('.roc-history-info').forEach(node => {
        node.onclick = () => {
            const runId = node.parentElement.dataset.runId;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            if (status === 'pending' || status === 'running') return;
            if (status === 'error') {
                setRunStatus('roc', entry.message || 'ROC task failed.', 'error');
                return;
            }
            selectedHistoryRunId = runId || null;
            popup.querySelectorAll('.history-item').forEach((el) => el.classList.remove('active'));
            node.parentElement.classList.add('active');
            currentStep = 'roc';
            const sharedHistoryCard = document.getElementById('shared-history-card');
            if (sharedHistoryCard) sharedHistoryCard.classList.add('d-none');
            document.querySelectorAll('.step-tab').forEach(t => t.classList.remove('active-ols', 'active-corr', 'active-roc'));
            const rocTab = document.querySelector('.step-tab[data-step="roc"]');
            if (rocTab) rocTab.classList.add('active-roc');
            document.querySelectorAll('[id^="config-"]').forEach(c => c.classList.add('d-none'));
            const rocConfig = document.getElementById('config-roc');
            if (rocConfig) rocConfig.classList.remove('d-none');
            loadAnalysisResults(entry);
            popup.classList.remove('open');
        };
    });

    popup.querySelectorAll('.roc-history-delete').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            const isStale = isTaskStale(entry);
            if ((status === 'pending' || status === 'running') && !isStale) {
                setRunStatus('roc', 'This task is still processing and cannot be deleted yet.', 'error');
                return;
            }
            const confirmMsg = isStale && (status === 'pending' || status === 'running')
                ? `Delete this stuck task? (>180 min without heartbeat)`
                : 'Delete this ROC run?';
            if (!confirm(confirmMsg)) return;
            await deleteHistoryRunIds(new Set([runId]));
            if (selectedHistoryRunId === runId) selectedHistoryRunId = null;
            renderAnalysisHistory();
        };
    });
}

function bindRocHistoryEvents() {
    const toggle = dom.rocHistoryToggle();
    const popup = dom.rocHistoryPopup();
    if (!toggle || !popup) return;

    toggle.onclick = () => {
        popup.classList.toggle('open');
    };

    document.addEventListener('click', (event) => {
        if (!popup.contains(event.target) && !toggle.contains(event.target)) {
            popup.classList.remove('open');
        }
    });
}

async function deleteHistoryRunIds(runIdsToDelete) {
    const entriesToDelete = analysisHistory.filter(item => runIdsToDelete.has(item.run_id));
    const urlsToDelete = entriesToDelete.flatMap(collectHistoryEntryUrls);

    Object.keys(loadedAnalysisByStep).forEach((step) => {
        const remembered = loadedAnalysisByStep[step];
        if (remembered?.run_id && runIdsToDelete.has(remembered.run_id)) {
            loadedAnalysisByStep[step] = null;
        }
    });

    if (selectedHistoryRunId && runIdsToDelete.has(selectedHistoryRunId)) {
        selectedHistoryRunId = null;
        window._currentLoadedAnalysis = null;
    }
    analysisHistory = analysisHistory.filter(item => !runIdsToDelete.has(item.run_id));

    const projectState = buildBiomarkerProjectState();
    await updateDoc(doc(db, "projects", projectId), projectState);
    projectData = { ...projectData, ...projectState };
    // Clean storage in background so UI is responsive like PLSDA history deletion.
    deleteStorageArtifacts(urlsToDelete);
    populateOlsInputSelectors();
    syncOlsInputLocks();

    if (selectedHistoryRunId) {
        const selectedEntry = getHistoryByRunId(selectedHistoryRunId);
        if (selectedEntry) {
            loadAnalysisResults(selectedEntry);
            return;
        }
    }

    const fallbackEntry = getHistoryByStep(currentStep)[0] || null;
    if (fallbackEntry) {
        selectedHistoryRunId = fallbackEntry.run_id || null;
        loadAnalysisResults(fallbackEntry);
        return;
    }

    clearResultsPanel();
}

function updateDeleteButtons() {
    const checkedBoxes = document.querySelectorAll('.history-checkbox:checked');
    document.getElementById('btn-delete-selected').disabled = checkedBoxes.length === 0;
}

async function loadAnalysisResults(analysis) {
    const token = ++historyLoadToken;
    selectedOlsFeature = null;
    resetOlsProgressionPanel();
    selectedHistoryRunId = analysis?.run_id || null;
    setSharedHistoryActive(selectedHistoryRunId);
    // Preload all data into memory
    if (isOlsHistoryItem(analysis)) {
        await ensureOlsResultsLoaded(analysis);
        if (token !== historyLoadToken) return;
        olsDataGlobal = Array.isArray(analysis.ols_results) ? analysis.ols_results : [];
        currentOlsTargetMeta = analysis.target || currentOlsTargetMeta;
        renderOlsTable();
        if (analysis.ols_sample_info) {
            document.getElementById('sample-overlap-info').innerText = `Overlap Samples: ${analysis.ols_sample_info.used}/${analysis.ols_sample_info.total}`;
        }
    }
    if (analysis.corr_results_url || analysis.corr_html_url) {
        if (token !== historyLoadToken) return;
        // Reveal container BEFORE Plotly renders — Plotly on display:none draws 0×0
        if (currentStep === 'corr') {
            document.getElementById('corr-results-container').classList.remove('d-none');
        }
        const corrData = await ensureCorrResultsLoaded(analysis);
        if (token !== historyLoadToken) return;
        if (corrData && corrData.length) {
            renderCorrFeatureTable(corrData);
        }
    }
    if (analysis.roc_results || analysis.roc_results_url) {
        if (token !== historyLoadToken) return;
        setRocLoadingState('Loading ROC results...');
        // Reveal container BEFORE Plotly renders — Plotly on display:none draws 0×0
        if (currentStep === 'roc') {
            document.getElementById('roc-results-container').classList.remove('d-none');
        }
        const full = await ensureRocFullResults(analysis);
        if (token !== historyLoadToken) return;
        const rocPanels = await fetchRocPanelsFromUrl(analysis.roc_results_url);
        const summary = Array.isArray(analysis.roc_results) && analysis.roc_results.length ? analysis.roc_results : buildRocSummary(full);
        window.rocResults = summary;
        window.rocResultsFull = full;
        renderRocTable(summary, full);
        renderRocPanel(rocPanels);
        if (!full || !full.length) setRocEmptyState('No ROC curves found in this history run.');
    }

    // Update form
    if (token !== historyLoadToken) return;
    document.getElementById('analysis-name').value = analysis.name;
    if (analysis.target) document.getElementById('ols-target').value = analysis.target;
    if (analysis.source_ols_run_id) {
        if (analysis.analysis_type === 'corr') {
            selectedCorrOlsRunId = analysis.source_ols_run_id;
        }
        if (analysis.analysis_type === 'roc') {
            selectedRocOlsRunId = analysis.source_ols_run_id;
        }
    }
    if (analysis.analysis_type === 'corr' || analysis.corr_results_url || analysis.corr_html_url) {
        currentCorrMethod = normalizeCorrMethod(analysis.corr_method);
        const corrMethodSelect = document.getElementById('corr-method');
        if (corrMethodSelect) corrMethodSelect.value = currentCorrMethod;
    }
    populateOlsInputSelectors();
    syncOlsInputLocks();

    const analysisStep = getAnalysisStep(analysis);
    if (analysisStep) {
        loadedAnalysisByStep[analysisStep] = analysis;
    }

    // Show result panel for current tab, restoring remembered run for that tab when available.
    if (token !== historyLoadToken) return;
    showResultsForCurrentStep(analysis);
}

function showResultsForCurrentStep(analysis) {
    const rememberedForStep = loadedAnalysisByStep[currentStep] || null;
    const activeAnalysis = rememberedForStep || analysis || null;

    // Ẩn tất cả
    document.getElementById('ols-results-container').classList.add('d-none');
    document.getElementById('corr-results-container').classList.add('d-none');
    document.getElementById('roc-results-container').classList.add('d-none');

    // Chỉ hiện tab đang active nếu có data
    if (currentStep === 'ols' && activeAnalysis && isOlsHistoryItem(activeAnalysis)) {
        document.getElementById('ols-results-container').classList.remove('d-none');
    } else if (currentStep === 'corr' && activeAnalysis && (activeAnalysis.corr_html_url || activeAnalysis.corr_results_url || activeAnalysis.corr_results)) {
        document.getElementById('corr-results-container').classList.remove('d-none');
    } else if (currentStep === 'roc' && activeAnalysis && (activeAnalysis.roc_results || activeAnalysis.roc_results_url)) {
        if (!rocPanelData) {
            document.getElementById('roc-results-container').classList.remove('d-none');
        }
    }

    // Keep backward-compatible current pointer, but prefer per-tab memory.
    if (activeAnalysis) window._currentLoadedAnalysis = activeAnalysis;
}

function clearResultsPanel() {
    olsDataGlobal = [];
    selectedOlsFeature = null;
    window.rocResults = null;
    window.rocResultsFull = null;
    rocResultsSourceKey = null;
    currentOlsTargetMeta = '';
    loadedAnalysisByStep.ols = null;
    loadedAnalysisByStep.corr = null;
    loadedAnalysisByStep.roc = null;
    window._currentLoadedAnalysis = null;
    document.getElementById('ols-results-container').classList.add('d-none');
    document.getElementById('corr-results-container').classList.add('d-none');
    document.getElementById('roc-results-container').classList.add('d-none');
    document.querySelector('#ols-table tbody').innerHTML = '';
    document.getElementById('corr-heatmap-plot').innerHTML = '';
    document.querySelector('#roc-table tbody').innerHTML = '';
    document.getElementById('roc-plot').innerHTML = '';
    document.getElementById('sample-overlap-info').innerText = '';
    resetOlsProgressionPanel();
}

function lockHistory() {
    // Keep history interactive while processing so users can monitor task state.
}

function unlockHistory() {
    // No-op: history remains available during task execution.
}

// ==================== VALIDATION ====================

function validateOlsForm() {
    const target = document.getElementById('ols-target').value;
    const checked = Array.from(document.querySelectorAll('.cov-check:checked')).map(c => c.value);
    const btn = document.getElementById('btn-run-ols');
    const check = (name) => {
        const meta = projectData.meta_metadata.find((x) => x.name === name);
        return isContinuousLikeMeta(meta) || encSettings[name];
    };
    if (!check(target)) { btn.disabled = true; return; }
    for (let c of checked) { if (!check(c)) { btn.disabled = true; return; } }
    btn.disabled = false;
}

function validateCorrForm() {
    const checked = Array.from(document.querySelectorAll('.corr-check:checked')).map(c => c.value);
    const btn = document.getElementById('btn-run-corr');
    const msg = document.getElementById('corr-validation-msg');
    if (checked.length === 0) { btn.disabled = true; msg.innerText = "Select clinical variables!"; return; }
    for (let c of checked) {
        const m = projectData.meta_metadata.find(x => x.name === c);
        if (isCategoricalLikeMeta(m) && !encSettings[c]) { btn.disabled = true; msg.innerText = `Encode [${c}] first!`; return; }
    }
    btn.disabled = false; msg.innerText = "";
}

function validateRocForm() {
    const target = document.getElementById('roc-target').value;
    const selected = document.querySelector('.roc-comp-check:checked');
    const btn = document.getElementById('btn-run-roc');
    const msg = document.getElementById('roc-validation-msg');
    if (!target) { btn.disabled = true; msg.innerText = "Select categorical metadata!"; return; }
    if (!selected) { btn.disabled = true; msg.innerText = "Select a comparison!"; return; }
    btn.disabled = false; msg.innerText = "";
}

// ==================== ENCODING MODAL ====================

function sortMetaGroups(groups) {
    return [...groups].sort((a, b) => {
        const numA = Number(a);
        const numB = Number(b);
        const isNumA = Number.isFinite(numA);
        const isNumB = Number.isFinite(numB);
        // Text (A-Z) first, then numbers (small → large)
        if (isNumA && isNumB) return numA - numB;
        if (isNumA !== isNumB) return isNumA ? 1 : -1;
        return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
    });
}

function scrollHistoryIntoPanel() {
    const historyEl = document.getElementById('analysis-history');
    if (!historyEl) return;
    // Scroll the nearest scrollable ancestor rather than using scrollIntoView,
    // which causes a body/html scroll attempt when body has overflow:hidden
    // and triggers a layout-repaint glitch requiring zoom to recover.
    const panel = historyEl.closest('.results-panel');
    if (panel) {
        const targetTop = historyEl.offsetTop - panel.offsetTop;
        panel.scrollTo({ top: Math.max(0, targetTop - 12), behavior: 'smooth' });
    }
}

function openEncodingModal(varName) {
    activeVar = varName;
    document.getElementById('modal-title-var').innerText = `Encoding: ${varName}`;
    const meta = projectData.meta_metadata.find(m => m.name === varName);
    const isCat = isCategoricalLikeMeta(meta);

    // For categorical variables, continuous encoding makes no sense — hide that option
    const continuousOpt = document.querySelector('#enc-type-select option[value="continuous"]');
    if (continuousOpt) {
        continuousOpt.disabled = isCat;
        continuousOpt.style.display = isCat ? 'none' : '';
    }

    const rawGroups = (meta.groups || []).filter(g => g !== null && String(g).toLowerCase() !== 'nan');
    const sortedGroups = sortMetaGroups(rawGroups);
    const groupCounts = (meta.group_counts && typeof meta.group_counts === 'object') ? meta.group_counts : {};

    const savedSettings = encSettings[varName];
    let encType, displayItems;

    if (savedSettings) {
        // If saved type is continuous but meta is categorical, force ordinal
        encType = (isCat && savedSettings.type === 'continuous') ? 'ordinal' : savedSettings.type;
        if (encType === 'ordinal' && Array.isArray(savedSettings.order) && savedSettings.order.length) {
            // Restore saved rank order; append any new labels (not yet in saved order) at the end
            const savedSet = new Set(savedSettings.order.map(String));
            const extras = sortedGroups.filter(g => !savedSet.has(String(g)));
            displayItems = [
                ...savedSettings.order.map(l => ({ label: l, count: groupCounts[String(l)] ?? null })),
                ...extras.map(l => ({ label: l, count: groupCounts[String(l)] ?? null })),
            ];
        } else {
            displayItems = sortedGroups.map(g => ({ label: g, count: groupCounts[String(g)] ?? null }));
        }
    } else {
        encType = isCat ? 'ordinal' : 'continuous';
        // Default: A-Z / asc-numeric order becomes initial rank 0, 1, 2 ...
        displayItems = sortedGroups.map(g => ({ label: g, count: groupCounts[String(g)] ?? null }));
    }

    document.getElementById('enc-type-select').value = encType;
    document.getElementById('ordinal-order-section').style.display = encType === 'ordinal' ? 'block' : 'none';
    const errEl = document.getElementById('enc-rank-error');
    if (errEl) errEl.textContent = '';
    renderOrderList(displayItems);

    document.getElementById('enc-type-select').onchange = (e) => {
        document.getElementById('ordinal-order-section').style.display = e.target.value === 'ordinal' ? 'block' : 'none';
    };

    document.getElementById('btn-save-encoding').onclick = () => {
        const type = document.getElementById('enc-type-select').value;
        if (type === 'ordinal') {
            // Items are always kept in rank order by the live-reorder UI — just read DOM order
            const order = [...document.querySelectorAll('#modal-order-list .order-item')]
                .map(row => row.dataset.label);
            encSettings[activeVar] = { type: 'ordinal', order };
        } else if (type === 'onehot') {
            encSettings[activeVar] = { type: 'onehot' };
        } else {
            encSettings[activeVar] = { type: 'continuous' };
        }
        modalEnc.hide();
        updateTargetStatusUI();
        ['cov', 'corr'].forEach(s => {
            const b = document.getElementById(`badge-${s}-${makeSafeId(activeVar)}`);
            if (b) { b.innerText = 'Encoded'; b.className = 'badge-status bg-success text-white extra-small'; }
        });
        validateOlsForm();
        validateCorrForm();
    };
    modalEnc.show();
}

/**
 * itemsInRankOrder: Array of { label: string } ordered by rank (index 0 = rank 0 = reference).
 * Editing a rank input moves that item to the target position and shifts others live.
 */
function renderOrderList(itemsInRankOrder) {
    const container = document.getElementById('modal-order-list');
    container.innerHTML = '';
    const maxRank = Math.max(0, itemsInRankOrder.length - 1);

    itemsInRankOrder.forEach((item, rankIndex) => {
        const row = document.createElement('div');
        row.className = 'order-item d-flex align-items-center gap-2 mb-1';
        row.dataset.label = item.label;

        const labelSpan = document.createElement('span');
        labelSpan.className = 'small flex-grow-1 text-truncate';
        labelSpan.title = item.label;
        const countBadge = (item.count != null)
            ? ` <span class="text-muted">(${item.count})</span>`
            : '';
        // Highlight rank-0 item as reference/control
        labelSpan.innerHTML = rankIndex === 0
            ? `<b class="text-danger">[CTRL]</b> ${escapeHtmlBiomarker(item.label)}${countBadge}`
            : `${escapeHtmlBiomarker(item.label)}${countBadge}`;

        const rankInput = document.createElement('input');
        rankInput.type = 'number';
        rankInput.className = 'form-control form-control-sm rank-input text-center p-1';
        rankInput.min = 0;
        rankInput.max = maxRank;
        rankInput.value = rankIndex;
        rankInput.style.cssText = 'width:54px; flex-shrink:0;';
        rankInput.title = 'Rank (0 = reference/control)';

        // Live insert-at-position: move item to newRank, shift others
        rankInput.addEventListener('change', () => {
            const raw = Number(rankInput.value);
            const newRank = Number.isFinite(raw)
                ? Math.max(0, Math.min(maxRank, Math.round(raw)))
                : rankIndex;
            if (newRank === rankIndex) {
                rankInput.value = rankIndex; // reset display if unchanged
                return;
            }
            const newOrder = [...itemsInRankOrder];
            const [moved] = newOrder.splice(rankIndex, 1);
            newOrder.splice(newRank, 0, moved);
            // preserve count when re-rendering
            newOrder.forEach((it, i) => { if (it.count === undefined) it.count = null; });
            const errEl = document.getElementById('enc-rank-error');
            if (errEl) errEl.textContent = '';
            renderOrderList(newOrder);
        });

        row.appendChild(labelSpan);
        row.appendChild(rankInput);
        container.appendChild(row);
    });
}

function escapeHtmlBiomarker(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _afterEncSave() {
    modalEnc.hide();
    updateTargetStatusUI();
    ['cov', 'corr'].forEach(s => {
        const b = document.getElementById(`badge-${s}-${makeSafeId(activeVar)}`);
        if (b) { b.innerText = 'Encoded'; b.className = 'badge-status bg-success text-white extra-small'; }
    });
    validateOlsForm();
    validateCorrForm();
}

document.getElementById('btn-save-encoding').onclick = () => {
    const type = document.getElementById('enc-type-select').value;
    const errEl = document.getElementById('enc-rank-error');
    if (errEl) errEl.textContent = '';

    if (type !== 'ordinal') {
        encSettings[activeVar] = { type, order: [] };
        _afterEncSave();
        return;
    }

    // Items are always kept in rank order by the live-reorder UI — just read DOM order
    const order = [...document.querySelectorAll('#modal-order-list .order-item')]
        .map(row => row.dataset.label);
    encSettings[activeVar] = { type: 'ordinal', order };
    _afterEncSave();
};

function updateTargetStatusUI() {
    const t = document.getElementById('ols-target').value;
    const m = projectData.meta_metadata.find(x => x.name === t);
    const ready = isContinuousLikeMeta(m) || encSettings[t];
    document.getElementById('target-status-box').innerHTML = `<span class="badge-status ${ready ? 'bg-success' : 'bg-danger'} text-white extra-small">${ready ? 'Ready' : 'Encode Required'}</span>`;
}

// ==================== OLS EXECUTION ====================

document.getElementById('btn-run-ols').onclick = async () => {
    const btn = document.getElementById('btn-run-ols');
    const configCard = document.getElementById('config-ols');
    const analysisName = document.getElementById('analysis-name').value || `Analysis ${new Date().toLocaleString()}`;
    const targetMeta = document.getElementById('ols-target').value;
    const covariates = Array.from(document.querySelectorAll('.cov-check:checked')).map(c => c.value);
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath;
    const metaPath = projectData?.metaCheckedPath;

    if (!matrixPath || !metaPath) {
        setRunStatus('ols', 'No pre-scale/normalized matrix or metadata found. Run Normalize first.', 'error');
        return;
    }

    beginRun();
    setRunStatus('ols', 'Submitting OLS task...');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Processing...';
    configCard.classList.add('processing');
    lockHistory();

    try {
        await updateDoc(doc(db, "projects", projectId), { ols_results: null, ols_results_url: null, ols_csv_url: null });
        const startResp = await fetch(`${vpsUrl}/biomarker-ols`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, uid: auth.currentUser.uid, matrix_path: matrixPath, meta_path: metaPath, settings: { analysis_name: analysisName, target: targetMeta, covariates, encoding_map: encSettings } })
        });
        const startPayload = await startResp.json();
        if (!startResp.ok) throw new Error(startPayload.detail || startPayload.message || 'Cannot start OLS analysis.');

        currentRunId = startPayload.run_id || null;
        selectedHistoryRunId = currentRunId;
        analysisHistory = deduplicateHistory([
            {
                run_id: startPayload.run_id || null,
                task_id: startPayload.task_id ?? null,
                analysis_type: 'ols',
                name: analysisName,
                date: new Date().toISOString(),
                target: targetMeta,
                covariates,
                encoding_map: JSON.parse(JSON.stringify(encSettings || {})),
                status: 'pending',
                message: 'Queued for processing.',
            },
            ...analysisHistory.filter((item) => item.run_id !== startPayload.run_id),
        ]);
        renderAnalysisHistory();
        scrollHistoryIntoPanel();
        setSharedHistoryActive(currentRunId);
        setRunStatus('ols', `${analysisName} is pending...`);

        const queuedRunId = currentRunId;
        void waitForBiomarkerTaskCompletion('ols', queuedRunId).then(async (d) => {
            projectData = d;
            analysisHistory = deduplicateHistory(d.biomarker_history || analysisHistory);
            const completedEntry = getHistoryByRunId(queuedRunId) || null;
            if (!completedEntry) throw new Error('OLS finished but history entry was not found.');
            await loadAnalysisResults(completedEntry);
            selectedCorrOlsRunId = queuedRunId;
            selectedRocOlsRunId = queuedRunId;
            populateOlsInputSelectors();
            syncOlsInputLocks();
            renderAnalysisHistory();
            selectedHistoryRunId = queuedRunId;
            setSharedHistoryActive(queuedRunId);
            setRunStatus('ols', `Done (${completedEntry.result_count || olsDataGlobal.length} features)`, 'success');
        }).catch((err) => {
            setRunStatus('ols', err.message || 'OLS failed.', 'error');
        });
    } catch (err) {
        setRunStatus('ols', err.message || 'OLS failed.', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play me-2"></i>RUN OLS';
        configCard.classList.remove('processing');
        unlockHistory();
        endRun();
    }
};

// ==================== CORRELATION EXECUTION ====================

let corrSnapshotUnsubscribe = null;
let corrIsProcessing = false;

document.getElementById('btn-run-corr').onclick = async () => {
    if (corrIsProcessing) return;
    const btn = document.getElementById('btn-run-corr');
    const configCard = document.getElementById('config-corr');
    const corrMethodSelect = document.getElementById('corr-method');
    currentCorrMethod = normalizeCorrMethod(corrMethodSelect?.value || currentCorrMethod);
    const corrMethodLabel = getCorrMethodLabel(currentCorrMethod);
    corrIsProcessing = true;
    beginRun();
    setRunStatus('corr', `Running ${corrMethodLabel} correlation...`);
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Processing...';
    configCard.classList.add('processing');
    lockHistory();

    const sourceOls = selectedCorrOlsRunId ? getHistoryByRunId(selectedCorrOlsRunId) : null;
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath;
    const metaPath = projectData?.metaCheckedPath;

    if (!matrixPath || !metaPath) {
        corrIsProcessing = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt me-2"></i>RUN CORRELATION';
        configCard.classList.remove('processing');
        unlockHistory();
        setRunStatus('corr', 'No pre-scale/normalized matrix or metadata found. Run Normalize first.', 'error');
        endRun();
        return;
    }

    await updateDoc(doc(db, "projects", projectId), { corr_results: null, corr_html_url: null, corr_timestamp: null });

    if (corrSnapshotUnsubscribe) corrSnapshotUnsubscribe();

    const plotDiv = document.getElementById('corr-heatmap-plot');
    plotDiv.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; height:100%; font-size:16px;"><div><i class="fa-solid fa-spinner fa-spin me-2"></i>Computing correlation...</div></div>';
    document.getElementById('corr-results-container').classList.remove('d-none');

    const runStartedAt = Date.now();

    const analysisName = `${document.getElementById('analysis-name').value || 'Analysis'} | Correlation`;
    const clinicalVars = Array.from(document.querySelectorAll('.corr-check:checked')).map(c => c.value);
    const corrStartResp = await fetch(`${vpsUrl}/biomarker-corr`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            project_id: projectId, uid: auth.currentUser.uid, matrix_path: matrixPath, meta_path: metaPath,
            settings: {
                analysis_name: analysisName,
                source_ols_run_id: sourceOls?.run_id || null,
                source_ols_name: sourceOls?.name || null,
                corr_method: currentCorrMethod,
                clinical_vars: clinicalVars,
                encoding_map: encSettings
            }
        })
    });
    if (!corrStartResp.ok) {
        corrIsProcessing = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt me-2"></i>RUN CORRELATION';
        configCard.classList.remove('processing');
        unlockHistory();
        setRunStatus('corr', 'Cannot start correlation analysis.', 'error');
        endRun();
        return;
    }

    const corrStartPayload = await corrStartResp.json();
    const corrRunId = corrStartPayload.run_id || null;
    selectedHistoryRunId = corrRunId;
    analysisHistory = deduplicateHistory([
        {
            run_id: corrRunId,
            task_id: corrStartPayload.task_id ?? null,
            analysis_type: 'corr',
            name: analysisName,
            date: new Date().toISOString(),
            source_ols_run_id: sourceOls?.run_id || null,
            source_ols_name: sourceOls?.name || null,
            corr_method: currentCorrMethod,
            clinical_vars: clinicalVars,
            status: 'pending',
            message: 'Queued for processing.',
        },
        ...analysisHistory.filter((item) => item.run_id !== corrRunId),
    ]);
    renderAnalysisHistory();
    renderCorrHistoryPopup();
    scrollHistoryIntoPanel();
    setSharedHistoryActive(corrRunId);
    setRunStatus('corr', `${analysisName} is pending...`);

    try {
        void waitForBiomarkerTaskCompletion('corr', corrRunId).then(async (d) => {
            projectData = d;
            analysisHistory = deduplicateHistory(d.biomarker_history || analysisHistory);
            renderAnalysisHistory();
            renderCorrHistoryPopup();
            selectedHistoryRunId = corrRunId;
            setSharedHistoryActive(corrRunId);
            // Load full corr results from Storage into RAM cache
            // Use d.corr_results_url directly (most authoritative — set by backend update)
            const entry = getHistoryByRunId(corrRunId) || {};
            const entryWithUrl = { ...entry, corr_results_url: entry.corr_results_url || d.corr_results_url, run_id: entry.run_id || corrRunId };
            const corrData = await ensureCorrResultsLoaded(entryWithUrl);
            if (corrData && corrData.length) {
                renderCorrFeatureTable(corrData);
            } else {
                setRunStatus('corr', 'Correlation completed (no results loaded — check GCS URL).', 'error');
                return;
            }
            window._currentLoadedAnalysis = entryWithUrl;
            setRunStatus('corr', 'Correlation completed.', 'success');
        }).catch((err) => {
            setRunStatus('corr', err.message || 'Correlation failed.', 'error');
        });
    } catch (err) {
        setRunStatus('corr', err.message || 'Correlation failed.', 'error');
    } finally {
        corrIsProcessing = false;
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-bolt me-2"></i>RUN CORRELATION';
        configCard.classList.remove('processing');
        unlockHistory();
        endRun();
    }
};

// ==================== CORR FEATURE TABLE & HEATMAP ====================

async function ensureCorrResultsLoaded(analysis) {
    if (!analysis) return null;
    const runId = analysis.run_id || null;
    if (runId && corrMemoryCache.runId === runId && corrMemoryCache.data) return corrMemoryCache.data;
    const url = analysis.corr_results_url;
    if (!url) return null;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const raw = await resp.json();
        const data = Array.isArray(raw) ? raw : null;
        if (data) { corrMemoryCache.runId = runId; corrMemoryCache.data = data; }
        return data;
    } catch (e) { console.warn('Failed to load corr results:', e); return null; }
}

function buildCorrDisplayOptions(data, preferredKey = '__best__') {
    const select = document.getElementById('corr-r-display-select');
    if (!select) return '__best__';

    const clinicalVars = [...new Set((data || [])
        .map((row) => String(row?.clinical || '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));

    const options = ['<option value="__best__">Best |r| (all clinical vars)</option>']
        .concat(clinicalVars.map((name) => `<option value="${escapeHtmlAttr(name)}">${escapeHtmlBiomarker(name)}</option>`));

    select.innerHTML = options.join('');
    const nextKey = clinicalVars.includes(preferredKey) || preferredKey === '__best__' ? preferredKey : '__best__';
    select.value = nextKey;
    return nextKey;
}

// Summarise per-lipid for selected display mode: best |r| (all) or one clinical variable.
function buildCorrLipidSummary(data, displayKey = '__best__') {
    const map = {};
    const effectiveRows = displayKey === '__best__'
        ? (data || [])
        : (data || []).filter((row) => String(row?.clinical || '').trim() === displayKey);

    for (const row of effectiveRows) {
        const lipid = row.lipid;
        if (!lipid) continue;
        const rValue = parseFloat(row.r);
        const signedR = Number.isFinite(rValue) ? rValue : 0;
        const absR = Math.abs(signedR);
        const fdr = parseFloat(row.fdr);
        if (!map[lipid] || absR > map[lipid].absR || (absR === map[lipid].absR && !isNaN(fdr) && fdr < map[lipid].fdr)) {
            map[lipid] = { lipid, r: signedR, absR, fdr: isNaN(fdr) ? 1 : fdr };
        }
    }
    return Object.values(map);
}

let corrSummaryData = [];  // [{lipid, r, absR, fdr}] — full list, for filter/sort
let corrSelectedLipids = new Set();

function renderCorrFeatureTable(data) {
    corrRawData = Array.isArray(data) ? data : [];
    currentCorrDisplayKey = buildCorrDisplayOptions(corrRawData, '__best__');
    corrSummaryData = buildCorrLipidSummary(corrRawData, currentCorrDisplayKey);
    // New dataset loaded: reset selection and auto-select top 15 once.
    corrSelectedLipids = new Set();
    document.getElementById('corr-results-container').classList.remove('d-none');
    // Reset filter inputs to defaults so heatmap shows all on fresh load
    const minREl = document.getElementById('corr-min-r');
    const maxFdrEl = document.getElementById('corr-max-fdr');
    if (minREl) minREl.value = '0.1';
    if (maxFdrEl) maxFdrEl.value = '0.05';
    refreshCorrTable(false, true);
}

function refreshCorrTable(forceEmpty = false, initialLoad = false) {
    const search = (document.getElementById('corr-search')?.value || '').toLowerCase();
    const minR = Math.max(0, Number(document.getElementById('corr-min-r')?.value ?? 0.1));
    const maxFdr = Math.min(1, Math.max(0, Number(document.getElementById('corr-max-fdr')?.value ?? 0.05)));

    const hasFilter = minR > 0 || maxFdr < 1;
    let rows = corrSummaryData.filter(r => {
        const passSearch = !search || r.lipid.toLowerCase().includes(search);
        const passR = r.absR >= minR;
        const passFdr = r.fdr <= maxFdr;
        return passSearch && passR && passFdr;
    });
    // When filters are active sort by |r| desc, otherwise A-Z
    if (hasFilter) rows.sort((a, b) => b.absR - a.absR);
    else rows.sort((a, b) => a.lipid.localeCompare(b.lipid));

    const tbody = document.querySelector('#corr-feature-table tbody');
    const count = document.getElementById('corr-row-count');
    if (!tbody) return;

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-3 text-warning fw-bold text-center"><i class="fa-solid fa-triangle-exclamation me-1"></i>No features match current filter.</td></tr>`;
        if (count) count.textContent = '0 features';
        // Keep previous selection unchanged when search/filter returns no visible rows.
        updateCorrHeatmap([...corrSelectedLipids], corrMemoryCache.data || []);
        return;
    }

    // Auto-select top 15 only on first render after loading a new correlation dataset.
    if (!forceEmpty && initialLoad && corrSelectedLipids.size === 0) {
        rows.slice(0, 15).forEach(r => corrSelectedLipids.add(r.lipid));
    }

    tbody.innerHTML = rows.map(r => `
        <tr style="cursor:pointer;" data-lipid="${escapeHtmlAttr(r.lipid)}">
            <td><input type="checkbox" class="form-check-input corr-lipid-check" value="${escapeHtmlAttr(r.lipid)}" ${corrSelectedLipids.has(r.lipid) ? 'checked' : ''}></td>
            <td class="text-start" style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtmlAttr(r.lipid)}">${escapeHtmlAttr(r.lipid)}</td>
            <td class="${r.r < 0 ? 'text-primary' : r.r > 0 ? 'text-danger' : 'text-muted'} fw-bold" title="r = ${r.r.toFixed(3)}">${r.absR.toFixed(3)}</td>
            <td>${r.fdr < 0.001 ? '<0.001' : r.fdr.toFixed(3)}</td>
        </tr>`).join('');
    if (count) count.textContent = `${rows.length} features`;

    // Update heatmap to match current filtered+selected set
    updateCorrHeatmap([...corrSelectedLipids], corrMemoryCache.data || []);

    // Click anywhere on row to toggle
    tbody.querySelectorAll('tr').forEach(row => {
        row.onclick = (e) => {
            const cb = row.querySelector('.corr-lipid-check');
            if (!cb) return;
            if (e.target === cb) return; // checkbox handles itself
            cb.checked = !cb.checked;
            if (cb.checked) corrSelectedLipids.add(cb.value); else corrSelectedLipids.delete(cb.value);
            updateCorrHeatmap([...corrSelectedLipids], corrMemoryCache.data || []);
        };
        const cb = row.querySelector('.corr-lipid-check');
        if (cb) cb.onchange = () => {
            if (cb.checked) corrSelectedLipids.add(cb.value); else corrSelectedLipids.delete(cb.value);
            updateCorrHeatmap([...corrSelectedLipids], corrMemoryCache.data || []);
        };
    });
}

function updateCorrHeatmap(selectedLipids, data) {
    window._currentCorrSelectedLipids = selectedLipids;
    window._currentCorrData = data;
    const plotDiv = document.getElementById('corr-heatmap-plot');
    if (!plotDiv) return;
    if (!data || !data.length || !selectedLipids.length) {
        try { Plotly.purge(plotDiv); } catch { }
        plotDiv.innerHTML = '<div class="text-muted text-center p-4">Select features to display.</div>';
        return;
    }
    // Build corr matrix for selected lipids
    const lipidSet = new Set(selectedLipids);
    const filtered = data.filter(r => lipidSet.has(r.lipid));
    const clinVars = [...new Set(filtered.map(r => r.clinical))];
    const uniqueLipids = selectedLipids.filter(l => lipidSet.has(l));
    const zMatrix = [], textMatrix = [];
    const sigAnnotations = [];
    for (const lipid of uniqueLipids) {
        const rRow = [], tRow = [];
        for (const clin of clinVars) {
            const entry = filtered.find(d => d.lipid === lipid && d.clinical === clin);
            const r = entry ? parseFloat(entry.r) : null;
            const fdr = entry ? parseFloat(entry.fdr) : null;
            rRow.push(r !== null && !isNaN(r) ? r : null);
            tRow.push(r !== null && !isNaN(r) ? r.toFixed(2) : '');
            // FDR significance stars as red annotations (separate from r value text)
            if (r !== null && !isNaN(r) && fdr !== null && !isNaN(fdr) && fdr < 0.05) {
                const stars = fdr < 0.001 ? '***' : fdr < 0.01 ? '**' : '*';
                sigAnnotations.push({
                    x: clin, y: lipid,
                    text: `<b>${stars}</b>`,
                    showarrow: false,
                    font: { size: 15, color: '#ff0000' },
                    xanchor: 'center', yanchor: 'middle',
                    xref: 'x', yref: 'y'
                });
            }
        }
        zMatrix.push(rRow); textMatrix.push(tRow);
    }
    if (typeof Plotly === 'undefined') { plotDiv.innerHTML = '<div class="text-danger p-3">Plotly not loaded.</div>'; return; }
    const activeCorr = loadedAnalysisByStep.corr || window._currentLoadedAnalysis || null;
    currentCorrMethod = normalizeCorrMethod(activeCorr?.corr_method || currentCorrMethod);
    const methodLabel = getCorrMethodLabel(currentCorrMethod);
    // Always use newPlot so it works regardless of previous div state (plain innerHTML or old plot)
    try { Plotly.purge(plotDiv); } catch { }
    plotDiv.innerHTML = '';
    Plotly.newPlot(plotDiv, [{
        type: 'heatmap', z: zMatrix, x: clinVars, y: uniqueLipids,
        text: textMatrix, texttemplate: '%{text}', textfont: { size: 10 },
        xgap: 1, ygap: 1,
        colorscale: [
            [0.00, '#1d3557'], // blue nhạt
            [0.50, '#ffffff'], // gần trắng tại 0
            [1.00, '#2a9d8f']  // red nhạt
            ], zmid: 0, zmin: -1, zmax: 1,
        colorbar: { title: `${methodLabel} r`, tickfont: { size: corrPlotConfig.legendFontSize }, titlefont: { size: corrPlotConfig.legendFontSize } }
    }], {
        margin: { t: 30, l: 160, r: 20, b: 100 },
        plot_bgcolor: '#ada8a8',
        xaxis: { title: { font: { size: corrPlotConfig.axisFontSize } }, tickfont: { size: corrPlotConfig.axisFontSize } },
        yaxis: { title: { font: { size: corrPlotConfig.axisFontSize } }, tickfont: { size: corrPlotConfig.axisFontSize } },
        height: Math.max(350, 250 + uniqueLipids.length * 18),
        annotations: sigAnnotations
    }, { responsive: true, displayModeBar: "hover", scrollZoom: true, displaylogo: false, toImageButtonOptions: { format: corrPlotConfig.imgFormat, width: corrPlotConfig.imgWidth, height: corrPlotConfig.imgHeight, scale: corrPlotConfig.imgFormat === 'svg' ? 1 : 6 } });
}

// Corr history popup (mirrors renderRocHistoryPopup)
function renderCorrHistoryPopup() {
    const popup = dom.corrHistoryPopup();
    if (!popup) return;
    const corrEntries = analysisHistory.filter(item => item.analysis_type === 'corr' || item.corr_html_url || item.corr_results_url);
    if (!corrEntries.length) { popup.innerHTML = '<div class="history-meta">No Correlation runs yet.</div>'; return; }
    popup.innerHTML = corrEntries.map(item => `
        <div class="history-item d-flex align-items-start gap-2 ${selectedHistoryRunId && item.run_id === selectedHistoryRunId ? 'active' : ''}" data-run-id="${item.run_id}" title="">
            <div class="corr-history-info" style="flex:1; min-width:0; cursor:pointer;">
                <div class="history-title">Corr: ${escapeHtmlAttr(item.name || item.run_id)}</div>
                <div class="history-meta d-flex align-items-center gap-2 flex-wrap">${getTaskStatusBadge(normalizeBiomarkerStatus(item.status))}<span>${formatTaskId(item) || 'No ID'}</span></div>
                <div class="history-meta">${new Date(item.date).toLocaleString()}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 corr-history-delete" data-run-id="${item.run_id}" title="Delete this run" style="font-size:0.65rem; flex-shrink:0;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>`).join('');
    popup.querySelectorAll('.corr-history-info').forEach(node => {
        node.onclick = () => {
            const runId = node.parentElement.dataset.runId;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            if (status === 'pending' || status === 'running') return;
            if (status === 'error') { setRunStatus('corr', entry.message || 'Corr task failed.', 'error'); return; }
            selectedHistoryRunId = runId || null;
            popup.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
            node.parentElement.classList.add('active');
            currentStep = 'corr';
            const sharedHistoryCard = document.getElementById('shared-history-card');
            if (sharedHistoryCard) sharedHistoryCard.classList.add('d-none');
            document.querySelectorAll('.step-tab').forEach(t => t.classList.remove('active-ols', 'active-corr', 'active-roc'));
            const corrTab = document.querySelector('.step-tab[data-step="corr"]');
            if (corrTab) corrTab.classList.add('active-corr');
            document.querySelectorAll('[id^="config-"]').forEach(c => c.classList.add('d-none'));
            const corrConfig = document.getElementById('config-corr');
            if (corrConfig) corrConfig.classList.remove('d-none');
            loadAnalysisResults(entry);
            popup.classList.remove('open');
        };
    });
    popup.querySelectorAll('.corr-history-delete').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const runId = btn.dataset.runId;
            const entry = getHistoryByRunId(runId);
            if (!entry) return;
            const status = normalizeBiomarkerStatus(entry.status);
            const isStale = isTaskStale(entry);
            if ((status === 'pending' || status === 'running') && !isStale) {
                setRunStatus('corr', 'Cannot delete a running task.', 'error');
                return;
            }
            const confirmMsg = isStale && (status === 'pending' || status === 'running')
                ? `Delete this stuck task? (>180 min without heartbeat)`
                : 'Delete this Correlation run?';
            if (!confirm(confirmMsg)) return;
            await deleteHistoryRunIds(new Set([runId]));
            if (selectedHistoryRunId === runId) selectedHistoryRunId = null;
            renderAnalysisHistory();
        };
    });
}

function bindCorrHistoryEvents() {
    const toggle = dom.corrHistoryToggle();
    const popup = dom.corrHistoryPopup();
    if (!toggle || !popup) return;
    toggle.onclick = () => { renderCorrHistoryPopup(); popup.classList.toggle('open'); };
    document.addEventListener('click', (event) => {
        if (!popup.contains(event.target) && !toggle.contains(event.target)) popup.classList.remove('open');
    });
}

// ==================== ROC EXECUTION ====================

document.getElementById('btn-run-roc').onclick = async () => {
    const btn = document.getElementById('btn-run-roc');
    const configCard = document.getElementById('config-roc');
    beginRun();
    setRunStatus('roc', 'Running ROC...');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Processing...';
    configCard.classList.add('processing');
    lockHistory();

    try {
        await saveBiomarkerHistory();
    } catch (e) {
        console.warn('Unable to compact biomarker history before ROC run:', e);
    }

    await updateDoc(doc(db, "projects", projectId), {
        roc_status: 'processing',
        roc_error_msg: null,
        roc_results: null,
        roc_results_url: null,
        roc_csv_url: null
    });
    window.rocResults = null;
    window.rocResultsFull = null;
    rocResultsSourceKey = null;

    setRocLoadingState('Running ROC analysis...');
    document.getElementById('roc-results-container').classList.remove('d-none');

    const sourceOls = selectedRocOlsRunId ? getHistoryByRunId(selectedRocOlsRunId) : null;
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath;
    const metaPath = projectData?.metaCheckedPath;

    if (!matrixPath || !metaPath) {
        setRocEmptyState('No pre-scale/normalized matrix or metadata found.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-chart-area me-2"></i>RUN ROC';
        configCard.classList.remove('processing');
        unlockHistory();
        setRunStatus('roc', 'No pre-scale/normalized matrix or metadata found.', 'error');
        endRun();
        return;
    }

    const target = document.getElementById('roc-target').value;
    const comparison = document.querySelector('.roc-comp-check:checked').value;
    const analysisName = `${document.getElementById('analysis-name').value || 'Analysis'} | ROC`;
    try {
        const startResp = await fetch(`${vpsUrl}/biomarker-roc`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId, uid: auth.currentUser.uid, matrix_path: matrixPath, meta_path: metaPath,
                settings: { analysis_name: analysisName, source_ols_run_id: sourceOls?.run_id || null, source_ols_name: sourceOls?.name || null, target_meta: target, comparisons: [comparison], encoding_map: encSettings,
                    mode: document.getElementById('roc-mode')?.value || 'panel',
                    top_n: parseInt(document.getElementById('roc-cfg-top-n')?.value, 10) || 20,
                    panel_configs: collectRocPanelConfigs(),
                }
            })
        });
        const startPayload = await startResp.json();
        if (!startResp.ok) throw new Error(startPayload.detail || startPayload.message || 'Cannot start ROC analysis.');

        selectedHistoryRunId = startPayload.run_id || null;
        analysisHistory = deduplicateHistory([
            {
                run_id: startPayload.run_id || null,
                task_id: startPayload.task_id ?? null,
                analysis_type: 'roc',
                name: analysisName,
                date: new Date().toISOString(),
                source_ols_run_id: sourceOls?.run_id || null,
                source_ols_name: sourceOls?.name || null,
                roc_target: target,
                roc_comparisons: [comparison],
                status: 'pending',
                message: 'Queued for processing.',
            },
            ...analysisHistory.filter((item) => item.run_id !== startPayload.run_id),
        ]);
        renderAnalysisHistory();
        scrollHistoryIntoPanel();
        setSharedHistoryActive(startPayload.run_id || null);
        setRunStatus('roc', `${analysisName} is pending...`);

        currentRocRunId = startPayload.run_id || null;
    } catch (err) {
        setRocEmptyState(err?.message || 'Cannot start ROC analysis.');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-chart-area me-2"></i>RUN ROC';
        configCard.classList.remove('processing');
        unlockHistory();
        setRunStatus('roc', err?.message || 'Cannot start ROC analysis.', 'error');
        endRun();
        return;
    }

    try {
        const queuedRocRunId = currentRocRunId;
        void waitForBiomarkerTaskCompletion('roc', queuedRocRunId).then(async (d) => {
            if (!d.roc_results && !d.roc_results_url) {
                throw new Error(d.roc_error_msg || 'ROC finished without valid results. Please adjust config and run again.');
            }

            projectData = d;
            // Use history entry as source — it has roc_results summary as fallback if GCS fetch fails
            const histEntry = (d.biomarker_history || []).find(h => h.run_id === queuedRocRunId) || d;
            // Reveal container BEFORE Plotly renders — Plotly on display:none draws 0×0
            document.getElementById('roc-results-container').classList.remove('d-none');
            const full = await ensureRocFullResults(histEntry);
            const summary = (Array.isArray(histEntry.roc_results) && histEntry.roc_results.length)
                ? histEntry.roc_results
                : buildRocSummary(full);
            window.rocResults = summary;
            window.rocResultsFull = full;
            renderRocTable(summary, full);
            renderRocPanel(await fetchRocPanelsFromUrl(histEntry?.roc_results_url || null));
            if (!full || !full.some(r => Array.isArray(r.fpr) && r.fpr.length)) {
                setRocEmptyState('ROC chart data unavailable — curve arrays missing. Try reloading from history.');
            }
            analysisHistory = deduplicateHistory(d.biomarker_history || analysisHistory);
            renderAnalysisHistory();
            selectedHistoryRunId = queuedRocRunId;
            setSharedHistoryActive(queuedRocRunId);
            setRunStatus('roc', `ROC completed (${summary.length} rows).`, 'success');
        }).catch((err) => {
            setRocEmptyState(err?.message || 'ROC analysis failed.');
            setRunStatus('roc', err?.message || 'ROC analysis failed.', 'error');
        });
    } catch (err) {
        setRocEmptyState(err?.message || 'ROC analysis failed.');
        setRunStatus('roc', err?.message || 'ROC analysis failed.', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-chart-area me-2"></i>RUN ROC';
        configCard.classList.remove('processing');
        unlockHistory();
        endRun();
    }
};

// ==================== RENDER TABLES & PLOTS ====================

function renderOlsTable() {
    const sortBy = document.getElementById('sort-by').value;
    const minAbsBeta = Math.max(0, Number(document.getElementById('ols-min-filter')?.value || 0));
    const minR2 = Math.max(0, Number(document.getElementById('ols-min-r2')?.value ?? 0.2));
    const maxPvalue = Math.min(1, Math.max(0, Number(document.getElementById('ols-max-pvalue')?.value ?? 1)));
    const maxFdr = Math.min(1, Math.max(0, Number(document.getElementById('ols-max-fdr')?.value ?? 1)));
    const searchText = String(document.getElementById('ols-search')?.value || '').trim().toLowerCase();
    const rowCountEl = document.getElementById('ols-row-count');
    const tbody = document.querySelector('#ols-table tbody');
    let data = [...olsDataGlobal];
    if (data.length === 0) {
        if (rowCountEl) rowCountEl.innerText = '0 rows';
        tbody.innerHTML = `<tr><td colspan="5" class="py-5 text-muted">No significant results.</td></tr>`;
        return;
    }
    if (sortBy === 'fdr') data.sort((a, b) => a.fdr - b.fdr);
    else if (sortBy === 'adj_r2') data.sort((a, b) => b.adj_r2 - a.adj_r2);
    else if (sortBy === 'beta') data.sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

    data = data.filter((r) => {
        const passBeta = Math.abs(Number(r.beta) || 0) >= minAbsBeta;
        const passR2 = Number(r.adj_r2 || 0) >= minR2;
        const passPvalue = Number(r.p_value ?? 1) <= maxPvalue;
        const passFdr = Number(r.fdr ?? 1) <= maxFdr;
        const passSearch = !searchText || String(r.lipid || '').toLowerCase().includes(searchText);
        return passBeta && passR2 && passPvalue && passFdr && passSearch;
    });

    if (rowCountEl) rowCountEl.innerText = `${data.length} rows`;
    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-5 text-muted">No features match current filter.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(r => {
        const featureName = r.lipid || r.feature || '';
        const isSelected = selectedOlsFeature && selectedOlsFeature === featureName;
        return `<tr class="ols-row ${isSelected ? 'table-primary' : ''}" data-feature="${featureName}" style="cursor:pointer;"><td class="fw-bold text-start ps-3">${featureName}</td><td class="${r.beta > 0 ? 'text-danger' : 'text-primary'} fw-bold">${r.beta.toFixed(3)}</td><td>${r.p_value.toExponential(2)}</td><td>${r.fdr.toFixed(3)}</td><td>${r.adj_r2.toFixed(3)}</td></tr>`;
    }).join('');

    tbody.querySelectorAll('.ols-row').forEach(row => {
        row.onclick = async () => {
            const feature = row.dataset.feature;
            const info = data.find(x => (x.lipid || x.feature || '') === feature);
            if (!info) return;
            selectedOlsFeature = feature;
            renderOlsTable();
            await renderLipidProgressionPanel(info);
        };
    });
}

async function renderLipidProgressionPanel(info) {
    const panel = getOlsVisualPanel();
    if (!panel) return;
    const loadToken = ++progressionLoadToken;
    const featureName = info.lipid || info.feature || '';
    const activeAnalysis = window._currentLoadedAnalysis || {};

    panel.className = 'border rounded bg-white p-2 h-100';
    panel.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mb-2">
            <div class="fw-bold text-dark">${featureName}</div>
            <div class="small text-muted">Loading sample-level progression...</div>
        </div>
        <div id="ols-lipid-progression-chart" style="width:100%; height: calc(100% - 30px); min-height: 220px;"></div>
    `;

    try {
        const targetMeta = activeAnalysis.target || currentOlsTargetMeta || document.getElementById('ols-target').value;
        if (!targetMeta) {
            throw new Error('Missing OLS target variable for progression plot.');
        }

        const cacheKey = getProgressionCacheKey(featureName, activeAnalysis);
        let trend = progressionMemoryCache.get(cacheKey) || null;

        if (!trend && progressionInFlight.has(cacheKey)) {
            trend = await progressionInFlight.get(cacheKey);
        }

        if (!trend) {
            trend = await loadProgressionCache(featureName, activeAnalysis);
            if (trend) {
                progressionMemoryCache.set(cacheKey, trend);
            }
        }

        if (!trend) {
            const fetchPromise = (async () => {
                await ensureProgressionDatasetLoaded();
                return buildProgressionTrendFrontend(featureName, targetMeta, activeAnalysis.encoding_map || encSettings || {});
            })();

            progressionInFlight.set(cacheKey, fetchPromise);
            try {
                trend = await fetchPromise;
                progressionMemoryCache.set(cacheKey, trend);
                saveProgressionCache(featureName, activeAnalysis, trend);
            } finally {
                progressionInFlight.delete(cacheKey);
            }
        }

        if (loadToken !== progressionLoadToken) return;

        const points = trend.points || [];
        const stages = (trend.stages || []).sort((a, b) => a.code - b.code);

        if (points.length === 0 || stages.length === 0) {
            throw new Error('No data points for this lipid.');
        }

        panel.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <div class="fw-bold text-dark">${featureName}</div>
                <div class="small text-muted text-end">${formatOlsMetricSummary(info)}</div>
            </div>
            <div id="ols-lipid-progression-chart" style="width:100%; height: calc(100% - 30px); min-height: 300px;"></div>
        `;

        function hexToRgba(hex, alpha) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        const palette = ['#5B8FF9', '#F6BD16', '#E8684A', '#5AD8A6', '#9270CA', '#FF9D4D'];
        const traces = [];
        

        stages.forEach((stage, idx) => {
            const stagePoints = points.filter(p => Number(p.stage_code) === Number(stage.code));
            const y = stagePoints.map(p => Number(p.abundance));
            const traceColor = palette[idx % palette.length];

            // Combined box + scatter trace: box with all points shown, properly jittered
            // Use numeric x values (stage.code) instead of stage.code, consistent with regression line
            traces.push({
                type: 'box',
                x: new Array(y.length).fill(Number(stage.code)),
                y,
                name: stage.label,
                boxpoints: 'all',
                jitter: 0.4,
                pointpos: 0,
                fillcolor: hexToRgba(traceColor, 0.4),
                line: { color: traceColor, width: 2 },
                marker: { size: olsPlotConfig.markerSize, opacity: olsPlotConfig.markerOpacity },
                customdata: stagePoints.map(p => p.sample),
                hovertemplate: 'Stage: ' + stage.label + '<br>Sample: %{customdata}<br>Abundance: %{y:.4f}<extra></extra>'
            });
        });

        const xMin = Math.min(...stages.map(s => Number(s.code)));
        const xMax = Math.max(...stages.map(s => Number(s.code)));
        const xLine = [];
        const yLine = [];
        const slope = Number(trend.regression?.slope || 0);
        const intercept = Number(trend.regression?.intercept || 0);
        const steps = 60;
        for (let i = 0; i < steps; i++) {
            const x = xMin + ((xMax - xMin) * i) / (steps - 1 || 1);
            xLine.push(x);
            yLine.push((slope * x) + intercept);
        }

        traces.push({
            type: 'scatter',
            mode: 'lines',
            x: xLine,
            y: yLine,
            name: 'Regression trend',
            line: { color: 'darkred', width: 2.4, dash: 'dash' },
            hoverinfo: 'skip',
            showlegend: false,
            zorder: 3
        });

        Plotly.newPlot('ols-lipid-progression-chart', traces, {
            margin: { l: 62, r: 25, t: 18, b: 36 },
            template: 'plotly_white',
            xaxis: {
                title: {font: { size: olsPlotConfig.axisFontSize } },
                tickvals: stages.map(s => Number(s.code)),
                ticktext: stages.map(s => s.label),
                tickfont: { size: olsPlotConfig.axisFontSize },
                showline: true,
                linewidth: 1.2,
                linecolor: '#333',
                zeroline: false,
                range: [xMin - 0.55, xMax + 0.55]
            },
            yaxis: {
                title: { text: 'Normalized Abundance', font: { size: olsPlotConfig.axisFontSize } },
                tickfont: { size: olsPlotConfig.axisFontSize },
                showline: true,
                linewidth: 1.2,
                linecolor: '#333',
                zeroline: false,
                gridcolor: 'rgba(0,0,0,0.08)'
            },
            showlegend: true,
            legend: { font: { size: olsPlotConfig.legendFontSize } }
        }, {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToAdd: ['toggleSpikelines'],
            displaylogo: false,
            toImageButtonOptions: {
                format: olsPlotConfig.imgFormat,
                filename: `${featureName}_progression`,
                height: olsPlotConfig.imgHeight,
                width: olsPlotConfig.imgWidth,
                scale: olsPlotConfig.imgFormat === 'svg' ? 1 : 6
            }
        });
    } catch (err) {
        if (loadToken !== progressionLoadToken) return;
        panel.className = 'border rounded bg-light d-flex align-items-center justify-content-center text-danger small h-100';
        panel.innerHTML = `Cannot render progression chart: ${err.message || err}`;
    }
}

function renderRocTable(results, fullDataSource) {
    clearRocLoadingIndicators();

    const sortBy = document.getElementById('roc-sort-by').value;
    const minAuc = Math.min(1, Math.max(0, Number(document.getElementById('roc-min-auc')?.value || 0)));
    const ciLow = Math.max(0, Number(document.getElementById('roc-ci-low')?.value ?? 0.5));
    const ciHigh = Math.min(1, Math.max(0, Number(document.getElementById('roc-ci-high')?.value ?? 1)));
    const searchText = String(document.getElementById('roc-search')?.value || '').trim().toLowerCase();
    const rowCount = document.getElementById('roc-row-count');

    let data = [...(results || [])].filter((r) => {
        const passAuc = Number(r.auc) >= minAuc;
        const passSearch = !searchText || String(r.lipid || '').toLowerCase().includes(searchText);
        const ciL = r.auc_ci_low != null ? Number(r.auc_ci_low) : Number(r.auc);
        const ciH = r.auc_ci_high != null ? Number(r.auc_ci_high) : Number(r.auc);
        const passCi = ciL >= ciLow && ciH <= ciHigh;
        return passAuc && passSearch && passCi;
    });

    if (sortBy === 'auc_desc') data.sort((a, b) => b.auc - a.auc);
    else if (sortBy === 'auc_asc') data.sort((a, b) => a.auc - b.auc);
    else if (sortBy === 'ci_low_desc') data.sort((a, b) => (b.auc_ci_low ?? b.auc) - (a.auc_ci_low ?? a.auc));
    else if (sortBy === 'ci_high_desc') data.sort((a, b) => (b.auc_ci_high ?? b.auc) - (a.auc_ci_high ?? a.auc));
    else if (sortBy === 'lipid_asc') data.sort((a, b) => String(a.lipid || '').localeCompare(String(b.lipid || '')));

    if (rowCount) rowCount.innerText = `${data.length} rows`;
    if (!data.length) {
        const tbodyEmpty = document.querySelector('#roc-table tbody');
        tbodyEmpty.innerHTML = `<tr><td colspan="6" class="py-3 text-muted">No features match current filter.</td></tr>`;
        setRocEmptyState('No ROC curves match current filter.');
        return;
    }

    const topLipids = data.slice(0, 10);
    const tbody = document.querySelector('#roc-table tbody');
    tbody.innerHTML = data.map(r => {
        const isSelected = topLipids.includes(r);
        const ciLowVal = r.auc_ci_low != null ? Number(r.auc_ci_low).toFixed(3) : '—';
        const ciHighVal = r.auc_ci_high != null ? Number(r.auc_ci_high).toFixed(3) : '—';
        return `<tr style="cursor:pointer;">
            <td><input type="checkbox" class="form-check-input roc-lipid-check" value="${r.lipid}" ${isSelected ? 'checked' : ''}></td>
            <td class="text-start fw-bold">${r.lipid}</td>
            <td class="${r.auc > 0.7 ? 'text-success' : r.auc > 0.5 ? 'text-warning' : 'text-danger'} fw-bold">${r.auc.toFixed(3)}</td>
            <td>${r.cutoff.toFixed(3)}</td>
            <td>${ciLowVal}</td>
            <td>${ciHighVal}</td>
        </tr>`;
    }).join('');

    // Click anywhere on row to toggle checkbox
    tbody.querySelectorAll('tr').forEach(row => {
        row.onclick = (e) => {
            if (e.target.type === 'checkbox') return;
            const cb = row.querySelector('.roc-lipid-check');
            cb.checked = !cb.checked;
            updateRocPlot();
        };
    });

    // Pass explicit top lipids with full-data source to avoid DOM-state race conditions on first render
    const topLipidNames = topLipids.map(r => r.lipid);
    const plotSource = fullDataSource || (window.rocResultsFull && window.rocResultsFull.length ? window.rocResultsFull : null);
    if (plotSource && plotSource.length) {
        updateRocPlotExplicit(topLipidNames, plotSource);
    } else {
        setRocEmptyState('No ROC curve data available.');
    }
}

function renderRocPlot(results) {
    clearRocLoadingIndicators();
    // results should be the full-data array (with fpr/tpr)
    const selectedLipids = Array.from(document.querySelectorAll('.roc-lipid-check:checked')).map(cb => cb.value);
    const plotData = [];
    const plotComparisons = new Set();

    plotData.push({
        x: [0, 1], y: [0, 1], mode: 'lines', name: 'Random (AUC=0.5)', line: { dash: 'dash', color: 'gray' }, showlegend: true
    });

    selectedLipids.forEach(lipid => {
        // Filter all entries for this lipid (may span multiple comparisons)
        const matches = results.filter(res => res.lipid === lipid && Array.isArray(res.fpr) && res.fpr.length && Array.isArray(res.tpr) && res.tpr.length);
        matches.forEach(r => {
            const cutoffVal = Number(r.cutoff);
            const cutoffLabel = Number.isFinite(cutoffVal) ? cutoffVal.toFixed(4) : 'NA';
            if (r.comparison) plotComparisons.add(String(r.comparison));
            plotData.push({
                x: r.fpr, y: r.tpr, mode: 'lines',
                name: `${r.lipid} | AUC=${(r.auc || 0).toFixed(3)} | Cut-off=${cutoffLabel}`,
                line: { width: rocPlotConfig.lineWidth }
            });
        });
    });

    if (plotData.length <= 1) {
        setRocEmptyState('No ROC curve points available for current selection.');
        return;
    }

    const _savedLegendX = Number(rocLegendPosition?.x);
    const _savedLegendY = Number(rocLegendPosition?.y);
    const titlePrefix = plotComparisons.size === 1
        ? [...plotComparisons][0]
        : (plotComparisons.size > 1 ? 'Multiple comparisons' : 'Comparison group');
    const layout = {
        title: { text: `${titlePrefix} ROC Curves`, font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize },
        xaxis: { title: { text: 'False Positive Rate (1 - Specificity)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        yaxis: { title: { text: 'True Positive Rate (Sensitivity)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        showlegend: true,
        legend: {
            x: Number.isFinite(_savedLegendX) ? _savedLegendX : 0.65,
            y: Number.isFinite(_savedLegendY) ? _savedLegendY : 0.15,
            xanchor: 'left',
            yanchor: 'bottom',
            font: { size: rocPlotConfig.legendFontSize }
        },
        autosize: true
    };

    Plotly.newPlot('roc-plot', plotData, layout, { responsive: true, displayModeBar: "hover", scrollZoom: true, displaylogo: false, toImageButtonOptions: { format: rocPlotConfig.imgFormat, width: rocPlotConfig.imgWidth, height: rocPlotConfig.imgHeight, scale: rocPlotConfig.imgFormat === 'svg' ? 1 : 6 } }).then(() => bindRocLegendDrag(document.getElementById('roc-plot')));
}

// Custom free-moving legend drag (delta-based, no anchor snap). Plotly's
// built-in `edits.legendPosition` snaps the legend's anchor corner to the
// cursor on mousedown, which causes a visible jump — especially when grabbing
// the legend in the lower area. This handler moves the legend by the cursor
// delta instead, so it stays under the pointer.
let rocDragState = null; // { el, startClientX, startClientY, startLegX, startLegY }

function bindRocLegendDrag(rocEl) {
    if (!rocEl) return;
    // One-time stylesheet so the legend background captures pointer events
    // and shows a move cursor (Plotly only adds these when edits.legendPosition
    // is enabled, which we disabled to avoid the anchor-snap jump).
    if (!document.getElementById("roc-legend-drag-style")) {
        const style = document.createElement("style");
        style.id = "roc-legend-drag-style";
        style.textContent = "#roc-plot .legend{cursor:move !important;}#roc-plot .legend .bg{pointer-events:all !important;}#roc-panel-curves .legend{cursor:move !important;}#roc-panel-curves .legend .bg{pointer-events:all !important;}";
        document.head.appendChild(style);
    }
    // One-time window listeners (avoid accumulating handlers across re-renders).
    if (!window.__rocLegendWindowBound) {
        window.__rocLegendWindowBound = true;
        window.addEventListener("mousemove", (e) => {
            if (!rocDragState) return;
            const el = rocDragState.el;
            const size = (el._fullLayout && el._fullLayout._size) || {};
            const w = size.w || el.clientWidth;
            const h = size.h || el.clientHeight;
            const dx = (e.clientX - rocDragState.startClientX) / w;
            const dy = -(e.clientY - rocDragState.startClientY) / h; // paper y grows upward
            let nx = rocDragState.startLegX + dx;
            let ny = rocDragState.startLegY + dy;
            nx = Math.max(-0.25, Math.min(1.25, nx));
            ny = Math.max(-0.25, Math.min(1.25, ny));
            rocLegendPosition.x = nx;
            rocLegendPosition.y = ny;
            Plotly.relayout(el, { "legend.x": nx, "legend.y": ny });
        });
        window.addEventListener("mouseup", () => {
            if (!rocDragState) return;
            rocDragState = null;
            document.body.style.userSelect = "";
        });
    }
    // Bind mousedown on the legend node. Plotly has finished rendering by now
    // (called from newPlot().then). Mark the node so we don't double-bind.
    const legend = rocEl.querySelector(".legend");
    if (!legend) return;
    if (legend.__rocDragBound) return;
    legend.__rocDragBound = true;
    legend.style.cursor = "move";

    const onDown = (e) => {
        // Only drag from the legend background; clicking a trace item still
        // toggles that curve's visibility.
        if (e.target.closest && (e.target.closest(".traces") || e.target.closest(".legendtoggle"))) return;
        e.preventDefault();
        e.stopPropagation();
        rocDragState = {
            el: rocEl,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startLegX: Number(rocLegendPosition.x) || 0,
            startLegY: Number(rocLegendPosition.y) || 0,
        };
        document.body.style.userSelect = "none";
    };
    legend.addEventListener("mousedown", onDown);
    legend.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        onDown({ clientX: t.clientX, clientY: t.clientY, target: e.target, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() });
    }, { passive: false });
}

function updateRocPlot() {
    const source = (window.rocResultsFull && window.rocResultsFull.length) ? window.rocResultsFull : window.rocResults;
    if (source) renderRocPlot(source);
}

// For initial render after table build — bypasses DOM checkbox state
function updateRocPlotExplicit(lipidNames, source) {
    if (!source) {
        source = (window.rocResultsFull && window.rocResultsFull.length) ? window.rocResultsFull : window.rocResults;
    }
    if (!source) return;
    const plotData = [
        { x: [0, 1], y: [0, 1], mode: 'lines', name: 'Random (AUC=0.5)', line: { dash: 'dash', color: 'gray' }, showlegend: true }
    ];
    const plotComparisons = new Set();
    lipidNames.forEach(lipid => {
        const r = source.find(res => res.lipid === lipid);
        if (r && Array.isArray(r.fpr) && r.fpr.length && Array.isArray(r.tpr) && r.tpr.length) {
            const cutoffVal = Number(r.cutoff);
            const cutoffLabel = Number.isFinite(cutoffVal) ? cutoffVal.toFixed(4) : 'NA';
            if (r.comparison) plotComparisons.add(String(r.comparison));
            plotData.push({
                x: r.fpr, y: r.tpr, mode: 'lines',
                name: `${lipid} | AUC=${(r.auc || 0).toFixed(3)} | Cut-off=${cutoffLabel}`,
                line: { width: rocPlotConfig.lineWidth }
            });
        }
    });
    if (plotData.length <= 1) {
        setRocEmptyState('No ROC curve points available for current selection.');
        return;
    }
    clearRocLoadingIndicators();
    const _savedLegendX2 = Number(rocLegendPosition?.x);
    const _savedLegendY2 = Number(rocLegendPosition?.y);
    const titlePrefix = plotComparisons.size === 1
        ? [...plotComparisons][0]
        : (plotComparisons.size > 1 ? 'Multiple comparisons' : 'Comparison group');
    Plotly.newPlot('roc-plot', plotData, {
        title: { text: `${titlePrefix} ROC Curves` },
        xaxis: { title: { text: 'False Positive Rate (1 - Specificity)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        yaxis: { title: { text: 'True Positive Rate (Sensitivity)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        showlegend: true,
        legend: {
            x: Number.isFinite(_savedLegendX2) ? _savedLegendX2 : 0.65,
            y: Number.isFinite(_savedLegendY2) ? _savedLegendY2 : 0.15,
            xanchor: 'left',
            yanchor: 'bottom',
            font: { size: rocPlotConfig.legendFontSize }
        },
        autosize: true
    }, { responsive: true, displayModeBar: "hover", scrollZoom: true, displaylogo: false, toImageButtonOptions: { format: rocPlotConfig.imgFormat, width: rocPlotConfig.imgWidth, height: rocPlotConfig.imgHeight, scale: rocPlotConfig.imgFormat === 'svg' ? 1 : 6 } }).then(() => bindRocLegendDrag(document.getElementById('roc-plot')));
}

document.getElementById('roc-sort-by').onchange = () => {
    if (window.rocResults) renderRocTable(window.rocResults);
};
document.getElementById('roc-min-auc').onchange = () => {
    const el = document.getElementById('roc-min-auc');
    const v = Number(el.value);
    el.value = String(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    if (window.rocResults) renderRocTable(window.rocResults);
};
document.getElementById('roc-search').oninput = () => {
    if (window.rocResults) renderRocTable(window.rocResults);
};
document.getElementById('roc-ci-low')?.addEventListener('input', () => { if (window.rocResults) renderRocTable(window.rocResults); });
document.getElementById('roc-ci-high')?.addEventListener('input', () => { if (window.rocResults) renderRocTable(window.rocResults); });

document.getElementById('btn-deselect-all-roc').onclick = () => {
    document.querySelectorAll('.roc-lipid-check').forEach(cb => cb.checked = false);
    updateRocPlot();
};

document.addEventListener('change', e => {
    if (e.target.classList.contains('roc-lipid-check')) updateRocPlot();
});

// Corr feature table controls
document.getElementById('corr-search')?.addEventListener('input', () => refreshCorrTable());
document.getElementById('corr-min-r')?.addEventListener('input', () => refreshCorrTable());
document.getElementById('corr-max-fdr')?.addEventListener('input', () => refreshCorrTable());
document.getElementById('corr-r-display-select')?.addEventListener('change', (event) => {
    currentCorrDisplayKey = String(event?.target?.value || '__best__');
    corrSummaryData = buildCorrLipidSummary(corrRawData, currentCorrDisplayKey);
    refreshCorrTable();
});
document.getElementById('corr-method')?.addEventListener('change', (event) => {
    currentCorrMethod = normalizeCorrMethod(event.target?.value || currentCorrMethod);
    if (window._currentCorrData && window._currentCorrSelectedLipids) {
        updateCorrHeatmap(window._currentCorrSelectedLipids, window._currentCorrData);
    }
});
document.getElementById('btn-deselect-all-corr')?.addEventListener('click', () => {
    const label = document.getElementById('corr-toggle-label');
    if (corrSelectedLipids.size > 0) {
        // Deselect all
        corrSelectedLipids.clear();
        if (label) label.textContent = 'Select All';
        refreshCorrTable(true);
    } else {
        // Select all currently visible rows
        document.querySelectorAll('#corr-feature-table .corr-lipid-check').forEach(cb => corrSelectedLipids.add(cb.value));
        if (label) label.textContent = 'Deselect All';
        refreshCorrTable();
    }
});

// ==================== FILTER/SORT EVENTS ====================

document.getElementById('sort-by').onchange = () => renderOlsTable();
document.getElementById('ols-min-filter').onchange = () => {
    const el = document.getElementById('ols-min-filter');
    const v = Number(el.value);
    el.value = String(Number.isFinite(v) ? Math.max(0, v) : 0);
    renderOlsTable();
};
document.getElementById('ols-search').oninput = () => renderOlsTable();
document.getElementById('ols-min-r2')?.addEventListener('input', () => renderOlsTable());
document.getElementById('ols-max-pvalue')?.addEventListener('input', () => renderOlsTable());
document.getElementById('ols-max-fdr')?.addEventListener('input', () => renderOlsTable());

// ==================== DELETE ====================

document.getElementById('btn-delete-selected').onclick = async () => {
    const checkedBoxes = document.querySelectorAll('.history-checkbox:checked');
    const runIdsToDelete = new Set(Array.from(checkedBoxes).map(cb => cb.value));
    await deleteHistoryRunIds(runIdsToDelete);
    renderAnalysisHistory();
};

document.getElementById('btn-delete-all').onclick = async () => {
    if (confirm('Are you sure you want to delete all analysis history? This cannot be undone.')) {
        const urlsToDelete = analysisHistory.flatMap(collectHistoryEntryUrls);
        analysisHistory = [];
        const projectState = buildBiomarkerProjectState();
        await updateDoc(doc(db, "projects", projectId), projectState);
        projectData = { ...projectData, ...projectState };
        deleteStorageArtifacts(urlsToDelete);
        window._currentLoadedAnalysis = null;
        clearResultsPanel();
        selectedCorrOlsRunId = '';
        selectedRocOlsRunId = '';
        populateOlsInputSelectors();
        syncOlsInputLocks();
        renderAnalysisHistory();
    }
};

// ==================== DOWNLOADS ====================

async function forceDownload(url, filename) {
    const resp = await fetch(url); const blob = await resp.blob();
    const link = document.createElement('a'); link.href = window.URL.createObjectURL(blob); link.download = filename;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

document.getElementById('btn-dl-ols-csv').onclick = () => {
    const url = window._currentLoadedAnalysis?.ols_csv_url || projectData?.ols_csv_url;
    if (!url) return;
    forceDownload(url, "ols_results.csv");
};
document.getElementById('btn-dl-corr-csv').onclick = () => {
    const url = window._currentLoadedAnalysis?.corr_csv_url || projectData?.corr_csv_url;
    if (!url) return;
    forceDownload(url, "Correlation_Data.csv");
};
document.getElementById('btn-dl-roc-csv').onclick = () => {
    const url = window._currentLoadedAnalysis?.roc_csv_url || projectData?.roc_csv_url;
    if (!url) return;
    forceDownload(url, "ROC_Results.csv");
};

// ==================== TAB NAVIGATION ====================

function setupTabNavigation() {
    const colorMap = { ols: 'active-ols', corr: 'active-corr', roc: 'active-roc' };
    document.querySelectorAll('.step-tab').forEach(tab => {
        tab.onclick = () => {
            const step = tab.dataset.step;
            currentStep = step;
            const sharedHistoryCard = document.getElementById('shared-history-card');
            if (sharedHistoryCard) {
                sharedHistoryCard.classList.toggle('d-none', step === 'roc' || step === 'corr');
            }
            // Update tab active state
            document.querySelectorAll('.step-tab').forEach(t => {
                t.classList.remove('active-ols', 'active-corr', 'active-roc');
            });
            tab.classList.add(colorMap[step]);
            // Toggle config cards
            document.querySelectorAll('[id^="config-"]').forEach(c => {
                if (c.id !== 'config-' + step) c.classList.add('d-none');
                else c.classList.remove('d-none');
            });

            const remembered = loadedAnalysisByStep[step] || null;
            if (remembered?.run_id) {
                selectedHistoryRunId = remembered.run_id;
                setSharedHistoryActive(remembered.run_id);
            }

            renderAnalysisHistory();
            showResultsForCurrentStep(remembered || window._currentLoadedAnalysis || null);
            // Force Plotly resize — chart may have been rendered while container was hidden
            if (step === 'roc') {
                requestAnimationFrame(() => { try { Plotly.Plots.resize('roc-plot'); } catch { } });
            } else if (step === 'corr') {
                requestAnimationFrame(() => { try { Plotly.Plots.resize('corr-heatmap-plot'); } catch { } });
            }
        };
    });
}

// ==================== SIDEBAR ====================

async function injectSidebar(uid) {
    const resp = await fetch('sidebar.html');
    const html = await resp.text();
    document.getElementById('sidebar-placeholder').innerHTML = html;
    document.getElementById('sidebar-placeholder').querySelectorAll('script').forEach(old => { const s = document.createElement('script'); s.textContent = old.textContent; document.head.appendChild(s); });
    document.querySelectorAll('#analysis-nav a').forEach(l => {
        const h = l.getAttribute('href');
        if (h && h !== '#') l.href = `${h}?id=${projectId}&uid=${uid}`;
    });
    const activeLink = document.querySelector('#analysis-nav a[href^="biomarker.html"]');
    if (activeLink) {
        document.querySelectorAll('#analysis-nav .nav-link').forEach(l => l.classList.remove('active'));
        activeLink.classList.add('active');
    }

    const terminalHost = document.getElementById('sidebar-terminal-slot');
    if (terminalHost) {
        await mountTerminalWidget({ host: terminalHost, logUrl: `${vpsUrl}/log-stream` });
    }
}

// ── Plot config panels ───────────────────────────────────────────────────────
mountPlotConfigPanel({
    anchor: document.getElementById('ols-config-anchor'),
    defaults: olsPlotConfig,
    options: { showLabelSize: false, showEllipseOpacity: false },
    onUpdate: (_key, _val, allCfg) => {
        Object.assign(olsPlotConfig, allCfg);
        if (selectedOlsFeature) {
            const info = olsDataGlobal.find(x => (x.lipid || x.feature || '') === selectedOlsFeature);
            if (info) renderLipidProgressionPanel(info);
        }
    },
    onDownload: (cfg) => {
        const el = document.getElementById('ols-lipid-progression-chart');
        if (!el || !el.data) return;
        Plotly.downloadImage(el, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === 'svg' ? 1 : 6, filename: 'ols_progression' });
    },
});

mountPlotConfigPanel({
    anchor: document.getElementById('corr-config-anchor'),
    defaults: corrPlotConfig,
    options: { showMarkerSize: false, showMarkerOpacity: false, showLabelSize: false, showEllipseOpacity: false, showLineWidth: false },
    onUpdate: (_key, _val, allCfg) => {
        Object.assign(corrPlotConfig, allCfg);
        if (window._currentCorrData && window._currentCorrSelectedLipids) {
            updateCorrHeatmap(window._currentCorrSelectedLipids, window._currentCorrData);
        }
    },
    onDownload: (cfg) => {
        const el = document.getElementById('corr-heatmap-plot');
        if (!el || !el.data) return;
        Plotly.downloadImage(el, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === 'svg' ? 1 : 6, filename: 'corr_heatmap' });
    },
});

mountPlotConfigPanel({
    anchor: document.getElementById('roc-config-anchor'),
    defaults: rocPlotConfig,
    options: { showMarkerSize: false, showMarkerOpacity: false, showLabelSize: false, showEllipseOpacity: false, showLegendFontSize: true, showLineWidth: true },
    onUpdate: (_key, _val, allCfg) => {
        Object.assign(rocPlotConfig, allCfg);
        updateRocPlot();
        if (rocPanelData && rocPanelData.length) _drawRocPanel();
    },
    onDownload: (cfg) => {
        const el = (rocPanelData && rocPanelData.length)
            ? document.getElementById('roc-panel-curves')
            : document.getElementById('roc-plot');
        if (!el || !el.data) return;
        Plotly.downloadImage(el, { format: cfg.imgFormat, width: cfg.imgWidth, height: cfg.imgHeight, scale: cfg.imgFormat === 'svg' ? 1 : 6, filename: rocPanelData ? 'roc_panel_curves' : 'roc_curves' });
    },
});


// ═══════════════ ROC PANEL (multi-config, 2-group) — renderer ═══════════════
let rocPanelData = null;
let rocPanelCompKey = null;
const rocPanelConfigs = [];       // [{name, features|null, model, include_clinical, clinical_cols}]
let rocCfgPicked = [];            // manual feature picks for the config being built
let rocFeaturePool = null;        // lazily loaded matrix feature list

async function ensureRocFeaturePool() {
    if (rocFeaturePool) return rocFeaturePool;
    const matrixPath = projectData?.matrixPreScalePath || projectData?.matrixNormPath || projectData?.matrixPath;
    if (!matrixPath) return [];
    try {
        const res = await fetch(`${vpsUrl}/files/${matrixPath}`);
        if (!res.ok) return [];
        const text = await res.text();
        rocFeaturePool = text.split(/\r?\n/).slice(1)
            .map((l) => {
                const t = l.trim();
                if (!t) return "";
                if (t[0] === '"') { const m = t.match(/^"((?:[^"]|"")*)"/); return m ? m[1].trim() : ""; }
                return t.split(',')[0].split('\t')[0].trim();
            })
            .filter(Boolean);
    } catch { rocFeaturePool = []; }
    return rocFeaturePool;
}

function renderRocCfgFeatureList() {
    const box = document.getElementById('roc-cfg-feature-list');
    if (!box) return;
    const q = (document.getElementById('roc-cfg-feature-search')?.value || '').toLowerCase();
    const pool = (rocFeaturePool || []).filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 300);
    box.innerHTML = pool.map((f) => {
        const checked = rocCfgPicked.includes(f) ? 'checked' : '';
        const fid = 'roc-cfg-feat-' + makeSafeId(f);
        return `<div class="form-check"><input class="form-check-input roc-cfg-feat-check" type="checkbox" id="${fid}" value="${f}" ${checked}><label class="form-check-label extra-small" for="${fid}">${f}</label></div>`;
    }).join('') || '<div class="extra-small text-muted">No matching feature.</div>';
}

function renderRocCfgList() {
    const box = document.getElementById('roc-cfg-list');
    if (!box) return;
    const badge = document.getElementById('roc-cfg-count');
    if (badge) {
        badge.textContent = rocPanelConfigs.length ? `${rocPanelConfigs.length} active` : '0 active';
        badge.className = 'badge ' + (rocPanelConfigs.length ? 'bg-danger' : 'bg-secondary');
    }
    if (!rocPanelConfigs.length) {
        box.innerHTML = '<div class="extra-small text-muted">No configs added — default: one auto config (top-N greedy, LR).</div>';
        return;
    }
    box.innerHTML = rocPanelConfigs.map((c, i) => `
        <div class="d-flex align-items-center gap-2 border rounded px-2 py-1 bg-white">
            <span class="extra-small fw-bold flex-fill">${c.name}</span>
            <span class="badge bg-light text-dark border">${c.model.toUpperCase()}</span>
            <span class="badge bg-light text-dark border">${c.features ? c.features.length + ' features (manual)' : 'auto top-N'}</span>
            ${c.include_clinical && c.clinical_cols?.length ? `<span class="badge bg-light text-dark border">+${c.clinical_cols.length} clinical</span>` : ''}
            <button class="btn btn-sm btn-link text-danger p-0 roc-cfg-remove" data-idx="${i}" title="Remove config"><i class="fa-solid fa-trash-can"></i></button>
        </div>`).join('');
    box.querySelectorAll('.roc-cfg-remove').forEach((b) => {
        b.onclick = () => { rocPanelConfigs.splice(Number(b.dataset.idx), 1); renderRocCfgList(); };
    });
}

function collectRocPanelConfigs() {
    // Empty => backend runs the single default auto config (one ROC curve for A vs B)
    return rocPanelConfigs.map((c) => ({
        name: c.name,
        features: c.features,
        model: c.model,
        include_clinical: c.include_clinical,
        clinical_cols: c.clinical_cols,
    }));
}

async function addRocPanelConfig() {
    const nameEl = document.getElementById('roc-cfg-name');
    const model = (document.getElementById('roc-cfg-feature-mode')?.value === 'manual')
        ? 'logit'   // manual feature sets are combined with logistic regression
        : (document.getElementById('roc-cfg-model')?.value || 'logit');
    const featMode = document.getElementById('roc-cfg-feature-mode')?.value || 'auto';
    const includeClinical = !!document.getElementById('roc-cfg-include-clinical')?.checked;
    const clinicalCols = includeClinical
        ? Array.from(document.querySelectorAll('.roc-clin-check:checked')).map((c) => c.value)
        : [];
    const features = featMode === 'manual' ? [...rocCfgPicked] : null;
    if (featMode === 'manual' && (!features || !features.length)) {
        alert('Manual mode: pick at least 1 feature.');
        return;
    }
    const name = (nameEl?.value || '').trim() || `Config ${rocPanelConfigs.length + 1}`;
    rocPanelConfigs.push({ name, features, model, include_clinical: includeClinical, clinical_cols: clinicalCols });
    rocCfgPicked = [];
    renderRocCfgFeatureList();
    const pc = document.getElementById('roc-cfg-picked-count');
    if (pc) pc.textContent = '0';
    if (nameEl) nameEl.value = '';
    renderRocCfgList();
    document.getElementById('roc-cfg-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// render entry point — gọi khi ROC results (full JSON) có panels
function renderRocPanel(panels) {
    const section = document.getElementById('roc-panel-section');
    if (!section) return;
    if (!Array.isArray(panels) || !panels.length) {
        section.classList.add('d-none');
        document.getElementById('btn-roc-configs')?.classList.add('d-none');
        document.getElementById('btn-dl-roc-panel-feat')?.classList.add('d-none');
        document.getElementById('roc-panel-table-block')?.classList.add('d-none');
        // gear anchor back to the legacy ROC header
        const gearAnchor = document.getElementById('roc-config-anchor');
        const legacySlot = document.getElementById('roc-config-anchor-legacy');
        if (gearAnchor && legacySlot && gearAnchor.parentElement !== legacySlot) legacySlot.appendChild(gearAnchor);
        // feature mode → legacy per-feature blocks stay visible
        document.getElementById('roc-feature-results-block')?.classList.remove('d-none');
        rocPanelData = null;
        return;
    }
    rocPanelData = panels;
    section.classList.remove('d-none');
    document.getElementById('btn-roc-configs')?.classList.remove('d-none');
    document.getElementById('btn-dl-roc-panel-feat')?.classList.remove('d-none');
    // gear (image download config) follows the visible ROC view
    const gearAnchor = document.getElementById('roc-config-anchor');
    const toolsWrap = document.getElementById('roc-panel-header-tools');
    if (gearAnchor && toolsWrap && gearAnchor.parentElement !== toolsWrap) toolsWrap.prepend(gearAnchor);
    // Panel mode: the panel view replaces the legacy per-feature table/plot
    document.getElementById('roc-results-container')?.classList.add('d-none');
    document.getElementById('roc-feature-results-block')?.classList.add('d-none');
    document.getElementById('roc-panel-table-block')?.classList.remove('d-none');
    const comps = [...new Set(panels.map((p) => p.comparison))];
    if (!rocPanelCompKey || !comps.includes(rocPanelCompKey)) rocPanelCompKey = comps[0];
    // no dropdown: 1 comparison → static badge text; nhiều → pill buttons
    const label = document.getElementById('roc-panel-comp-label');
    const pills = document.getElementById('roc-panel-comp-pills');
    if (comps.length <= 1) {
        if (label) { label.textContent = comps[0] || ''; label.classList.remove('d-none'); }
        if (pills) pills.classList.add('d-none');
    } else {
        if (label) label.classList.add('d-none');
        if (pills) {
            pills.classList.remove('d-none');
            pills.innerHTML = comps.map((c) =>
                `<button type="button" class="btn ${c === rocPanelCompKey ? 'btn-danger' : 'btn-outline-danger'}" data-comp="${c}">${c}</button>`
            ).join('');
            pills.querySelectorAll('[data-comp]').forEach((b) => {
                b.onclick = () => {
                    rocPanelCompKey = b.dataset.comp;
                    pills.querySelectorAll('[data-comp]').forEach((x) => {
                        x.className = `btn ${x.dataset.comp === rocPanelCompKey ? 'btn-danger' : 'btn-outline-danger'}`;
                    });
                    _drawRocPanel();
                };
            });
        }
    }
    _drawRocPanel();
}

function _drawRocPanel() {
    const panels = (rocPanelData || []).filter((x) => x.comparison === rocPanelCompKey);
    if (!panels.length || !window.Plotly) return;
    const palette = ['#27ae60', '#3498db', '#e67e22', '#9b59b6', '#e74c3c', '#16a085', '#f39c12'];

    // one ROC curve per config for the same A vs B comparison
    const traces = panels.map((p, i) => {
        const ci = (p.best.auc_ci_low != null && p.best.auc_ci_high != null)
            ? ` [${Number(p.best.auc_ci_low).toFixed(3)}–${Number(p.best.auc_ci_high).toFixed(3)}]`
            : '';
        return {
            type: 'scatter', mode: 'lines', x: p.best.fpr, y: p.best.tpr,
            name: `${p.config || 'config'} (AUC=${Number(p.best.auc).toFixed(3)}${ci})`,
            line: { width: rocPlotConfig.lineWidth, color: palette[i % palette.length] },
        };
    });
    traces.push({ type: 'scatter', mode: 'lines', x: [0, 1], y: [0, 1], name: 'Chance', line: { color: '#888', dash: 'dot' }, showlegend: false });
    const _legX = Number(rocLegendPosition?.x);
    const _legY = Number(rocLegendPosition?.y);
    Plotly.react('roc-panel-curves', traces, {
        xaxis: { title: { text: '1 - Specificity (FPR)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        yaxis: { title: { text: 'Sensitivity (TPR)', font: { size: rocPlotConfig.axisFontSize } }, tickfont: { size: rocPlotConfig.axisFontSize } },
        margin: { t: 20 },
        legend: {
            x: Number.isFinite(_legX) ? _legX : 0.65,
            y: Number.isFinite(_legY) ? _legY : 0.15,
            xanchor: 'left', yanchor: 'bottom',
            font: { size: rocPlotConfig.legendFontSize },
        },
        autosize: true,
    }, {
        responsive: true, displayModeBar: 'hover', scrollZoom: true, displaylogo: false,
        toImageButtonOptions: { format: rocPlotConfig.imgFormat, width: rocPlotConfig.imgWidth, height: rocPlotConfig.imgHeight, scale: rocPlotConfig.imgFormat === 'svg' ? 1 : 6, filename: 'roc_panel_curves' },
    }).then(() => bindRocLegendDrag(document.getElementById('roc-panel-curves')));

    _fillRocPanelTable(panels);
}

function _fillRocPanelTable(panels) {
    const tbody = document.querySelector('#roc-panel-table tbody');
    if (!tbody) return;
    tbody.innerHTML = panels.map((p, i) => {
        const b = p.best || {};
        return `<tr>
            <td>${i + 1}</td>
            <td class="text-start fw-bold">${p.config || 'config'}</td>
            <td>${(p.model || 'lr').toUpperCase()}</td>
            <td>${p.manual ? (b.members || []).length + ' (manual)' : 'auto top-' + (p.top_n ?? '?')}</td>
            <td>${(p.clinical_cols || []).length ? p.clinical_cols.join(', ') : '—'}</td>
            <td class="fw-bold">${Number(b.auc).toFixed(4)}</td>
            <td>${b.auc_ci_low != null ? Number(b.auc_ci_low).toFixed(4) : '—'}</td>
            <td>${b.auc_ci_high != null ? Number(b.auc_ci_high).toFixed(4) : '—'}</td>
            <td>${b.s90 != null ? Number(b.s90).toFixed(4) : '—'}</td>
            <td>${b.s95 != null ? Number(b.s95).toFixed(4) : '—'}</td>
        </tr>`;
    }).join('');
}

function downloadRocPanelFeatures() {
    const panels = (rocPanelData || []).filter((p) => !rocPanelCompKey || p.comparison === rocPanelCompKey);
    if (!panels.length) { alert('No panel results to export.'); return; }
    const lines = ['comparison,config,rank,feature,weight'];
    for (const p of panels) {
        (p.importance || []).forEach((imp, i) => {
            lines.push(`"${p.comparison}","${p.config || 'config'}",${i + 1},"${imp.feature}",${imp.weight}`);
        });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `roc_panel_top_features_${(rocPanelCompKey || 'panel').replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}
// builder wiring
window.renderRocPanel = renderRocPanel;   // exposed for history-load reuse & tests
document.addEventListener('DOMContentLoaded', () => {
    renderRocCfgList();
    document.getElementById('roc-cfg-add')?.addEventListener('click', addRocPanelConfig);
    document.getElementById('roc-cfg-feature-search')?.addEventListener('input', renderRocCfgFeatureList);
});
document.addEventListener('change', async (e) => {
    if (!e.target || !e.target.id) return;
    if (e.target.id === 'roc-include-clinical' || e.target.id === 'roc-cfg-include-clinical') {
        document.getElementById('roc-clinical-list')?.classList.toggle('d-none', !e.target.checked);
    }
    if (e.target.id === 'roc-mode') {
        document.getElementById('roc-panel-opts')?.classList.toggle('d-none', e.target.value !== 'panel');
    }
    if (e.target.id === 'roc-cfg-feature-mode') {
        const manual = e.target.value === 'manual';
        document.getElementById('roc-cfg-manual-box')?.classList.toggle('d-none', !manual);
        document.getElementById('roc-cfg-model-wrap')?.classList.toggle('d-none', manual);
        const topNWrap = document.getElementById('roc-cfg-topn-wrap');
        if (topNWrap) topNWrap.classList.toggle('d-none', manual);
        if (manual) { await ensureRocFeaturePool(); renderRocCfgFeatureList(); }
    }
    if (e.target.classList?.contains('roc-cfg-feat-check')) {
        const v = e.target.value;
        if (e.target.checked && !rocCfgPicked.includes(v)) rocCfgPicked.push(v);
        if (!e.target.checked) rocCfgPicked = rocCfgPicked.filter((x) => x !== v);
        const pc = document.getElementById('roc-cfg-picked-count');
        if (pc) pc.textContent = String(rocCfgPicked.length);
    }
});

// Panel configs detail popup (beside "ROC Results")
function renderRocConfigsModal() {
    const body = document.getElementById('roc-configs-modal-body');
    if (!body) return;
    const panels = (rocPanelData || []).filter((p) => !rocPanelCompKey || p.comparison === rocPanelCompKey);
    if (!panels.length) {
        body.innerHTML = '<div class="text-muted small">No panel data for the current comparison.</div>';
        return;
    }
    body.innerHTML = panels.map((p, i) => {
        const b = p.best || {};
        const ci = (b.auc_ci_low != null && b.auc_ci_high != null)
            ? `${Number(b.auc_ci_low).toFixed(3)} – ${Number(b.auc_ci_high).toFixed(3)}` : '—';
        const members = (b.members || []).map((m) => `<code class="me-1">${m}</code>`).join('') || '—';
        const clinical = (p.clinical_cols || []).map((m) => `<code class="me-1">${m}</code>`).join('') || '—';
        return `
        <div class="border rounded p-2 mb-2">
            <div class="d-flex flex-wrap align-items-center gap-2 mb-1">
                <span class="fw-bold small text-danger">${i + 1}. ${p.config || 'config'}</span>
                <span class="badge bg-light text-dark border">${(p.model || 'lr').toUpperCase()}</span>
                <span class="badge bg-light text-dark border">${p.manual ? 'manual' : 'auto top-' + (p.top_n || '?')}</span>
                <span class="badge bg-primary">AUC ${Number(b.auc).toFixed(3)} (95% CI ${ci})</span>
                <span class="badge bg-light text-dark border">sens@90% ${Number(b.s90 ?? '—')} · @95% ${Number(b.s95 ?? '—')}</span>
                <span class="badge bg-light text-dark border">n=${p.n_pos}+${p.n_neg}</span>
            </div>
            <div class="extra-small"><span class="text-muted">Features:</span> ${members}</div>
            <div class="extra-small mt-1"><span class="text-muted">Clinical metadata:</span> ${clinical}</div>
        </div>`;
    }).join('');
}
document.getElementById('btn-roc-configs')?.addEventListener('click', () => {
    renderRocConfigsModal();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('roc-configs-modal')).show();
});
document.getElementById('btn-dl-roc-panel-feat')?.addEventListener('click', downloadRocPanelFeatures);
