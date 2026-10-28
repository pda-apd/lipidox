export function parseCsvRow(line) {
    const row = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            row.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    row.push(current);
    return row;
}

export function normalizeGroupValue(value) {
    const text = String(value ?? "").trim();
    if (!text || ["nan", "none", "null"].includes(text.toLowerCase())) return "";
    return text;
}

export function getCleanMetaGroupValues(meta) {
    return [...new Set((meta?.groups || [])
        .map((value) => normalizeGroupValue(value))
        .filter(Boolean))];
}

export function getMetaGroupCountValues(meta) {
    if (!meta?.group_counts || typeof meta.group_counts !== "object") return [];
    return [...new Set(Object.keys(meta.group_counts)
        .map((value) => normalizeGroupValue(value))
        .filter(Boolean))];
}

export function getDistinctMetaValues(columnName, sampleToMeta) {
    if (!(sampleToMeta instanceof Map) || !columnName) return [];
    const values = new Set();
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        values.add(value);
    });
    return [...values];
}

export function getObservedGroupCounts(columnName, sampleToMeta) {
    const counts = new Map();
    if (!(sampleToMeta instanceof Map) || !columnName) return counts;
    sampleToMeta.forEach((metaRow) => {
        const value = normalizeGroupValue(metaRow?.[columnName]);
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
    });
    return counts;
}

export function scoreReconciledMetaValue(columnName, rawValue, getMetaDescriptorByName) {
    const value = String(rawValue ?? "").trim();
    if (!value || value.toLowerCase() === "nan") return 0;

    const meta = getMetaDescriptorByName?.(columnName);
    if (!meta) return value.includes(",") ? 0.5 : 0.25;

    const groups = getCleanMetaGroupValues(meta);
    if (groups.includes(value)) return 6;
    if (String(meta.type || "").toLowerCase() === "continuous" && Number.isFinite(Number(value))) return 4;
    if (groups.length) return -1;
    return value.includes(",") ? 0.5 : 0.25;
}

export function reconcileMetaCsvRow(row, header, getMetaDescriptorByName) {
    const expectedLength = Array.isArray(header) ? header.length : 0;
    if (!expectedLength || row.length === expectedLength) return row;
    if (row.length < expectedLength) return [...row, ...Array(expectedLength - row.length).fill("")];
    if (expectedLength < 2) return row.slice(0, expectedLength);

    const overflow = row.length - expectedLength;
    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let mergeStart = 1; mergeStart <= row.length - (overflow + 1); mergeStart += 1) {
        const candidate = [
            ...row.slice(0, mergeStart),
            row.slice(mergeStart, mergeStart + overflow + 1).join(","),
            ...row.slice(mergeStart + overflow + 1),
        ];
        if (candidate.length !== expectedLength) continue;

        const score = header.slice(1).reduce((total, columnName, index) => {
            return total + scoreReconciledMetaValue(columnName, candidate[index + 1], getMetaDescriptorByName);
        }, 0);

        if (score > bestScore) {
            bestScore = score;
            bestCandidate = candidate;
        }
    }

    return bestCandidate || [...row.slice(0, expectedLength - 1), row.slice(expectedLength - 1).join(",")];
}

export function parseMetaCsv(text, getMetaDescriptorByName) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length < 2) throw new Error("Metadata file is empty.");

    const header = parseCsvRow(lines[0]).map((value) => String(value || "").trim());
    const metaHeader = header.slice(1);
    const sampleToMeta = new Map();

    for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
        const row = reconcileMetaCsvRow(parseCsvRow(lines[rowIndex]), header, getMetaDescriptorByName);
        const sampleId = String(row[0] || "").trim();
        if (!sampleId) continue;

        const values = {};
        for (let columnIndex = 0; columnIndex < metaHeader.length; columnIndex += 1) {
            values[metaHeader[columnIndex]] = row[columnIndex + 1] ?? "";
        }
        sampleToMeta.set(sampleId, values);
    }

    return { metaHeader, sampleToMeta };
}
