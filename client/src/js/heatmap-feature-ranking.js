function normalizeLabel(value) {
    const text = String(value ?? "").trim();
    if (!text || ["nan", "none", "null"].includes(text.toLowerCase())) return "NaN";
    return text;
}

function toFiniteOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function parseCsvRow(line) {
    const values = [];
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
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}

function parseCsv(text) {
    const lines = String(text || "")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    if (!lines.length) return { header: [], rows: [] };
    return {
        header: parseCsvRow(lines[0]),
        rows: lines.slice(1).map(parseCsvRow),
    };
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function scaleRow(values, scaleMode) {
    if (String(scaleMode || "row_zscore").toLowerCase() !== "row_zscore") {
        return [...values];
    }

    const finite = values.filter((value) => Number.isFinite(value));
    if (!finite.length) return values.map(() => null);
    const rowMean = mean(finite);
    const variance = finite.reduce((sum, value) => sum + ((value - rowMean) ** 2), 0) / Math.max(1, finite.length - 1);
    const std = Math.sqrt(variance);
    if (!Number.isFinite(std) || std === 0) {
        return values.map((value) => (Number.isFinite(value) ? 0 : null));
    }
    return values.map((value) => (Number.isFinite(value) ? (value - rowMean) / std : null));
}

function parseTopFeatureCount(viewMode) {
    const match = String(viewMode || "manual").match(/^top_(\d+)$/i);
    return match ? Number(match[1]) : null;
}

function buildCandidate(feature, label, targetValues, otherValues) {
    const targetMean = mean(targetValues);
    const otherMean = mean(otherValues);
    if (!Number.isFinite(targetMean) || !Number.isFinite(otherMean)) return null;

    const effect = targetMean - otherMean;
    if (!(effect > 0)) return null;

    const targetMedian = median(targetValues) ?? targetMean;
    const otherMedian = median(otherValues) ?? otherMean;
    const targetCoverage = targetValues.length
        ? targetValues.filter((value) => value > otherMean).length / targetValues.length
        : 0;
    const exclusionCoverage = otherValues.length
        ? otherValues.filter((value) => value < targetMean).length / otherValues.length
        : 0;
    const coverage = (targetCoverage + exclusionCoverage) / 2;
    const medianLift = Math.max(0, targetMedian - otherMedian);
    const score = (effect * (0.55 + coverage)) + (medianLift * 0.35);

    return {
        feature,
        label,
        score,
        effect,
        coverage,
        targetMean,
        otherMean,
        targetCoverage,
        exclusionCoverage,
    };
}

export function buildDatasetFromCsvTexts(matrixText, metaText) {
    const matrixParsed = parseCsv(matrixText);
    const metaParsed = parseCsv(metaText);

    const sampleIds = matrixParsed.header.slice(1);
    const features = [];
    const featureToValues = new Map();
    matrixParsed.rows.forEach((row) => {
        const feature = String(row[0] || "").trim();
        if (!feature) return;
        features.push(feature);
        featureToValues.set(feature, row.slice(1).map(toFiniteOrNull));
    });

    const metaHeader = metaParsed.header.slice(1);
    const metaBySample = new Map();
    const metaValueMap = new Map(metaHeader.map((column) => [column, new Set()]));

    metaParsed.rows.forEach((row) => {
        const sampleId = String(row[0] || "").trim();
        if (!sampleId) return;
        const values = {};
        metaHeader.forEach((column, index) => {
            const normalized = normalizeLabel(row[index + 1]);
            values[column] = normalized;
            metaValueMap.get(column)?.add(normalized);
        });
        metaBySample.set(sampleId, values);
    });

    return {
        sampleIds,
        features,
        featureToValues,
        metaBySample,
        metaValueMap: new Map([...metaValueMap.entries()].map(([column, labels]) => [column, [...labels]])),
    };
}

export function computeTopFeaturesPerLabel({
    sampleIds,
    features,
    featureToValues,
    metaBySample,
    metaCol,
    selectedLabels,
    labelOrder,
    topN,
    scaleMode,
}) {
    const topCount = Number(topN);
    if (!Number.isFinite(topCount) || topCount <= 0) {
        return { orderedFeatures: [], featureSet: new Set(), labelSections: [], error: "Invalid top-feature count." };
    }

    const selectedLabelSet = new Set((selectedLabels || []).map((label) => normalizeLabel(label)));
    const sampleRows = [];
    (sampleIds || []).forEach((sampleId, sampleIndex) => {
        const label = normalizeLabel(metaBySample?.get(sampleId)?.[metaCol]);
        if (!selectedLabelSet.has(label)) return;
        sampleRows.push({ sampleId, sampleIndex, label });
    });

    const orderedLabels = (labelOrder || [])
        .map((label) => normalizeLabel(label))
        .filter((label, index, array) => selectedLabelSet.has(label) && array.indexOf(label) === index);

    if (orderedLabels.length < 2) {
        return { orderedFeatures: [], featureSet: new Set(), labelSections: [], error: "Choose at least two labels for top-feature view." };
    }
    if (!sampleRows.length) {
        return { orderedFeatures: [], featureSet: new Set(), labelSections: [], error: "No samples matched the selected labels." };
    }

    const candidatesByLabel = new Map(orderedLabels.map((label) => [label, []]));
    const usageCount = new Map();

    (features || []).forEach((feature) => {
        const values = featureToValues?.get(feature) || [];
        const selectedValues = sampleRows.map((row) => values[row.sampleIndex]);
        const scaledValues = scaleRow(selectedValues, scaleMode);

        orderedLabels.forEach((label) => {
            const targetValues = [];
            const otherValues = [];
            sampleRows.forEach((row, index) => {
                const value = scaledValues[index];
                if (!Number.isFinite(value)) return;
                if (row.label === label) targetValues.push(value);
                else otherValues.push(value);
            });
            if (!targetValues.length || !otherValues.length) return;
            const candidate = buildCandidate(feature, label, targetValues, otherValues);
            if (!candidate) return;
            candidatesByLabel.get(label)?.push(candidate);
            usageCount.set(feature, (usageCount.get(feature) || 0) + 1);
        });
    });

    orderedLabels.forEach((label) => {
        candidatesByLabel.get(label)?.sort((left, right) => (
            (right.score - left.score) ||
            (right.coverage - left.coverage) ||
            (right.effect - left.effect) ||
            left.feature.localeCompare(right.feature, undefined, { numeric: true, sensitivity: "base" })
        ));
    });

    const allocatedByLabel = new Map(orderedLabels.map((label) => [label, []]));
    const cursors = new Map(orderedLabels.map((label) => [label, 0]));
    const usedFeatures = new Set();
    let progress = true;

    while (progress && orderedLabels.some((label) => (allocatedByLabel.get(label)?.length || 0) < topCount)) {
        progress = false;
        orderedLabels.forEach((label) => {
            const allocations = allocatedByLabel.get(label) || [];
            if (allocations.length >= topCount) return;
            const candidates = candidatesByLabel.get(label) || [];
            let cursor = cursors.get(label) || 0;
            while (cursor < candidates.length && usedFeatures.has(candidates[cursor].feature)) {
                cursor += 1;
            }
            cursors.set(label, cursor);
            if (cursor >= candidates.length) return;
            const candidate = candidates[cursor];
            allocations.push(candidate);
            usedFeatures.add(candidate.feature);
            cursors.set(label, cursor + 1);
            progress = true;
        });
    }

    const labelSections = orderedLabels
        .map((label) => ({
            label,
            features: (allocatedByLabel.get(label) || []).map((candidate) => candidate.feature),
        }))
        .filter((section) => section.features.length > 0)
        .map((section) => ({ ...section, count: section.features.length }));

    const orderedFeatures = labelSections.flatMap((section) => section.features);
    const shortLabels = labelSections.filter((section) => section.count < topCount).map((section) => `${section.label} (${section.count}/${topCount})`);
    const overlapCount = [...usageCount.values()].filter((count) => count > 1).length;

    return {
        orderedFeatures,
        featureSet: new Set(orderedFeatures),
        labelSections,
        overlapCount,
        summary: shortLabels.length
            ? `Top ${topCount}/label selected ${orderedFeatures.length} unique features. Some labels could not reach quota: ${shortLabels.join(", ")}.`
            : `Top ${topCount}/label selected ${orderedFeatures.length} unique features across ${labelSections.length} labels.${overlapCount ? ` Overlap candidates resolved: ${overlapCount}.` : ""}`,
        error: orderedFeatures.length ? "" : "No discriminative features were found for the selected labels.",
    };
}

export { normalizeLabel, parseTopFeatureCount };