import "./auth-gate.js";
import { db, storage, auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "./firebase-config.js";
import { ref, uploadBytesResumable, getDownloadURL } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp, onSnapshot, doc, updateDoc, query, where, getDocs, deleteDoc } from "./firebase-config.js";
import { getStorage, ref as storageRef, listAll, deleteObject } from "./firebase-config.js";
import { mountTerminalWidget } from "./terminal-widget.js";
import { vpsUrl } from "./auth-gate.js";

const PREPROCESS_MODE = "preprocess_portal";
const uploadForm = document.getElementById('upload-form');
const btnProcess = document.getElementById('btn-process');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('upload-progress');
const statusText = document.getElementById('status-text');
const errorContainer = document.getElementById('vps-error-container');
const errorMessage = document.getElementById('error-message');
const errorDetails = document.getElementById('error-details');
const dismissErrorButton = document.getElementById('btn-dismiss-error');
const uploadModeSelect = document.getElementById('upload-mode');

initializeTerminalWidget();

const fileBindings = [
    { inputId: 'matrix-file', zoneId: 'matrix-zone', nameId: 'matrix-name-display' },
    { inputId: 'nist-file', zoneId: 'nist-zone', nameId: 'nist-name-display' },
    { inputId: 'is-file', zoneId: 'is-zone', nameId: 'is-name-display' },
    { inputId: 'meta-file', zoneId: 'meta-zone', nameId: 'meta-name-display' },
];

onAuthStateChanged(auth, (user) => {
    if (user) {
        if (document.getElementById("author-menu-drd")) {
            renderUserMenu(user);
        } else {
            window.addEventListener('headerLoaded', () => renderUserMenu(user));
        }
    }
});

function renderUserMenu(user) {
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
        window.location.href = "./index.html";
    };
}

function initializeTerminalWidget() {
    const host = document.getElementById('shared-terminal-host');
    if (!host || host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';
    mountTerminalWidget({ host, variant: 'floating-left' }).catch((error) => {
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
            if (!data || !(data.is_example === true || data.extra?.is_example === true)) continue;
            await deleteDoc(doc(db, "projects", docSnap.id));
        }
    } catch (err) {
        console.warn("[cleanupExampleProjects] Non-fatal error:", err.message);
    }
}

const uploadFile = (file, path) => {
    return new Promise((resolve, reject) => {
        const storageRef = ref(storage, path);
        const uploadTask = uploadBytesResumable(storageRef, file);

        uploadTask.on('state_changed',
            (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                progressBar.style.width = progress + '%';
                statusText.textContent = `Uploading: ${file.name} (${Math.round(progress)}%)`;
            },
            (error) => reject(error),
            () => getDownloadURL(uploadTask.snapshot.ref).then((url) => resolve(url))
        );
    });
};

function setFileUi(inputId, zoneId, nameId) {
    const input = document.getElementById(inputId);
    const zone = document.getElementById(zoneId);
    const nameDisplay = document.getElementById(nameId);
    if (!input || !zone || !nameDisplay) return;

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        if (input.files && input.files[0]) {
            nameDisplay.textContent = input.files[0].name;
            zone.classList.add('file-selected');
        } else {
            nameDisplay.textContent = 'filename.csv';
            zone.classList.remove('file-selected');
        }
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function hideInlineError() {
    errorContainer.classList.add('d-none');
    errorMessage.textContent = '';
    errorDetails.innerHTML = '';
}

function showInlineError(message, details = []) {
    errorMessage.textContent = message;

    const detailLines = Array.isArray(details)
        ? details.filter(Boolean)
        : [details].filter(Boolean);

    errorDetails.innerHTML = detailLines.length
        ? `<strong>Details:</strong><br>${detailLines.map((line) => escapeHtml(line)).join('<br>')}`
        : '';

    errorContainer.classList.remove('d-none');
}

function resetProgressUi() {
    progressContainer.classList.add('d-none');
    progressBar.style.width = '0%';
    statusText.textContent = 'Preparing...';
}

function resetFormUi() {
    uploadForm.reset();
    fileBindings.forEach(({ inputId, zoneId, nameId }) => {
        const input = document.getElementById(inputId);
        const zone = document.getElementById(zoneId);
        const nameDisplay = document.getElementById(nameId);

        if (input) {
            input.value = '';
        }
        if (zone) {
            zone.classList.remove('file-selected');
        }
        if (nameDisplay) {
            nameDisplay.textContent = 'filename.csv';
        }
    });

    btnProcess.disabled = false;
    hideInlineError();
    resetProgressUi();
    updateUploadModeUi();
}

function updateUploadModeUi() {
    const isPreprocessMode = uploadModeSelect.value === PREPROCESS_MODE;
    document.querySelectorAll('.portal-only').forEach((element) => {
        element.classList.toggle('d-none', !isPreprocessMode);
    });
    document.querySelectorAll('.standard-only').forEach((element) => {
        element.classList.toggle('d-none', isPreprocessMode);
    });

    document.getElementById('matrix-label').textContent = isPreprocessMode ? 'Raw Matrix File (.csv)' : 'Matrix File (.csv)';
    document.getElementById('matrix-prompt').textContent = isPreprocessMode ? 'Choose Raw Matrix File' : 'Choose Matrix File';

    if (!isPreprocessMode) {
        ['nist-file', 'is-file'].forEach((inputId) => {
            const input = document.getElementById(inputId);
            if (input) {
                input.value = '';
            }
        });
        ['nist-zone', 'is-zone'].forEach((zoneId) => {
            const zone = document.getElementById(zoneId);
            if (zone) {
                zone.classList.remove('file-selected');
            }
        });
        ['nist-name-display', 'is-name-display'].forEach((labelId) => {
            const label = document.getElementById(labelId);
            if (label) {
                label.textContent = 'filename.csv';
            }
        });
    }
}

function getMissingRequiredFiles({ rawProjectName, matrixFile, metaFile, nistFile, isFile, isPreprocessMode }) {
    const missing = [];

    if (!rawProjectName) missing.push('project name');
    if (!matrixFile) missing.push(isPreprocessMode ? 'raw matrix CSV' : 'matrix CSV');
    if (!metaFile) missing.push('metadata CSV');
    if (isPreprocessMode && !nistFile) missing.push('NIST CSV');
    if (isPreprocessMode && !isFile) missing.push('IS CSV');

    return missing;
}

fileBindings.forEach(({ inputId, zoneId, nameId }) => setFileUi(inputId, zoneId, nameId));
uploadModeSelect.addEventListener('change', updateUploadModeUi);
updateUploadModeUi();
dismissErrorButton?.addEventListener('click', hideInlineError);

document.getElementById('btn-clear').addEventListener('click', () => {
    resetFormUi();
});

uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const rawProjectName = document.getElementById('project-name').value.trim();
    const uploadMode = uploadModeSelect.value;
    const matrixFile = document.getElementById('matrix-file').files[0];
    const nistFile = document.getElementById('nist-file').files[0];
    const isFile = document.getElementById('is-file').files[0];
    const metaFile = document.getElementById('meta-file').files[0];
    const user = auth.currentUser;
    const isPreprocessMode = uploadMode === PREPROCESS_MODE;

    if (!user) {
        showInlineError('Session expired.', 'Please login again.');
        return;
    }
    const missingRequiredFiles = getMissingRequiredFiles({
        rawProjectName,
        matrixFile,
        metaFile,
        nistFile,
        isFile,
        isPreprocessMode,
    });
    if (missingRequiredFiles.length) {
        showInlineError('Missing required fields.', `Please provide: ${missingRequiredFiles.join(', ')}.`);
        return;
    }

    const cleanProjectName = rawProjectName.toLowerCase().replace(/[^a-z0-9]/g, '_');

    btnProcess.disabled = true;
    hideInlineError();
    progressContainer.classList.remove('d-none');
    statusText.textContent = "Initializing project...";

    try {
        const projectRef = await addDoc(collection(db, "projects"), {
            uid: user.uid,
            projectName: cleanProjectName,
            status: "pending",
            uploadMode,
            matrixPath: "", 
            matrixRawPath: "",
            matrixPreprocessedPath: "",
            metaPath: "",
            nistPath: "",
            isPath: "",
            createdAt: serverTimestamp()
        });
        const projectId = projectRef.id;

        const mPath = `projects/${user.uid}/${projectId}/${isPreprocessMode ? 'matrix_raw.csv' : 'matrix.csv'}`;
        const nPath = `projects/${user.uid}/${projectId}/nist.csv`;
        const isPath = `projects/${user.uid}/${projectId}/is.csv`;
        const mePath = `projects/${user.uid}/${projectId}/metadata.csv`;

        await uploadFile(matrixFile, mPath);
        if (isPreprocessMode) {
            await uploadFile(nistFile, nPath);
            await uploadFile(isFile, isPath);
        }
        await uploadFile(metaFile, mePath);

        const payload = {
            metaPath: mePath,
        };
        if (isPreprocessMode) {
            payload.matrixRawPath = mPath;
            payload.nistPath = nPath;
            payload.isPath = isPath;
        } else {
            payload.matrixPath = mPath;
        }
        await updateDoc(doc(db, "projects", projectId), payload);

        statusText.textContent = isPreprocessMode
            ? "Files uploaded! Starting preprocessing and validation..."
            : "Files uploaded! Triggering dataset validation...";

        const response = await fetch(`${vpsUrl}/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                uid: user.uid,
                upload_mode: uploadMode,
                matrix_path: isPreprocessMode ? null : mPath,
                matrix_raw_path: isPreprocessMode ? mPath : null,
                nist_path: isPreprocessMode ? nPath : null,
                is_path: isPreprocessMode ? isPath : null,
                meta_path: mePath
            })
        });

        if (!response.ok) throw new Error("VPS Connection failed.");

        statusText.textContent = isPreprocessMode
            ? "Waiting for preprocessing and integrity review..."
            : "Waiting for data integrity check...";
        
        const unsub = onSnapshot(doc(db, "projects", projectId), (docSnap) => {
            const data = docSnap.data();

            if (data.status === "integrity_success") {
                unsub(); 
                statusText.textContent = "Success! Redirecting...";
                setTimeout(() => {
                    window.location.href = `dataintegritycheck.html?id=${projectId}&uid=${user.uid}`;
                }, 1000);
            } 
            else if (data.status === "integrity_error") {
                unsub();
                btnProcess.disabled = false;
                resetProgressUi();
                showInlineError(data.message || "Data mismatch found.", data.details || []);
            }
        });

    } catch (err) {
        console.error(err);
        btnProcess.disabled = false;
        resetProgressUi();
        showInlineError('System error.', err.message);
    }
});