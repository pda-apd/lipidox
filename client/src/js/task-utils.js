export const TASK_TIMEOUT_MS = 180 * 60 * 1000;

const STATUS_BADGE_CLASS = {
    pending: "bg-secondary-subtle text-secondary border border-secondary-subtle",
    running: "bg-warning-subtle text-warning-emphasis border border-warning-subtle",
    done: "bg-success-subtle text-success-emphasis border border-success-subtle",
    error: "bg-danger-subtle text-danger-emphasis border border-danger-subtle",
};

const STATUS_LABEL = {
    pending: "Pending",
    running: "Running",
    done: "Done",
    error: "Error",
};

export function nowIso() {
    return new Date().toISOString();
}

export function normalizeTaskStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    if (value === "completed" || value === "success" || value === "ready" || value === "ok") return "done";
    if (value === "failed") return "error";
    if (value === "processing") return "running";
    if (value === "queued") return "pending";
    return ["pending", "running", "done", "error"].includes(value) ? value : "done";
}

export function formatTaskId(item) {
    const value = item?.task_id;
    return value ? `Task #${value}` : "Task pending";
}

export function getTaskStatusBadge(status) {
    const normalized = normalizeTaskStatus(status);
    return `<span class="badge rounded-pill ${STATUS_BADGE_CLASS[normalized] || STATUS_BADGE_CLASS.done}">${STATUS_LABEL[normalized] || STATUS_LABEL.done}</span>`;
}

export function getTaskActivityTime(item) {
    if (!item) return null;
    return item.heartbeat_at || item.updated_at || item.completed_at || item.started_at || item.date || null;
}

export function isTaskExpired(item, timeoutMs = TASK_TIMEOUT_MS) {
    const activityTime = getTaskActivityTime(item);
    if (!activityTime) return false;
    const startedAt = Date.parse(activityTime);
    if (!Number.isFinite(startedAt)) return false;
    return Date.now() - startedAt > timeoutMs;
}

export async function prepareAnalysisTask(vpsUrl, projectId, analysisKey, extraHeaders = {}) {
    const response = await fetch(`${vpsUrl}/analysis-task/prepare`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...extraHeaders,
        },
        body: JSON.stringify({
            project_id: projectId,
            analysis_key: analysisKey,
        }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.detail || "Failed to prepare task.");
    }
    return {
        run_id: data.run_id,
        task_id: data.task_id,
        started_at: data.started_at || nowIso(),
    };
}

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = TASK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });

        const rawText = await response.text();
        let data = {};
        if (rawText) {
            try {
                data = JSON.parse(rawText);
            } catch {
                data = { detail: rawText };
            }
        }

        return { response, data };
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("Task timed out after 180 minutes.");
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}