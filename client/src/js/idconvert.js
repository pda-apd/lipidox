import "./auth-gate.js";
import { auth, onAuthStateChanged } from "./firebase-config.js";
import { vpsUrl } from "./auth-gate.js";

// Columns shown in the on-screen preview (full 76-column set is in the CSV download).
const PREVIEW_COLS = [
    "Input.Name", "Goslin.Class", "main_class", "sub_class",
    "LIPIDMAPS", "SwissLipids", "HMDB", "KEGG", "LION_ID", "Note",
];

// 384-lipid legacy panel (v1 notation) — the demo example for this tool.
const EXAMPLE_384 = String.raw`AcylCarnitine 10:0
AcylCarnitine 12:0
AcylCarnitine 12:1
AcylCarnitine 13:0
AcylCarnitine 14:0
AcylCarnitine 14:0_OH
AcylCarnitine 14:1
AcylCarnitine 14:1_OH
AcylCarnitine 14:2
AcylCarnitine 15:0
AcylCarnitine 16:0
AcylCarnitine 16:0_OH
AcylCarnitine 16:1
AcylCarnitine 18:0
AcylCarnitine 18:1
AcylCarnitine 18:2
AcylCarnitine 20:4
AcylCarnitine 24:0
CE 14:0
CE 16:0
CE 16:1
CE 16:2
CE 17:1
CE 18:0
CE 18:1
CE 18:2
CE 18:2_OH
CE 18:3
CE 20:1
CE 20:2
CE 20:3
CE 20:4
CE 20:5
CE 22:1
CE 22:4
CE 22:5
CE 22:6
CE 24:0
CE 24:1
CE 24:6
Cer(d16:1/22:0)
Cer(d16:1/23:0)
Cer(d16:1/24:0)
Cer(d16:1/24:1)
Cer(d17:1/22:0)
Cer(d17:1/24:0)
Cer(d17:1/24:1)
Cer(d18:1/16:0)
Cer(d18:1/18:0)
Cer(d18:1/20:0)
Cer(d18:1/21:0)
Cer(d18:1/22:0)
Cer(d18:1/23:0)
Cer(d18:1/24:0)
Cer(d18:1/24:1)
Cer(d18:1/26:0)
Cer(d18:2/16:0)
Cer(d18:2/22:0)
Cer(d18:2/23:0)
Cer(d18:2/24:0)
Cer(d18:2/24:1)
Cer(d19:1/22:0)
Cer(d19:1/23:0)
Cer(d19:1/24:0)
Cer(d19:1/24:1)
Cer(d20:1/23:0)
Cer(d20:1/24:0)
Cer(d20:1/24:1)
Cer(d20:1/26:0)
Cer(m18:0/24:1)
Cer(m18:1/20:0)
Cer(m18:1/22:0)
Cer(m18:1/23:0)
Cer(m18:1/24:0)
Cer(m18:1/24:1)
COH (161)
DG 32:0 -(16:0)
DG 32:1 -(16:1)
DG 34:1 -(18:1)
DG 34:2 -(18:2)
DG 36:1 -(18:1)
DG 36:2 -(18:1)
DG 36:2 -(18:2)
DG 36:3 -(18:2)
DG 36:4 -(18:2)
DG 36:4 -(20:4)
DG 38:4 -(20:3)
DG 38:4 -(20:4)
DG 38:5 -(20:4)
DG 38:6 -(20:4)
dhCer 18:0
dhCer 24:1
dimethyl-CE 18:2
dimethyl-CE 20:4
GM3(d18:1/16:0)
GM3(d18:1/20:0)
GM3(d18:2/24:1)
Hex1Cer(d16:1/22:0)
Hex1Cer(d16:1/24:0)
Hex1Cer(d18:1/16:0)
Hex1Cer(d18:1/18:0)
Hex1Cer(d18:1/22:0)
Hex1Cer(d18:1/24:0)
Hex1Cer(d18:1/24:1)
Hex1Cer(d18:2/22:0)
Hex1Cer(d18:2/24:0)
Hex2Cer(d16:1/16:0)
Hex2Cer(d18:1/16:0)
Hex2Cer(d18:1/18:0)
Hex2Cer(d18:1/22:0)
Hex2Cer(d18:1/24:0)
Hex2Cer(d18:1/24:1)
Hex2Cer(d18:2/16:0)
Hex2Cer(d18:2/24:1)
Hex3Cer(d18:1/16:0)
Hex3Cer(d18:1/18:0)
Hex3Cer(d18:1/22:0)
Hex3Cer(d18:1/24:0)
Hex3Cer(d18:1/24:1)
LPC 14:0
LPC 15:0
LPC 16:0
LPC 16:1
LPC 17:0
LPC 17:1
LPC 17:1 (a) [sn1] [104_sn1]
LPC 18:0
LPC 18:1
LPC 18:2
LPC 18:3
LPC 18:3(104)
LPC 19:0
LPC 19:0 (a) [sn1] [104_sn1]
LPC 19:1
LPC 20:0
LPC 20:1
LPC 20:2
LPC 20:3
LPC 20:3(104)
LPC 20:4
LPC 20:5
LPC 22:0
LPC 22:1
LPC 22:4
LPC 22:5
LPC 22:5(104)
LPC 22:6
LPC 24:0
LPC(15-MHDA) [sn1] [104_sn1]
LPC(O-16:0)
LPC(O-18:0)
LPC(O-18:1)
LPC(O-20:0)
LPC(O-22:0)
LPC(O-22:1)
LPC(O-24:0)
LPC(O-24:1)
LPC(O-24:2)
LPC(P-16:0)
LPC(P-18:0)
LPC(P-18:1)
LPE 16:0
LPE 18:0
LPE 18:1
LPE 18:2
LPE 20:4
LPE 22:6
LPE(P-16:0)
LPE(P-18:0)
PC 28:0
PC 30:0
PC 31:0(a\b)
PC 31:1
PC 32:0
PC 32:1
PC 32:2
PC 33:0(a\b)
PC 33:1
PC 33:2
PC 34:0
PC 34:1
PC 34:2
PC 34:2_OH
PC 34:3(a\b\c)
PC 34:4
PC 34:5
PC 35:1(a\b)
PC 35:2(a\b)
PC 35:3(a\b)
PC 35:4
PC 35:5
PC 36:1
PC 36:2(a\b)
PC 36:3(a\b\c)
PC 36:4(a\b)
PC 36:5(a\b)
PC 36:6(a\b)
PC 37:4(a\b)
PC 37:6
PC 38:2
PC 38:3
PC 38:4(a\b\c)
PC 38:5(a\b)
PC 38:6(a\b)
PC 38:7(a\b\c)
PC 39:6(a\b)
PC 40:4(a\b)
PC 40:5(a\b)
PC 40:6
PC 40:7(a\b\c)
PC 40:8
PC(O-32:0)
PC(O-32:1)
PC(O-32:2)
PC(O-34:1)
PC(O-34:2)
PC(O-34:4)
PC(O-35:4)
PC(O-36:2)(a\b)
PC(O-36:3)(a\b)
PC(O-36:4)
PC(O-36:5)
PC(O-38:4)
PC(O-38:5)
PC(O-38:6)
PC(O-40:6)
PC(O-40:7)
PC(P-30:0)
PC(P-32:0)
PC(P-32:1)
PC(P-34:1)
PC(P-34:2)
PC(P-34:3)
PC(P-35:2)(a\b)
PC(P-35:4)(a\b)
PC(P-36:2)(a\b)
PC(P-36:3)
PC(P-36:4)
PC(P-36:5)
PC(P-37:4)(a\b)
PC(P-38:4)
PC(P-38:5)
PC(P-38:6)
PC(P-40:6)
PC(P-40:7)
PE 32:0
PE 32:1
PE 34:1
PE 34:2
PE 36:1
PE 36:2(a\b)
PE 36:3(a\b)
PE 36:4
PE 38:3(a\b)
PE 38:4
PE 38:5(a\b)
PE 38:6
PE 40:6
PE 40:7
PE(18:0_22:5)
PE(O-34:1)
PE(O-36:3)(a\b)
PE(O-36:4)
PE(O-38:4)(a\b)
PE(O-40:5)
PE(P-16:0/18:2)
PE(P-16:0/20:3)
PE(P-16:0/20:4)
PE(P-16:0/20:5)
PE(P-16:0/22:4)
PE(P-16:0/22:5)
PE(P-16:0/22:6)
PE(P-17:0/20:4)(a\b)
PE(P-17:0/22:6)(a\b)
PE(P-18:0/18:2)
PE(P-18:0/20:3)
PE(P-18:0/20:4)
PE(P-18:0/20:5)
PE(P-18:0/22:6)
PE(P-18:1/18:2)
PE(P-18:1/20:4)
PE(P-18:1/20:5)
PE(P-18:1/22:6)(a\b)
PE(P-20:0/18:2)
PE(P-20:0/20:4)
PE(P-20:0/22:6)
PG 34:1
PI 32:0
PI 32:1
PI 34:1
PI 35:1
PI 35:2
PI 36:1
PI 36:2
PI 36:3(a\b\c)
PI 36:4
PI 37:4(a\b)
PI 38:3(a\b)
PI 38:4
PI 38:5(a\b)
PI 38:6
PI 40:6
PI(18:0_22:5)
S1P(d18:0)
S1P(d18:1)
S1P(d18:2)
SM 31:1
SM 32:0
SM 32:1
SM 32:2
SM 33:1
SM 34:0
SM 34:1
SM 34:2
SM 34:3
SM 35:1(a\b)
SM 35:2(a\b)
SM 36:1
SM 36:2
SM 36:3
SM 37:1
SM 37:2
SM 38:1
SM 38:2
SM 38:3(a\b)
SM 39:1
SM 40:0
SM 40:1
SM 40:2(a\b)
SM 40:3(a\b\c)
SM 41:0
SM 41:1
SM 41:2(a\b)
SM 42:1
SM 42:2(a\b)
SM 43:1
SM 43:2(a\b\c)
SM 44:2
SM 44:3(a\b)
TG(48:0)
TG(48:1)
TG(48:2)
TG(48:3)
TG(49:1)
TG(50:1)
TG(50:0)
TG(50:2)
TG(50:3)
TG(50:4)
TG(51:0)
TG(51:1)
TG(51:2)
TG(52:1)
TG(52:2)
TG(52:3)
TG(52:4)
TG(52:5)
TG(53:2)
TG(54:0)
TG(54:1)
TG(54:2)
TG(54:3)
TG(54:4)
TG(54:5)
TG(54:6)
TG(54:7)
TG(56:6)
TG(56:7)
TG(56:8)
TG(56:9)
TG(58:8)
TG(58:9)
TG(58:10)
TG(O-50:1)
TG(O-50:2)
TG(O-50:3)
TG(O-52:0)
TG(O-52:1)
TG(O-52:2)
TG(O-54:2)
TG(O-54:3)
TG(O-54:4)
Ubiquinol
Ubiquinone`;

let current = null;            // last conversion result
let activeFilter = "all";

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    // Portal convention: links carry ?uid=; a mismatched uid in the URL means
    // this link belongs to another account — force re-login.
    const urlUid = new URLSearchParams(window.location.search).get("uid");
    if (urlUid && urlUid !== user.uid) {
        window.location.replace("./login.html");
        return;
    }
    document.getElementById("btn-run").onclick = runConversion;
    document.getElementById("btn-download").onclick = downloadCsv;
    document.getElementById("btn-reset").onclick = resetInput;
    document.getElementById("btn-example").onclick = loadExample;
    document.getElementById("btn-upload").onclick = () => document.getElementById("file-input").click();
    document.getElementById("file-input").onchange = handleFileUpload;
    document.querySelectorAll(".filter-btn").forEach((b) => {
        b.onclick = () => {
            activeFilter = b.dataset.filter;
            document.querySelectorAll(".filter-btn").forEach((x) => x.classList.toggle("active", x === b));
            renderTable();
        };
    });
});

function getInputNames() {
    return document.getElementById("names-input").value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function resetInput() {
    document.getElementById("names-input").value = "";
    document.getElementById("input-status").textContent = "";
    document.getElementById("file-input").value = "";
    current = null;
    document.getElementById("stats-box").classList.add("d-none");
    document.getElementById("warnings-box").classList.add("d-none");
    document.getElementById("filter-group").classList.add("d-none");
    document.getElementById("btn-download").classList.add("d-none");
    document.getElementById("result-body").innerHTML = '<tr><td class="text-muted small p-3">No results yet.</td></tr>';
    document.getElementById("table-note").textContent = "";
    document.getElementById("names-input").focus();
}

function loadExample() {
    document.getElementById("names-input").value = EXAMPLE_384;
    const n = EXAMPLE_384.split("\n").length;
    document.getElementById("input-status").textContent = `Loaded ${n} example lipid names (legacy 384-lipid panel).`;
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("input-status");
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const text = String(reader.result || "");
            const lines = text.split(/\r?\n/).filter((l) => l.trim());
            if (!lines.length) throw new Error("empty file");
            // delimiter: tsv if first line contains a tab, else comma
            const delim = lines[0].includes("\t") ? "\t" : ",";
            let rows = lines.map((l) => l.split(delim)[0].trim().replace(/^"|"$/g, ""));
            // drop a header row if the first cell is a header-ish label
            if (rows.length && /^(feature|name|lipid|id|compound)/i.test(rows[0])) {
                rows = rows.slice(1);
            }
            rows = rows.filter(Boolean);
            document.getElementById("names-input").value = rows.join("\n");
            statusEl.textContent = `Loaded ${rows.length} names from "${file.name}" (first column).`;
        } catch (err) {
            console.error(err);
            statusEl.textContent = `Could not parse "${file.name}".`;
        }
    };
    reader.readAsText(file);
}

async function runConversion() {
    const btn = document.getElementById("btn-run");
    const names = getInputNames();
    if (!names.length) {
        alert("Paste lipid names (one per line), upload a file, or load the example first.");
        return;
    }

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Converting…`;
    try {
        const res = await fetch(`${vpsUrl}/idconvert`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names }),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            throw new Error(detail);
        }
        current = await res.json();
        renderResult(current);
    } catch (err) {
        console.error(err);
        alert(err.message || "Conversion failed.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-bolt me-1"></i> Convert IDs`;
    }
}

function isRecognized(row) {
    // Recognized = goslin parse succeeded and produced a Species.Name.
    // Rows that only got an inferred category but no species-level parse stay
    // Unrecognized.
    return Boolean(String(row["Goslin.Species"] || "").trim());
}

function filteredRows() {
    const rows = current?.rows || [];
    if (activeFilter === "recognized") return rows.filter(isRecognized);
    if (activeFilter === "unrecognized") return rows.filter((r) => !isRecognized(r));
    return rows;
}

function renderResult(data) {
    const s = data.stats || {};
    const statsBox = document.getElementById("stats-box");
    statsBox.className = "alert alert-info small mb-3";
    statsBox.innerHTML =
        `<i class="fa-solid fa-circle-info me-2"></i>` +
        `<b>${s.mapped_resource}</b>/${s.unique} mapped to cross-database IDs · ` +
        `<b>${s.mapped_lion}</b> with LION characteristics · ` +
        `<b>${(data.rows || []).filter(isRecognized).length}</b> recognized · ` +
        `<b>${(data.rows || []).filter((r) => !isRecognized(r)).length}</b> unrecognized (no Species.Name)`;
    statsBox.classList.remove("d-none");

    const warnBox = document.getElementById("warnings-box");
    if (data.warnings && data.warnings.length) {
        warnBox.classList.remove("d-none");
        warnBox.innerHTML =
            `<b>${data.warnings.length} name(s) need attention</b> (unmapped or vendor/alias style — fix before pathway/network analysis):<br>` +
            data.warnings.slice(0, 50).map((w) => `<code>${escapeHtml(w)}</code>`).join(", ") +
            (data.warnings.length > 50 ? ` … (+${data.warnings.length - 50} more in CSV)` : "");
    } else {
        warnBox.classList.add("d-none");
    }

    // filter buttons with counts
    const all = (data.rows || []).length;
    const rec = (data.rows || []).filter(isRecognized).length;
    const unrec = all - rec;
    const btns = document.querySelectorAll(".filter-btn");
    btns.forEach((b) => {
        const k = b.dataset.filter;
        b.textContent = k === "all" ? `All (${all})` : k === "recognized" ? `Recognized (${rec})` : `Unrecognized (${unrec})`;
    });
    document.getElementById("filter-group").classList.remove("d-none");

    renderTable();
    document.getElementById("btn-download").classList.remove("d-none");
}

function renderTable() {
    if (!current) return;
    const rows = filteredRows();
    const head = document.getElementById("result-head");
    head.innerHTML = PREVIEW_COLS.map((c) => `<th>${c}</th>`).join("");
    const body = document.getElementById("result-body");
    body.innerHTML = rows.length
        ? rows.map((r) => "<tr>" + PREVIEW_COLS.map((c) => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("") + "</tr>").join("")
        : `<tr><td class="text-muted small p-3">No rows in this filter.</td></tr>`;

    document.getElementById("table-note").textContent =
        `Showing ${rows.length}/${current.total_rows} rows (preview columns). ` +
        `The CSV download contains all rows and the full 76-column annotation table.`;
}

async function downloadCsv() {
    if (!current?.download_token) return;
    // honor the active filter client-side? No — download always carries the full table.
    const res = await fetch(`${vpsUrl}/idconvert/download/${current.download_token}`);
    if (!res.ok) {
        alert("Download failed (export expired?). Re-run the conversion.");
        return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "id_conversion.csv";
    a.click();
    URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
