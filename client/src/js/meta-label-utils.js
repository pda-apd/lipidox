export function isNanLikeLabel(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return !text || text === "nan";
}

export function normalizeMetaLabel(value) {
    if (value === null || value === undefined) return "NaN";
    const text = String(value).trim();
    if (!text) return "NaN";
    if (text.toLowerCase() === "nan") return "NaN";
    return text;
}

function toNumericLabel(value) {
    const normalized = normalizeMetaLabel(value);
    if (normalized === "NaN") return { isNumeric: false, value: NaN };
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
        return { isNumeric: false, value: NaN };
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return { isNumeric: false, value: NaN };
    return { isNumeric: true, value: parsed };
}

export function sortMetadataLabels(labels) {
    const unique = [...new Set((labels || []).map((value) => normalizeMetaLabel(value)))];
    return unique.sort((a, b) => {
        const aNan = isNanLikeLabel(a);
        const bNan = isNanLikeLabel(b);
        if (aNan !== bNan) return aNan ? 1 : -1;

        const aNum = toNumericLabel(a);
        const bNum = toNumericLabel(b);
        if (aNum.isNumeric && bNum.isNumeric) return aNum.value - bNum.value;
        if (aNum.isNumeric !== bNum.isNumeric) return aNum.isNumeric ? 1 : -1;

        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    });
}

/**
 * Order a list of labels according to a saved group order (e.g.
 * meta_metadata[].groups). Labels present in `groups` keep the groups order;
 * any extra labels are appended at the end (sorted). Labels are normalized
 * (case-insensitive "nan" -> "NaN") for matching.
 *
 * @param {string[]} labels  - the distinct labels to order.
 * @param {string[]|undefined} groups - the desired order (may be undefined).
 * @returns {string[]} labels reordered.
 */
export function orderLabelsByGroups(labels, groups) {
    const unique = [...new Set((labels || []).map((value) => normalizeMetaLabel(value)))];
    if (!Array.isArray(groups) || !groups.length) return sortMetadataLabels(unique);
    const ordered = [];
    const seen = new Set();
    const normKey = (s) => String(s ?? "").trim().toLowerCase();
    for (const g of groups) {
        const key = normKey(g);
        const match = unique.find((u) => normKey(u) === key);
        if (match && !seen.has(key)) {
            ordered.push(match);
            seen.add(key);
        }
    }
    const rest = sortMetadataLabels(unique.filter((u) => !seen.has(normKey(u))));
    return [...ordered, ...rest];
}
