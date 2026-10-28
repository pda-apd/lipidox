// firebase-config.js — Firebase-compatible shim using JWT + REST API
// Drop-in replacement for the Firebase SDK, backed by the local server.
// Exports every Firebase symbol used across the LipidPortal client so that
// existing ES module imports continue to work after swapping the gstatic
// URLs for "./firebase-config.js".

const API_BASE = window.location.origin.startsWith("http://localhost:5")
    ? "http://localhost:8000"
    : "";  // Same origin when served from backend (port 8000 or tunnel)

// ─── Token Management ──────────────────────────────────────────
const TOKEN_KEY = "lipidportal_token";
const USER_KEY = "lipidportal_user";

export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("userSession");
}

export function getStoredUser() {
    try {
        return JSON.parse(localStorage.getItem(USER_KEY));
    } catch {
        return null;
    }
}

// ─── Global fetch interceptor ──────────────────────────────────
// Automatically attach the Bearer token to every fetch call that targets
// the backend API or file-serving endpoints. Local file fetches (relative
// paths like ./sidebar.html) are left untouched.
const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : "");
    const isLocalAsset =
        url.startsWith("./") ||
        url.startsWith("../") ||
        url.startsWith("header") ||
        url.startsWith("sidebar") ||
        url.endsWith(".html");

    // Mock /storage/delete — no such endpoint in the REST backend;
    // file cleanup is handled by DELETE /projects/{id}.
    if (url.includes("/storage/delete")) {
        return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (!isLocalAsset) {
        const token = getToken();
        if (token) {
            init = init || {};
            const existingHeaders = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
            if (!existingHeaders.has("Authorization")) {
                existingHeaders.set("Authorization", `Bearer ${token}`);
            }
            init.headers = existingHeaders;
        }
    }
    return _originalFetch(input, init);
};

// ─── HTTP Helpers ──────────────────────────────────────────────
async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }
    const response = await _originalFetch(`${API_BASE}${path}`, { ...options, headers });
    if (!response.ok) {
        let detail = response.statusText;
        try {
            const errBody = await response.json();
            if (typeof errBody?.detail === "string") detail = errBody.detail;
            else if (Array.isArray(errBody?.detail))
                detail = errBody.detail.map((i) => i.msg || JSON.stringify(i)).join("; ");
            else if (typeof errBody?.message === "string") detail = errBody.message;
        } catch (_) {}
        const error = new Error(detail || `HTTP ${response.status}`);
        error.code = `http_${response.status}`;
        throw error;
    }
    return response;
}

async function apiJson(path, options = {}) {
    const response = await apiFetch(path, options);
    return response.json();
}

// ─── flattenProjectData ────────────────────────────────────────
// Merges the nested {paths, extra} from the REST API into a flat dict
// so all existing analysis JS that reads projectData.matrixNormPath etc.
// works without modification. Also converts ISO timestamps into
// Firestore-like Timestamp objects with toDate()/toMillis().
export function flattenProjectData(projectData) {
    if (!projectData) return null;
    const flat = {};
    // 1. Merge extra first (lowest priority — extra.status should NOT
    //    overwrite project.status)
    if (projectData.extra) Object.assign(flat, projectData.extra);
    // 2. Merge path fields (medium priority)
    if (projectData.paths) Object.assign(flat, projectData.paths);
    // 3. Top-level fields (highest priority) — skip nested objects
    for (const [key, value] of Object.entries(projectData)) {
        if (key !== "paths" && key !== "extra" && key !== "tasks") {
            flat[key] = value;
        }
    }
    if (flat.name && !flat.projectName) flat.projectName = flat.name;
    if (flat.uid) flat.uid = flat.uid;
    if (!flat.id && projectData.id) flat.id = projectData.id;

    const toTimestamp = (iso) => {
        if (!iso) return null;
        const d = typeof iso.toDate === "function" ? iso.toDate() : new Date(iso);
        return {
            toDate: () => d,
            toMillis: () => d.getTime(),
            seconds: Math.floor(d.getTime() / 1000),
            nanoseconds: 0,
        };
    };
    if (flat.created_at) flat.createdAt = toTimestamp(flat.created_at);
    if (flat.updated_at) flat.updatedAt = toTimestamp(flat.updated_at);
    if (flat.lastAccessedAt && typeof flat.lastAccessedAt === "string") {
        flat.lastAccessedAt = toTimestamp(flat.lastAccessedAt);
    }
    return flat;
}

// ─── Auth Shim ─────────────────────────────────────────────────
const authListeners = [];

export const auth = {
    get currentUser() {
        const user = getStoredUser();
        if (!user) return null;
        return {
            uid: user.id,
            email: user.email,
            getIdToken: async () => getToken(),
        };
    },
};

export function onAuthStateChanged(authInstance, callback) {
    const user = getStoredUser();
    if (user) {
        callback({
            uid: user.id,
            email: user.email,
            getIdToken: async () => getToken(),
        });
    } else {
        callback(null);
    }
    return () => {};
}

export async function signInWithEmailAndPassword(authInstance, email, password) {
    const data = await apiJson("/auth/login-json", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    });
    setToken(data.token, data.user);
    authListeners.forEach((fn) => fn(auth.currentUser));
    return { user: auth.currentUser };
}

export async function createUserWithEmailAndPassword(authInstance, email, password) {
    const data = await apiJson("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    });
    setToken(data.token, data.user);
    return { user: auth.currentUser };
}

export async function signOut(authInstance) {
    clearToken();
    authListeners.forEach((fn) => fn(null));
}

export function getAuth() {
    return auth;
}

// ─── Firestore Shim ────────────────────────────────────────────
export const db = {};

export function doc(dbInstance, collection, id) {
    return { type: "doc", collection, id };
}

export function collection(dbInstance, name) {
    return { type: "collection", name };
}

export async function getDoc(ref) {
    if (ref.type !== "doc") throw new Error("Invalid doc ref");
    try {
        const data = await apiJson(`/projects/${ref.id}`);
        const flat = flattenProjectData(data);
        return {
            exists: () => !!flat,
            data: () => flat,
            id: ref.id,
        };
    } catch (err) {
        if (err.code === "http_404") {
            return { exists: () => false, data: () => undefined, id: ref.id };
        }
        throw err;
    }
}

export async function getDocs(queryRef) {
    const projects = await apiJson("/projects");
    const docs = projects.map((p) => {
        const flat = flattenProjectData(p);
        return { id: p.id, data: () => flat };
    });
    return {
        empty: docs.length === 0,
        docs,
        forEach: (fn) => docs.forEach(fn),
        size: docs.length,
    };
}

export async function addDoc(collectionRef, data) {
    const name = data.projectName || data.name || "Untitled";
    const created = await apiJson("/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
    });
    const projectId = created.id;
    // Persist any additional fields via PATCH (paths / extra).
    const patch = {};
    const pathFields = {};
    const extraFields = {};
    for (const [key, value] of Object.entries(data)) {
        if (["projectName", "name", "uid", "createdAt", "status", "message"].includes(key)) continue;
        if (key.endsWith("Path") || key.endsWith("url") || key.endsWith("_url")) {
            pathFields[key] = value;
        } else {
            extraFields[key] = _serializeValue(value);
        }
    }
    if (Object.keys(pathFields).length) patch.paths = pathFields;
    if (Object.keys(extraFields).length) patch.extra = extraFields;
    if (data.status) patch.status = data.status;
    if (data.message) patch.message = data.message;
    if (Object.keys(patch).length) {
        await apiJson(`/projects/${projectId}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
        });
    }
    return { id: projectId };
}

const DELETE_FIELD_SENTINEL = Symbol("deleteField");

function _serializeValue(value) {
    if (value && typeof value === "object" && value.__isDeleteField) return null;
    if (value && typeof value.toDate === "function") return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    return value;
}

export async function updateDoc(ref, data) {
    const update = {};
    if (data.projectName) update.name = data.projectName;
    if (data.name) update.name = data.name;
    if (data.status) update.status = data.status;
    if (data.message !== undefined) update.message = data.message;

    const pathFields = {};
    const extraFields = {};
    for (const [key, value] of Object.entries(data)) {
        if (["projectName", "name", "status", "message"].includes(key)) continue;
        if (key.endsWith("Path") || key.endsWith("url") || key.endsWith("_url")) {
            pathFields[key] = _serializeValue(value);
        } else {
            extraFields[key] = _serializeValue(value);
        }
    }
    if (Object.keys(pathFields).length) update.paths = pathFields;
    if (Object.keys(extraFields).length) update.extra = extraFields;

    return await apiJson(`/projects/${ref.id}`, {
        method: "PATCH",
        body: JSON.stringify(update),
    });
}

export async function deleteDoc(ref) {
    return await apiFetch(`/projects/${ref.id}`, { method: "DELETE" });
}

export function query(collectionRef, ...constraints) {
    return { type: "query", collection: collectionRef, constraints };
}

export function where(field, op, value) {
    return { type: "where", field, op, value };
}

export function orderBy(field, direction) {
    return { type: "orderBy", field, direction };
}

export function serverTimestamp() {
    return new Date().toISOString();
}

export function deleteField() {
    return { __isDeleteField: true };
}

// onSnapshot — polls GET /projects/{id} and fires callback on change.
const SNAPSHOT_POLL_MS = 2000;

export function onSnapshot(ref, callback, errorCallback) {
    let stopped = false;
    let lastSignature = null;
    const projectId = ref.id;

    const tick = async () => {
        if (stopped) return;
        try {
            const data = await apiJson(`/projects/${projectId}`);
            const flat = flattenProjectData(data);
            const signature = JSON.stringify(flat);
            if (signature !== lastSignature) {
                lastSignature = signature;
                callback({
                    exists: () => !!flat,
                    data: () => flat,
                    id: projectId,
                });
            }
        } catch (err) {
            if (errorCallback) errorCallback(err);
        }
        if (!stopped) setTimeout(tick, SNAPSHOT_POLL_MS);
    };
    tick();
    return () => {
        stopped = true;
    };
}

// ─── Storage Shim ──────────────────────────────────────────────
export const storage = {};

export function getStorage() {
    return storage;
}

export function ref(storageInstance, path) {
    return { type: "storage", path };
}

export async function getDownloadURL(refObj) {
    const p = String(refObj.path || "").replace(/^\/+/, "");
    return `${API_BASE}/files/${p}`;
}

function _parseStoragePath(path) {
    // path like "projects/{uid}/{projectId}/{...relPath}"
    // relPath may include subdirectories, e.g. "mutilgroup/anova_manual_meta_x.csv".
    const raw = String(path || "").trim().replace(/^\/+/, "");
    const parts = raw.split("/");
    let projectId = null;
    let relPath = null;
    let filename = null;
    if (parts.length >= 4 && parts[0] === "projects") {
        projectId = parts[2];
        relPath = parts.slice(3).join("/");          // preserve subdirectories
        filename = parts[parts.length - 1];
    } else {
        relPath = parts[parts.length - 1];
        filename = parts[parts.length - 1];
    }
    return { projectId, filename, relPath };
}

function _kindFromFilename(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.includes("meta")) return "metadata";
    if (lower.includes("nist")) return "nist";
    if (lower.includes("_raw") || lower.includes("raw")) return "matrix_raw";
    if (lower.includes("is.csv") || lower.includes("istd") || lower.includes("/is") || lower.startsWith("is.")) return "is";
    if (lower.endsWith(".csv") || lower.includes("matrix")) return "matrix";
    return "results";
}

export function uploadBytesResumable(refObj, file) {
    const { projectId, filename, relPath } = _parseStoragePath(refObj.path);
    const kind = _kindFromFilename(filename);
    let settled = false;
    const task = {
        on: (event, next, error, complete) => {
            if (event !== "state_changed") return;
            // Fire progress immediately (upload not started yet)
            if (next) next({ bytesTransferred: 0, totalBytes: file.size });
            // Perform the actual upload asynchronously
            (async () => {
                try {
                    const formData = new FormData();
                    formData.append("kind", kind);
                    if (relPath) formData.append("path", relPath);
                    formData.append("file", file, filename || file.name);
                    await apiFetch(`/upload/${projectId}`, { method: "POST", body: formData });
                    if (next) next({ bytesTransferred: file.size, totalBytes: file.size });
                    if (complete) complete();
                } catch (err) {
                    if (error) error(err);
                }
            })();
        },
        snapshot: {
            bytesTransferred: 0,
            totalBytes: file.size,
            ref: refObj,
        },
    };
    return task;
}

export async function uploadString(refObj, data, format, metadata) {
    const { projectId, filename, relPath } = _parseStoragePath(refObj.path);
    if (!projectId) throw new Error("Cannot resolve project id from storage path: " + refObj.path);
    const contentType = metadata?.contentType || "text/plain";
    const blob = new Blob([data], { type: contentType });
    const file = new File([blob], filename || "upload.txt", { type: contentType });
    const kind = _kindFromFilename(filename);
    const formData = new FormData();
    formData.append("kind", kind);
    if (relPath) formData.append("path", relPath);
    formData.append("file", file);
    await apiFetch(`/upload/${projectId}`, { method: "POST", body: formData });
    return { ref: refObj };
}

export async function deleteObject(refObj) {
    // No dedicated delete-file endpoint — silently succeed.
    // Project deletion via DELETE /projects/{id} handles bulk cleanup.
    return;
}

export async function listAll(refObj) {
    return { items: [], prefixes: [] };
}

// ─── Expose API_BASE for consumers ─────────────────────────────
export { API_BASE };
