import { sortMetadataLabels } from "./meta-label-utils.js";

const MAX_LEVELS = 3;
const DEFAULT_MAX_GROUPS = 8;
let splitTemplateCache = null;

function cloneTemplate(template) {
    return template.content.cloneNode(true);
}

async function loadSplitTemplate() {
    if (splitTemplateCache) return splitTemplateCache;
    const response = await fetch("./splitmeta.html");
    if (!response.ok) throw new Error(`Unable to load splitmeta template (HTTP ${response.status}).`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const style = doc.getElementById("splitmeta-style");
    if (style && !document.getElementById("splitmeta-style")) {
        document.head.appendChild(style.cloneNode(true));
    }
    const configTemplate = doc.getElementById("splitmeta-config-template");
    const workspaceTemplate = doc.getElementById("splitmeta-workspace-template");
    if (!configTemplate || !workspaceTemplate) {
        throw new Error("Splitmeta template is incomplete.");
    }
    splitTemplateCache = { configTemplate, workspaceTemplate };
    return splitTemplateCache;
}

function sanitizeGroupName(value, fallback) {
    const raw = String(value || fallback || "Group").trim().replace(/\s+/g, " ");
    return raw || fallback || "Group";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeCsvValue(value) {
    const text = String(value ?? "");
    if (!/[",\n\r]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function buildNodeKey(parentKey, levelIndex, value) {
    return `${parentKey}__L${levelIndex + 1}__${value}`;
}

function createGroupId(index) {
    return `group_${index + 1}`;
}

function createDefaultLevels() {
    return Array.from({ length: MAX_LEVELS }, () => ({ column: "" }));
}

function parseFilterNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function createRangeFilterKey(parentKey, levelIndex) {
    return `${parentKey}__L${Number(levelIndex) + 1}`;
}

function buildRangeSelectionKey(nodeKey, min, max) {
    const minToken = min === null || min === undefined ? "" : String(min);
    const maxToken = max === null || max === undefined ? "" : String(max);
    return `${nodeKey}__RANGE__${minToken}__${maxToken}`;
}

function isContinuousMeta(meta) {
    return String(meta?.type || "").trim().toLowerCase() === "continuous";
}

function inferContinuousFromValues(values = []) {
    const nonMissing = values
        .map((value) => String(value ?? "").trim())
        .filter((text) => text && text.toLowerCase() !== "nan");
    if (!nonMissing.length) return false;

    let numericCount = 0;
    let hasDecimalLike = false;
    const numericValues = [];

    nonMissing.forEach((text) => {
        const numeric = Number(text);
        if (!Number.isFinite(numeric)) return;
        numericCount += 1;
        numericValues.push(numeric);
        if (text.includes(".") || /e/i.test(text)) hasDecimalLike = true;
    });

    if (numericCount !== nonMissing.length) return false;
    const uniqueNumeric = new Set(numericValues.map((value) => String(value))).size;
    if (hasDecimalLike) return true;
    return uniqueNumeric > 5;
}

function createDefaultGroups(defaultGroupNames = [], groupCount = 2) {
    return Array.from({ length: groupCount }, (_, index) => ({
        id: createGroupId(index),
        name: sanitizeGroupName(defaultGroupNames[index], `group${index + 1}`),
        nodeKeys: [],
    }));
}

function normalizeLegacySnapshot(snapshot, options) {
    const groupNames = [];
    if (snapshot?.group1_name) groupNames.push(snapshot.group1_name);
    if (snapshot?.group2_name) groupNames.push(snapshot.group2_name);
    const groups = createDefaultGroups(groupNames.length ? groupNames : options.defaultGroupNames, 2).map((group, index) => ({
        ...group,
        nodeKeys: Array.isArray(snapshot?.selectedBranchKeys?.[`group${index + 1}`])
            ? [...snapshot.selectedBranchKeys[`group${index + 1}`]]
            : [],
    }));
    return {
        version: 4,
        activeGroupId: groups[0]?.id || null,
        levelConfigs: Array.from({ length: MAX_LEVELS }, (_, index) => ({ column: snapshot?.levelConfigs?.[index]?.column || "" })),
        groups,
    };
}

function normalizeSnapshot(snapshot, options) {
    if (!snapshot || typeof snapshot !== "object") {
        return {
            version: 4,
            activeGroupId: null,
            levelConfigs: createDefaultLevels(),
            groups: createDefaultGroups(options.defaultGroupNames, options.minGroups),
        };
    }

    if (Array.isArray(snapshot.groups)) {
        const groups = snapshot.groups.map((group, index) => ({
            id: group.id || createGroupId(index),
            name: sanitizeGroupName(group.name, options.defaultGroupNames[index] || `group${index + 1}`),
            nodeKeys: Array.isArray(group.nodeKeys) ? [...new Set(group.nodeKeys.filter(Boolean))] : [],
        }));
        return {
            version: 4,
            activeGroupId: snapshot.activeGroupId || groups[0]?.id || null,
            levelConfigs: Array.from({ length: MAX_LEVELS }, (_, index) => ({ column: snapshot.levelConfigs?.[index]?.column || "" })),
            rangeFilters: snapshot.rangeFilters && typeof snapshot.rangeFilters === "object" ? { ...snapshot.rangeFilters } : {},
            frozenSelections: snapshot.frozenSelections && typeof snapshot.frozenSelections === "object" ? { ...snapshot.frozenSelections } : {},
            groups,
        };
    }

    return {
        ...normalizeLegacySnapshot(snapshot, options),
        rangeFilters: {},
        frozenSelections: {},
    };
}

export async function createSplitMetaEngine(options = {}) {
    const configHost = options.configHost;
    const workspaceHost = options.workspaceHost;
    if (!configHost || !workspaceHost) throw new Error("Split meta config and workspace hosts are required.");

    const mode = options.mode || "ttest";
    const minGroups = Math.max(2, Number(options.minGroups || (mode === "anova" ? 3 : 2)));
    const maxGroups = Number.isFinite(options.maxGroups) ? Math.max(minGroups, options.maxGroups) : (mode === "ttest" ? 2 : DEFAULT_MAX_GROUPS);
    const defaultGroupNames = Array.isArray(options.defaultGroupNames) && options.defaultGroupNames.length
        ? options.defaultGroupNames
        : mode === "anova"
            ? ["group1", "group2", "group3"]
            : ["group1", "group2"];
    const comparisonSeparator = options.comparisonSeparator || (mode === "ttest" ? " vs " : " | ");

    const templates = await loadSplitTemplate();
    configHost.innerHTML = "";
    workspaceHost.innerHTML = "";
    configHost.appendChild(cloneTemplate(templates.configTemplate));
    workspaceHost.appendChild(cloneTemplate(templates.workspaceTemplate));

    const refs = {
        groupHint: configHost.querySelector("[data-role='group-hint']"),
        groupEditorList: configHost.querySelector("[data-role='group-editor-list']"),
        summary: configHost.querySelector("[data-role='summary']"),
        addGroupBtn: configHost.querySelector("[data-action='add-group']"),
        resetBtn: configHost.querySelector("[data-action='reset']"),
        status: workspaceHost.querySelector("[data-role='status']"),
        subtitle: workspaceHost.querySelector("[data-role='workspace-subtitle']"),
        levelSelects: Array.from(workspaceHost.querySelectorAll("[data-role='level-select']")),
        swapButtons: Array.from(workspaceHost.querySelectorAll("[data-action='swap-levels']")),
        columnHosts: Array.from(workspaceHost.querySelectorAll("[data-role='column']")),
        columnSubtitles: Array.from(workspaceHost.querySelectorAll("[data-role='column-subtitle']")),
        treeScroll: workspaceHost.querySelector("[data-role='tree-scroll']"),
        treeSvg: workspaceHost.querySelector("[data-role='tree-svg']"),
        treeGrid: workspaceHost.querySelector(".splitmeta-tree-grid"),
    };

    const palette = [
        { badge: "#fef3c7", text: "#8a5b00", border: "#facc15", background: "rgba(254, 249, 195, 0.72)" },
        { badge: "#d1fae5", text: "#065f46", border: "#34d399", background: "rgba(209, 250, 229, 0.78)" },
        { badge: "#dbeafe", text: "#1d4ed8", border: "#60a5fa", background: "rgba(219, 234, 254, 0.85)" },
        { badge: "#fde68a", text: "#92400e", border: "#f59e0b", background: "rgba(254, 243, 199, 0.85)" },
        { badge: "#ede9fe", text: "#5b21b6", border: "#8b5cf6", background: "rgba(237, 233, 254, 0.9)" },
        { badge: "#fecdd3", text: "#be123c", border: "#fb7185", background: "rgba(254, 205, 211, 0.88)" },
    ];

    const state = {
        visible: false,
        metadata: { metaHeader: [], sampleToMeta: new Map() },
        levels: createDefaultLevels(),
        groups: createDefaultGroups(defaultGroupNames, minGroups),
        activeGroupId: createGroupId(0),
        rangeFilters: {},
        frozenSelections: {},
        nodeRegistry: new Map(),
        currentLayout: null,
        onChange: typeof options.onChange === "function" ? options.onChange : null,
    };

    function notifyChange() {
        if (state.onChange) {
            state.onChange(getSummary(), getSnapshot());
        }
    }

    function getEligibleColumns() {
        const raw = (options.getEligibleColumns ? options.getEligibleColumns() : [])
            .filter((item) => item && item.name)
            .map((item) => ({ ...item }));
        const orderedNames = sortMetadataLabels(raw.map((item) => item.name));
        const orderMap = new Map(orderedNames.map((name, idx) => [name, idx]));
        return raw.sort((left, right) => (orderMap.get(left.name) ?? 0) - (orderMap.get(right.name) ?? 0));
    }

    function getGroupById(groupId) {
        return state.groups.find((group) => group.id === groupId) || null;
    }

    function getColumnMetaByName(columnName) {
        return getEligibleColumns().find((item) => item?.name === columnName) || null;
    }

    function isContinuousColumn(columnName, columnMeta = null) {
        if (!columnName) return false;
        if (isContinuousMeta(columnMeta || getColumnMetaByName(columnName))) return true;
        const values = [];
        state.metadata.sampleToMeta.forEach((meta) => {
            values.push(meta?.[columnName]);
        });
        return inferContinuousFromValues(values);
    }

    function getRangeFilter(parentKey, levelIndex) {
        return state.rangeFilters[createRangeFilterKey(parentKey, levelIndex)] || { min: null, max: null };
    }

    function setRangeFilter(parentKey, levelIndex, min, max) {
        if (!parentKey || parentKey === "root") return;
        const filterKey = createRangeFilterKey(parentKey, levelIndex);
        const parsedMin = parseFilterNumber(min);
        const parsedMax = parseFilterNumber(max);
        if (parsedMin === null && parsedMax === null) {
            delete state.rangeFilters[filterKey];
            return;
        }
        let normalizedMin = parsedMin;
        let normalizedMax = parsedMax;
        if (normalizedMin !== null && normalizedMax !== null && normalizedMin > normalizedMax) {
            const temp = normalizedMin;
            normalizedMin = normalizedMax;
            normalizedMax = temp;
        }
        state.rangeFilters[filterKey] = { min: normalizedMin, max: normalizedMax };
    }

    function clearRangeFiltersForLevel(levelIndex) {
        const suffix = `__L${Number(levelIndex) + 1}`;
        Object.keys(state.rangeFilters).forEach((key) => {
            if (key.endsWith(suffix)) delete state.rangeFilters[key];
        });
    }

    function getGroupPalette(index) {
        return palette[index % palette.length];
    }

    function normalizeGroupSelections() {
        if (!state.nodeRegistry.size) return;
        state.groups.forEach((group) => {
            group.nodeKeys = [...new Set((group.nodeKeys || []).filter((nodeKey) => state.nodeRegistry.has(nodeKey)))];
            group.nodeKeys = group.nodeKeys.filter((nodeKey) => !getAncestorKeys(nodeKey).some((ancestorKey) => group.nodeKeys.includes(ancestorKey)));
        });
    }

    function getAncestorKeys(nodeKey) {
        const keys = [];
        let cursor = state.nodeRegistry.get(nodeKey)?.parentKey;
        while (cursor && cursor !== "root") {
            keys.push(cursor);
            cursor = state.nodeRegistry.get(cursor)?.parentKey;
        }
        return keys;
    }

    function isAncestorOf(maybeAncestor, nodeKey) {
        return getAncestorKeys(nodeKey).includes(maybeAncestor);
    }

    function selectionConflicts(existingKey, nextKey) {
        return existingKey === nextKey || isAncestorOf(existingKey, nextKey) || isAncestorOf(nextKey, existingKey);
    }

    function nodeHasContinuousChild(node) {
        if (!node || node.levelIndex >= MAX_LEVELS - 1) return false;
        const nextColumn = state.levels[node.levelIndex + 1]?.column || "";
        if (!nextColumn) return false;
        return isContinuousColumn(nextColumn, getColumnMetaByName(nextColumn));
    }

    function resolveSelectionKey(nodeKey) {
        const node = state.nodeRegistry.get(nodeKey);
        if (!node || !nodeHasContinuousChild(node)) return nodeKey;
        const rangeFilter = getRangeFilter(node.key, node.levelIndex + 1);
        const hasRangeFilter = rangeFilter.min !== null || rangeFilter.max !== null;
        if (!hasRangeFilter) return nodeKey;

        const selectionKey = buildRangeSelectionKey(node.key, rangeFilter.min, rangeFilter.max);
        state.frozenSelections[selectionKey] = {
            baseNodeKey: node.key,
            label: node.label,
            parentKey: node.parentKey,
            parentLabel: node.parentLabel,
            levelIndex: node.levelIndex,
            column: node.column,
            isContinuous: node.isContinuous,
            sampleIds: [...(node.effectiveSampleIds || node.sampleIds || [])],
            rangeFilter: { min: rangeFilter.min, max: rangeFilter.max },
        };
        state.nodeRegistry.set(selectionKey, {
            ...node,
            key: selectionKey,
            childKeys: [],
            sampleIds: [...(node.effectiveSampleIds || node.sampleIds || [])],
            effectiveSampleIds: [...(node.effectiveSampleIds || node.sampleIds || [])],
            count: (node.effectiveSampleIds || node.sampleIds || []).length,
            effectiveCount: (node.effectiveSampleIds || node.sampleIds || []).length,
            displaySampleText: `${(node.effectiveSampleIds || node.sampleIds || []).length} samples`,
            isFrozenRangeSelection: true,
            baseNodeKey: node.key,
            frozenRangeFilter: { min: rangeFilter.min, max: rangeFilter.max },
        });
        return selectionKey;
    }

    function syncFrozenSelections() {
        Object.entries(state.frozenSelections || {}).forEach(([selectionKey, frozen]) => {
            if (!frozen?.baseNodeKey) return;
            const baseNode = state.nodeRegistry.get(frozen.baseNodeKey);
            if (!baseNode) return;
            state.nodeRegistry.set(selectionKey, {
                ...baseNode,
                key: selectionKey,
                childKeys: [],
                sampleIds: [...(frozen.sampleIds || [])],
                effectiveSampleIds: [...(frozen.sampleIds || [])],
                count: Array.isArray(frozen.sampleIds) ? frozen.sampleIds.length : 0,
                effectiveCount: Array.isArray(frozen.sampleIds) ? frozen.sampleIds.length : 0,
                displaySampleText: `${Array.isArray(frozen.sampleIds) ? frozen.sampleIds.length : 0} samples`,
                isFrozenRangeSelection: true,
                baseNodeKey: frozen.baseNodeKey,
                frozenRangeFilter: frozen.rangeFilter || { min: null, max: null },
            });
        });
    }

    function buildHierarchy() {
        state.nodeRegistry = new Map();
        const rows = [...state.metadata.sampleToMeta.entries()].map(([sampleId, meta]) => ({ sampleId, meta }));
        const totalSamples = rows.length;
        const columns = [];
        let parentNodes = [{ key: "root", label: "All", sampleIds: rows.map((row) => row.sampleId), count: totalSamples }];
        const eligibleColumns = getEligibleColumns();
        const columnMetaMap = new Map(eligibleColumns.map((item) => [item.name, item]));

        for (let levelIndex = 0; levelIndex < MAX_LEVELS; levelIndex += 1) {
            const column = state.levels[levelIndex]?.column || "";
            const columnMeta = columnMetaMap.get(column) || null;
            const continuousColumn = isContinuousColumn(column, columnMeta);
            if (!column) {
                columns.push({ levelIndex, column: "", nodes: [], stageHeight: 260 });
                parentNodes = [];
                continue;
            }
            const levelNodes = [];
            const nextParents = [];
            parentNodes.forEach((parentNode) => {
                const counts = new Map();
                const rangeFilter = continuousColumn ? getRangeFilter(parentNode.key, levelIndex) : { min: null, max: null };
                parentNode.sampleIds.forEach((sampleId) => {
                    const meta = state.metadata.sampleToMeta.get(sampleId) || {};
                    const rawValue = String(meta[column] ?? "").trim();
                    const isMissing = !rawValue || rawValue.toLowerCase() === "nan";
                    let value = rawValue;

                    if (continuousColumn) {
                        if (isMissing) {
                            value = "NaN";
                        } else {
                            const numeric = Number(rawValue);
                            if (Number.isFinite(numeric)) {
                                if (rangeFilter.min !== null && numeric < rangeFilter.min) return;
                                if (rangeFilter.max !== null && numeric > rangeFilter.max) return;
                                value = String(numeric);
                            }
                        }
                    } else if (isMissing) {
                        value = "NaN";
                    }

                    if (!counts.has(value)) counts.set(value, []);
                    counts.get(value).push(sampleId);
                });
                const sortedEntries = [...counts.entries()].sort((left, right) => {
                    if (!continuousColumn) {
                        // A-Z letters first, then numbers, NaN always last
                        const la = String(left[0] || ""), ra = String(right[0] || "");
                        const lNan = la.toLowerCase() === "nan", rNan = ra.toLowerCase() === "nan";
                        if (lNan !== rNan) return lNan ? 1 : -1;
                        const lNum = Number.isFinite(Number(la)), rNum = Number.isFinite(Number(ra));
                        if (lNum !== rNum) return lNum ? 1 : -1; // letters before numbers
                        return la.localeCompare(ra, undefined, { numeric: true, sensitivity: "base" });
                    }
                    const leftLabel = String(left[0] || "").trim();
                    const rightLabel = String(right[0] || "").trim();
                    const leftNan = leftLabel.toLowerCase() === "nan";
                    const rightNan = rightLabel.toLowerCase() === "nan";
                    if (leftNan !== rightNan) return leftNan ? 1 : -1;
                    const leftNum = Number(leftLabel);
                    const rightNum = Number(rightLabel);
                    const leftIsNum = Number.isFinite(leftNum);
                    const rightIsNum = Number.isFinite(rightNum);
                    if (leftIsNum && rightIsNum) return leftNum - rightNum;
                    if (leftIsNum !== rightIsNum) return leftIsNum ? -1 : 1;
                    return leftLabel.localeCompare(rightLabel, undefined, { numeric: true, sensitivity: "base" });
                });
                const visibleNodes = sortedEntries
                    .map(([value, sampleIds]) => {
                        const key = buildNodeKey(parentNode.key, levelIndex, value);
                        const node = {
                            key,
                            label: value,
                            sampleIds,
                            count: sampleIds.length,
                            percentBase: levelIndex === 0 ? totalSamples : parentNode.count,
                            parentLabel: parentNode.label,
                            parentKey: parentNode.key,
                            levelIndex,
                            column,
                            isContinuous: continuousColumn,
                            childKeys: [],
                        };
                        state.nodeRegistry.set(key, node);
                        return node;
                    });
                visibleNodes.forEach((node) => {
                    const parentRegistryNode = state.nodeRegistry.get(parentNode.key);
                    if (parentRegistryNode) parentRegistryNode.childKeys.push(node.key);
                    levelNodes.push(node);
                    nextParents.push(node);
                });
            });
            columns.push({ levelIndex, column, nodes: levelNodes, stageHeight: 260 });
            parentNodes = nextParents;
        }
        hydrateEffectiveSamples(columns);
        syncFrozenSelections();
        normalizeGroupSelections();
        return columns;
    }

    function buildVisualLayout(columns) {
        const configured = columns.filter((column) => column.column && column.nodes.length);
        const nodeHeight = 74;
        const rowGap = 12;
        const stagePadding = 12;
        const stageBottomPadding = 28;
        const centerStep = nodeHeight + rowGap;
        const deepestColumn = configured.at(-1) || null;
        if (deepestColumn) {
            deepestColumn.nodes.forEach((node, index) => {
                node.centerY = stagePadding + (index * centerStep) + (nodeHeight / 2);
            });
        }
        for (let index = configured.length - 2; index >= 0; index -= 1) {
            const column = configured[index];
            let fallbackCursor = stagePadding + (nodeHeight / 2);
            column.nodes.forEach((node) => {
                const childCenters = (node.childKeys || [])
                    .map((childKey) => state.nodeRegistry.get(childKey)?.centerY)
                    .filter((value) => Number.isFinite(value));
                if (childCenters.length) {
                    node.centerY = (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
                } else {
                    node.centerY = fallbackCursor;
                    fallbackCursor += centerStep;
                }
            });
        }
        const allNodes = columns.flatMap((column) => column.nodes || []);
        const maxCenter = allNodes.length ? Math.max(...allNodes.map((node) => node.centerY || (stagePadding + (nodeHeight / 2)))) : (stagePadding + (nodeHeight / 2));
        const stageHeight = Math.max(300, maxCenter + (nodeHeight / 2) + stagePadding + stageBottomPadding);
        columns.forEach((column) => {
            (column.nodes || []).forEach((node, index) => {
                if (!Number.isFinite(node.centerY)) {
                    node.centerY = stagePadding + (index * centerStep) + (nodeHeight / 2);
                }
                node.top = Math.max(0, node.centerY - (nodeHeight / 2));
                node.height = nodeHeight;
            });
            column.stageHeight = stageHeight;
        });
        return { columns, stageHeight };
    }

    function hydrateEffectiveSamples(columns) {
        for (let levelIndex = MAX_LEVELS - 1; levelIndex >= 0; levelIndex -= 1) {
            const columnData = columns[levelIndex] || { nodes: [] };
            const nextColumnData = columns[levelIndex + 1] || null;
            const hasNextColumn = Boolean(nextColumnData?.column);
            const nextMeta = hasNextColumn ? getColumnMetaByName(nextColumnData.column) : null;
            const nextIsContinuous = hasNextColumn && isContinuousColumn(nextColumnData.column, nextMeta);

            (columnData.nodes || []).forEach((node) => {
                const rangeFilter = getRangeFilter(node.key, levelIndex + 1);
                const hasRangeFilter = nextIsContinuous && (rangeFilter.min !== null || rangeFilter.max !== null);

                if (hasRangeFilter) {
                    const effectiveSet = new Set();
                    (node.childKeys || []).forEach((childKey) => {
                        const childNode = state.nodeRegistry.get(childKey);
                        const childSamples = childNode?.effectiveSampleIds || childNode?.sampleIds || [];
                        childSamples.forEach((sampleId) => effectiveSet.add(sampleId));
                    });
                    node.effectiveSampleIds = [...effectiveSet];
                } else {
                    node.effectiveSampleIds = [...(node.sampleIds || [])];
                }

                node.effectiveCount = node.effectiveSampleIds.length;
                node.displaySampleText = (!node.isContinuous && nextIsContinuous)
                    ? `${node.effectiveCount}/${node.count} samples`
                    : `${node.effectiveCount} samples`;
            });
        }
    }

    function getGroupSampleIds(group) {
        const sampleIds = new Set();
        (group?.nodeKeys || []).forEach((nodeKey) => {
            const node = state.nodeRegistry.get(nodeKey);
            const sourceSampleIds = node?.effectiveSampleIds || node?.sampleIds || [];
            sourceSampleIds.forEach((sampleId) => sampleIds.add(sampleId));
        });
        return [...sampleIds];
    }

    function getOverlapMap(groupEntries) {
        const sampleToGroups = new Map();
        groupEntries.forEach((entry) => {
            entry.sampleIds.forEach((sampleId) => {
                if (!sampleToGroups.has(sampleId)) sampleToGroups.set(sampleId, []);
                sampleToGroups.get(sampleId).push(entry.id);
            });
        });
        const overlap = new Map();
        sampleToGroups.forEach((groupIds, sampleId) => {
            if (groupIds.length < 2) return;
            groupIds.forEach((groupId) => {
                if (!overlap.has(groupId)) overlap.set(groupId, []);
                overlap.get(groupId).push(sampleId);
            });
        });
        return overlap;
    }

    function getSummary() {
        const configuredColumns = state.levels.map((level) => level.column).filter(Boolean);
        const displayTarget = configuredColumns.length ? `Split: ${configuredColumns.join(" > ")}` : "Split";
        const groupEntries = state.groups.map((group) => ({
            id: group.id,
            name: sanitizeGroupName(group.name, group.id),
            nodeKeys: [...group.nodeKeys],
            sampleIds: getGroupSampleIds(group),
        }));
        const overlapMap = getOverlapMap(groupEntries);
        const totalAssigned = new Set(groupEntries.flatMap((entry) => entry.sampleIds));
        const filledGroups = groupEntries.filter((entry) => entry.sampleIds.length);
        const duplicateNames = new Set();
        const seenNames = new Set();
        groupEntries.forEach((entry) => {
            const key = entry.name.toLowerCase();
            if (seenNames.has(key)) duplicateNames.add(entry.name);
            seenNames.add(key);
        });

        let error = "";
        if (configuredColumns.length === 0) {
            error = "Choose at least one metadata level.";
        } else if (filledGroups.length < minGroups) {
            error = `At least ${minGroups} groups must contain selected samples.`;
        } else if (overlapMap.size) {
            const conflictCount = new Set([...overlapMap.values()].flat()).size;
            error = `Groups overlap on ${conflictCount} sample(s). Remove the conflicting branch assignment.`;
        } else if (duplicateNames.size) {
            error = "Group names must be unique.";
        }

        return {
            displayTarget,
            configuredColumns,
            groupEntries,
            overlapMap,
            filledGroups,
            isValid: !error,
            error,
            unassignedCount: Math.max(0, state.metadata.sampleToMeta.size - totalAssigned.size),
            comparison: filledGroups.map((entry) => entry.name).join(comparisonSeparator),
        };
    }

    function setStatusText(summary) {
        if (!refs.status) return;
        refs.status.textContent = summary.error
            ? summary.error
            : `Active group: ${getGroupById(state.activeGroupId)?.name || "-"}`;
    }

    function syncGroupNamePresentation(groupId) {
        const group = getGroupById(groupId);
        if (!group) return;
        const summary = getSummary();
        renderSummary(summary);
        setStatusText(summary);
        refs.treeScroll?.querySelectorAll(`.splitmeta-node-badge[data-group-id="${CSS.escape(groupId)}"]`).forEach((badge) => {
            badge.textContent = group.name;
        });
    }

    function renderGroupEditors(summary) {
        if (!refs.groupEditorList) return;
        refs.groupEditorList.innerHTML = state.groups.map((group, index) => {
            const entry = summary.groupEntries.find((item) => item.id === group.id) || { sampleIds: [], nodeKeys: [] };
            const conflictCount = summary.overlapMap.get(group.id)?.length || 0;
            const paletteItem = getGroupPalette(index);
            return `
                <div class="splitmeta-group-editor ${state.activeGroupId === group.id ? "active" : ""}" data-group-id="${group.id}">
                    <div class="splitmeta-group-head">
                        <div>
                            <span class="splitmeta-group-pill" style="background:${paletteItem.badge}; color:${paletteItem.text};">Group ${index + 1}</span>
                            <div class="small text-muted mt-2">Click this card to make it the current assignment target.</div>
                        </div>
                        <div class="d-flex align-items-center gap-2">
                            ${state.groups.length > minGroups ? `<button type="button" class="btn btn-outline-danger btn-sm py-0 px-2" data-action="remove-group" data-group-id="${group.id}"><i class="fa-solid fa-trash-can"></i></button>` : ""}
                        </div>
                    </div>
                    <input type="text" class="form-control form-control-sm" data-role="group-name" data-group-id="${escapeHtmlAttr(group.id)}" value="${escapeHtmlAttr(group.name)}" maxlength="80">
                    <div class="splitmeta-group-metrics">
                        <div class="splitmeta-metric">
                            <div class="splitmeta-metric-label">Samples</div>
                            <div class="splitmeta-metric-value">${entry.sampleIds.length}</div>
                        </div>
                        <div class="splitmeta-metric">
                            <div class="splitmeta-metric-label">Branches</div>
                            <div class="splitmeta-metric-value">${entry.nodeKeys.length}</div>
                        </div>
                    </div>
                    <div class="small text-muted mt-2">${conflictCount ? `${conflictCount} conflicting sample(s)` : "No overlap"}</div>
                </div>
            `;
        }).join("");

        refs.groupEditorList.querySelectorAll(".splitmeta-group-editor").forEach((card) => {
            card.addEventListener("click", (event) => {
                if (event.target.closest("[data-action='remove-group']") || event.target.closest("[data-role='group-name']")) return;
                state.activeGroupId = card.dataset.groupId;
                render();
            });
        });
        refs.groupEditorList.querySelectorAll("[data-role='group-name']").forEach((input) => {
            input.addEventListener("input", () => {
                const group = getGroupById(input.dataset.groupId);
                if (!group) return;
                const groupIndex = Math.max(0, groupIndexById(group.id));
                const fallbackName = defaultGroupNames[groupIndex] || `group${groupIndex + 1}`;
                group.name = sanitizeGroupName(input.value, fallbackName);
                syncGroupNamePresentation(group.id);
                notifyChange();
            });
            input.addEventListener("blur", () => {
                const group = getGroupById(input.dataset.groupId);
                if (!group) return;
                const groupIndex = Math.max(0, groupIndexById(group.id));
                const fallbackName = defaultGroupNames[groupIndex] || `group${groupIndex + 1}`;
                group.name = sanitizeGroupName(input.value, fallbackName);
                input.value = group.name;
                notifyAndRender();
            });
        });
        refs.groupEditorList.querySelectorAll("[data-action='remove-group']").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                removeGroup(button.dataset.groupId);
            });
        });
    }

    function renderSummary(summary) {
        if (!refs.summary) return;
        refs.summary.innerHTML = [
            ...summary.groupEntries.map((entry) => `<div class="splitmeta-summary-line"><strong>${escapeHtml(entry.name)}:</strong> ${entry.sampleIds.length} samples</div>`),
            `<div class="splitmeta-summary-line"><strong>Unassigned:</strong> ${summary.unassignedCount} samples</div>`,
            `<div class="splitmeta-summary-line"><strong>Derived target:</strong> ${escapeHtml(summary.displayTarget)}</div>`,
            summary.error
                ? `<div class="splitmeta-summary-line error">${escapeHtml(summary.error)}</div>`
                : `<div class="splitmeta-summary-line"><strong>Status:</strong> Ready to run with ${summary.filledGroups.length} group(s).</div>`,
        ].join("");
    }

    function isNodeSelectedByGroup(group, nodeKey) {
        const nodeKeys = group?.nodeKeys || [];
        if (nodeKeys.includes(nodeKey)) return true;
        return nodeKeys.some((key) => state.frozenSelections?.[key]?.baseNodeKey === nodeKey);
    }

    function getBadgesForNode(nodeKey) {
        return state.groups.map((group, index) => {
            const exactKey = (group.nodeKeys || []).find((key) => key === nodeKey);
            const frozenKey = (group.nodeKeys || []).find((key) => state.frozenSelections?.[key]?.baseNodeKey === nodeKey);
            const matchedKey = exactKey || frozenKey;
            if (!matchedKey) return null;
            const paletteItem = getGroupPalette(index);
            const frozen = state.frozenSelections?.[matchedKey];
            const rangeText = frozen?.rangeFilter && (frozen.rangeFilter.min !== null || frozen.rangeFilter.max !== null)
                ? ` (${frozen.rangeFilter.min ?? "-"} to ${frozen.rangeFilter.max ?? "-"})`
                : "";
            return {
                groupId: group.id,
                name: `${group.name}${rangeText}`,
                paletteItem,
            };
        }).filter(Boolean);
    }

    function groupIndexById(groupId) {
        return state.groups.findIndex((group) => group.id === groupId);
    }

    function renderColumn(columnHost, subtitleEl, columnData) {
        if (!columnHost || !subtitleEl) return;
        subtitleEl.textContent = columnData.column || "No column";
        if (!columnData.column) {
            columnHost.innerHTML = '<div class="splitmeta-empty">Select a metadata column in this level to preview the branch hierarchy.</div>';
            return;
        }
        if (!columnData.nodes.length) {
            columnHost.innerHTML = '<div class="splitmeta-empty">No matching branch is available for this level yet.</div>';
            return;
        }
        const summary = getSummary();
        const childLevelIndex = columnData.levelIndex + 1;
        const childColumn = state.levels[childLevelIndex]?.column || "";
        const childMeta = childColumn ? getColumnMetaByName(childColumn) : null;
        const childIsContinuous = Boolean(childColumn && isContinuousColumn(childColumn, childMeta));
        columnHost.innerHTML = `<div class="splitmeta-level-stage" style="height:${columnData.stageHeight || 260}px;">${columnData.nodes.map((node) => {
            const selectedBadges = getBadgesForNode(node.key)
                .map((badge) => `<span class="splitmeta-node-badge" data-group-id="${escapeHtmlAttr(badge.groupId)}" style="background:${badge.paletteItem.badge}; color:${badge.paletteItem.text};">${escapeHtml(badge.name)}</span>`)
                .join("");
            const rangeFilter = childIsContinuous ? getRangeFilter(node.key, childLevelIndex) : { min: null, max: null };
            const showRangeControl = childIsContinuous && node.levelIndex < MAX_LEVELS - 1;
            const hasConflict = summary.overlapMap.size && state.groups.some((group) => {
                const conflicts = new Set(summary.overlapMap.get(group.id) || []);
                const visibleSamples = node.effectiveSampleIds || node.sampleIds || [];
                return (group.nodeKeys || []).includes(node.key) && visibleSamples.some((sampleId) => conflicts.has(sampleId));
            });
            const selectedByAny = state.groups.some((group) => isNodeSelectedByGroup(group, node.key));
            return `
                <div class="splitmeta-node-card positioned clickable ${selectedByAny ? "selected" : ""} ${hasConflict ? "has-conflict" : ""}" style="top:${node.top || 0}px; min-height:${node.height || 56}px;" data-node-key="${escapeHtmlAttr(node.key)}" data-parent-key="${escapeHtmlAttr(node.parentKey || "")}">
                    <div class="splitmeta-node-header">
                        <div>
                            <div class="splitmeta-node-name">${escapeHtml(node.label)}</div>
                            <div class="splitmeta-node-parent">${escapeHtml(node.parentKey === "root" ? "All samples" : (node.parentLabel || "Inherited branch"))}</div>
                        </div>
                        <div class="splitmeta-node-meta">${node.effectiveCount ?? node.count}</div>
                    </div>
                    <div class="splitmeta-node-bar"><span style="width:${node.percentBase > 0 ? Math.max(2, (node.count / node.percentBase) * 100) : 0}%"></span></div>
                    <div class="splitmeta-node-meta">${node.displaySampleText || `${node.count} samples`}</div>
                    ${showRangeControl ? `
                        <div class="splitmeta-node-range" data-range-node-key="${escapeHtmlAttr(node.key)}" data-range-level-index="${childLevelIndex}">
                            <span class="splitmeta-node-range-label">Range</span>
                            <input type="number" step="any" class="form-control form-control-sm splitmeta-node-range-input" data-range-bound="min" value="${rangeFilter.min ?? ""}" placeholder="min" />
                            <span class="splitmeta-node-range-sep">-</span>
                            <input type="number" step="any" class="form-control form-control-sm splitmeta-node-range-input" data-range-bound="max" value="${rangeFilter.max ?? ""}" placeholder="max" />
                        </div>
                    ` : ""}
                    <div class="splitmeta-node-badge-row">${selectedBadges}${hasConflict ? '<span class="splitmeta-node-badge conflict">Overlap</span>' : ''}</div>
                </div>
            `;
        }).join("")}</div>`;

        columnHost.querySelectorAll(".splitmeta-node-range").forEach((rangeRow) => {
            rangeRow.addEventListener("click", (event) => event.stopPropagation());
            const nodeKey = rangeRow.dataset.rangeNodeKey;
            const levelIndex = Number(rangeRow.dataset.rangeLevelIndex);
            const minInput = rangeRow.querySelector("[data-range-bound='min']");
            const maxInput = rangeRow.querySelector("[data-range-bound='max']");
            const applyRange = () => {
                setRangeFilter(nodeKey, levelIndex, minInput?.value, maxInput?.value);
                notifyAndRender();
            };
            minInput?.addEventListener("click", (event) => event.stopPropagation());
            maxInput?.addEventListener("click", (event) => event.stopPropagation());
            minInput?.addEventListener("change", applyRange);
            maxInput?.addEventListener("change", applyRange);
            minInput?.addEventListener("blur", applyRange);
            maxInput?.addEventListener("blur", applyRange);
        });

        columnHost.querySelectorAll(".splitmeta-node-card").forEach((card) => {
            card.addEventListener("click", () => assignNodeToActiveGroup(card.dataset.nodeKey));
        });
    }

    function drawConnectors() {
        if (!state.visible || !refs.treeSvg || !refs.treeScroll) return;
        const svgRect = refs.treeSvg.getBoundingClientRect();
        refs.treeSvg.setAttribute("viewBox", `0 0 ${Math.max(1, svgRect.width)} ${Math.max(1, svgRect.height)}`);
        const connectors = [];
        refs.columnHosts.slice(1).forEach((columnHost) => {
            columnHost?.querySelectorAll(".splitmeta-node-card[data-parent-key]").forEach((childNode) => {
                const parentKey = childNode.dataset.parentKey;
                if (!parentKey || parentKey === "root") return;
                const parentNode = refs.treeScroll.querySelector(`.splitmeta-node-card[data-node-key="${CSS.escape(parentKey)}"]`);
                if (!parentNode) return;
                const parentRect = parentNode.getBoundingClientRect();
                const childRect = childNode.getBoundingClientRect();
                const startX = parentRect.right - svgRect.left;
                const startY = parentRect.top + parentRect.height / 2 - svgRect.top;
                const endX = childRect.left - svgRect.left;
                const endY = childRect.top + childRect.height / 2 - svgRect.top;
                const deltaX = Math.max(28, (endX - startX) * 0.45);
                connectors.push(`<path class="splitmeta-connector-path" d="M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}" />`);
            });
        });
        refs.treeSvg.innerHTML = connectors.join("");
    }

    function ensureStageFitsRenderedNodes() {
        if (!state.visible || !refs.columnHosts.length) return;

        const extraBottomPadding = 20;
        let requiredHeight = state.currentLayout?.stageHeight || 260;

        refs.columnHosts.forEach((columnHost) => {
            const stage = columnHost.querySelector(".splitmeta-level-stage");
            if (!stage) return;

            const stageRect = stage.getBoundingClientRect();
            let columnBottom = 0;
            stage.querySelectorAll(".splitmeta-node-card").forEach((card) => {
                const cardRect = card.getBoundingClientRect();
                columnBottom = Math.max(columnBottom, (cardRect.bottom - stageRect.top) + extraBottomPadding);
            });

            requiredHeight = Math.max(requiredHeight, Math.ceil(columnBottom));
        });

        if (!Number.isFinite(requiredHeight) || requiredHeight <= 0) return;
        if (requiredHeight === (state.currentLayout?.stageHeight || 0)) return;

        state.currentLayout = {
            ...(state.currentLayout || {}),
            stageHeight: requiredHeight,
        };

        refs.columnHosts.forEach((columnHost) => {
            const stage = columnHost.querySelector(".splitmeta-level-stage");
            if (stage) {
                stage.style.height = `${requiredHeight}px`;
            }
        });

        if (refs.treeSvg) {
            refs.treeSvg.style.height = `${requiredHeight}px`;
        }
        if (refs.treeGrid) {
            refs.treeGrid.style.minHeight = `${requiredHeight}px`;
        }
    }

    function renderLevelSelectors() {
        const eligible = getEligibleColumns();
        refs.levelSelects.forEach((select, index) => {
            const current = state.levels[index]?.column || "";
            select.innerHTML = '<option value="">-- Select metadata --</option>' + eligible.map((item) => `<option value="${escapeHtmlAttr(item.name)}" ${item.name === current ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
        });
    }

    function render() {
        const layout = buildVisualLayout(buildHierarchy());
        state.currentLayout = layout;
        const summary = getSummary();
        renderLevelSelectors();
        renderGroupEditors(summary);
        renderSummary(summary);
        setStatusText(summary);
        refs.groupHint.textContent = maxGroups === minGroups
            ? `Exactly ${minGroups} reusable groups are available for this analysis.`
            : `Create between ${minGroups} and ${maxGroups} groups, then assign branches to each group.`;
        refs.addGroupBtn.style.display = state.groups.length >= maxGroups ? "none" : "inline-flex";
        refs.subtitle.textContent = mode === "ttest"
            ? "Assign whole branches into the two DEA groups. Child nodes inherit the selected group."
            : "Assign whole branches into multiple ANOVA groups. Each branch is exclusive across groups.";
        refs.columnHosts.forEach((host, index) => renderColumn(host, refs.columnSubtitles[index], layout.columns[index] || { column: "", nodes: [], stageHeight: 260 }));
        refs.treeSvg.style.height = `${layout.stageHeight || 260}px`;
        if (refs.treeGrid) {
            refs.treeGrid.style.minHeight = `${layout.stageHeight || 260}px`;
        }
        requestAnimationFrame(() => {
            ensureStageFitsRenderedNodes();
            drawConnectors();
        });
    }

    function notifyAndRender() {
        render();
        notifyChange();
    }

    function reset() {
        state.groups = createDefaultGroups(defaultGroupNames, minGroups);
        state.activeGroupId = state.groups[0]?.id || null;
        state.levels = createDefaultLevels();
        state.rangeFilters = {};
        state.frozenSelections = {};
        notifyAndRender();
    }

    function addGroup() {
        if (state.groups.length >= maxGroups) return;
        state.groups.push({
            id: createGroupId(state.groups.length),
            name: sanitizeGroupName(defaultGroupNames[state.groups.length], `group${state.groups.length + 1}`),
            nodeKeys: [],
        });
        if (!state.activeGroupId) state.activeGroupId = state.groups.at(-1)?.id || null;
        notifyAndRender();
    }

    function removeGroup(groupId) {
        if (state.groups.length <= minGroups) return;
        state.groups = state.groups.filter((group) => group.id !== groupId);
        if (!state.groups.find((group) => group.id === state.activeGroupId)) {
            state.activeGroupId = state.groups[0]?.id || null;
        }
        notifyAndRender();
    }

    function assignNodeToActiveGroup(nodeKey) {
        const group = getGroupById(state.activeGroupId);
        if (!group || !nodeKey) return;
        const resolvedNodeKey = resolveSelectionKey(nodeKey);
        const isSelected = group.nodeKeys.includes(resolvedNodeKey);
        if (isSelected) {
            group.nodeKeys = group.nodeKeys.filter((key) => key !== resolvedNodeKey);
            notifyAndRender();
            return;
        }
        state.groups.forEach((candidate) => {
            candidate.nodeKeys = candidate.nodeKeys.filter((existingKey) => !selectionConflicts(existingKey, resolvedNodeKey));
        });
        group.nodeKeys = [...group.nodeKeys, resolvedNodeKey];
        normalizeGroupSelections();
        notifyAndRender();
    }

    function setMetadata({ metaHeader = [], sampleToMeta = new Map() } = {}) {
        state.metadata = {
            metaHeader: Array.isArray(metaHeader) ? [...metaHeader] : [],
            sampleToMeta: sampleToMeta instanceof Map ? new Map(sampleToMeta) : new Map(),
        };
        notifyAndRender();
    }

    function setVisible(visible) {
        state.visible = Boolean(visible);
        workspaceHost.classList.toggle("d-none", !state.visible);
        if (state.visible) requestAnimationFrame(() => drawConnectors());
    }

    function getSnapshot() {
        return {
            version: 4,
            mode: "split",
            activeGroupId: state.activeGroupId,
            levelConfigs: state.levels.map((level) => ({ column: level.column || "" })),
            rangeFilters: { ...state.rangeFilters },
            frozenSelections: { ...state.frozenSelections },
            groups: state.groups.map((group) => ({ id: group.id, name: sanitizeGroupName(group.name, group.id), nodeKeys: [...group.nodeKeys] })),
        };
    }

    function applySnapshot(snapshot) {
        const normalized = normalizeSnapshot(snapshot, { defaultGroupNames, minGroups });
        state.levels = Array.from({ length: MAX_LEVELS }, (_, index) => ({ column: normalized.levelConfigs?.[index]?.column || "" }));
        state.groups = normalized.groups.length ? normalized.groups : createDefaultGroups(defaultGroupNames, minGroups);
        while (state.groups.length < minGroups) {
            state.groups.push({ id: createGroupId(state.groups.length), name: sanitizeGroupName(defaultGroupNames[state.groups.length], `group${state.groups.length + 1}`), nodeKeys: [] });
        }
        if (state.groups.length > maxGroups) {
            state.groups = state.groups.slice(0, maxGroups);
        }
        state.activeGroupId = state.groups.find((group) => group.id === normalized.activeGroupId)?.id || state.groups[0]?.id || null;
        state.rangeFilters = normalized.rangeFilters && typeof normalized.rangeFilters === "object" ? { ...normalized.rangeFilters } : {};
        state.frozenSelections = normalized.frozenSelections && typeof normalized.frozenSelections === "object" ? { ...normalized.frozenSelections } : {};
        notifyAndRender();
    }

    function isValid() {
        return getSummary().isValid;
    }

    function buildDerivedMetaCsv({ columnPrefix = "__split_group" } = {}) {
        const summary = getSummary();
        if (!summary.isValid) throw new Error(summary.error || "Split configuration is not valid.");
        const derivedTarget = `${columnPrefix}_${Date.now()}`;
        const header = ["sample_id", ...state.metadata.metaHeader, derivedTarget];
        const sampleToLabel = new Map();
        summary.groupEntries.forEach((entry) => {
            entry.sampleIds.forEach((sampleId) => sampleToLabel.set(sampleId, entry.name));
        });
        const lines = [header.map(escapeCsvValue).join(",")];
        state.metadata.sampleToMeta.forEach((meta, sampleId) => {
            const row = [sampleId, ...state.metadata.metaHeader.map((column) => meta[column] ?? ""), sampleToLabel.get(sampleId) || ""];
            lines.push(row.map(escapeCsvValue).join(","));
        });
        return {
            csvText: lines.join("\n"),
            targetColumn: derivedTarget,
            displayTarget: summary.displayTarget,
            comparison: summary.comparison,
            splitConfig: getSnapshot(),
            groups: summary.groupEntries,
        };
    }

    refs.levelSelects.forEach((select) => {
        select.addEventListener("change", () => {
            const index = Number(select.dataset.levelIndex);
            if (!Number.isFinite(index)) return;
            state.levels[index].column = select.value;
            clearRangeFiltersForLevel(index);
            clearRangeFiltersForLevel(index + 1);
            state.groups.forEach((group) => { group.nodeKeys = []; });
            notifyAndRender();
        });
    });
    refs.swapButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const from = Number(button.dataset.from);
            const to = Number(button.dataset.to);
            if (!Number.isFinite(from) || !Number.isFinite(to)) return;
            [state.levels[from], state.levels[to]] = [state.levels[to], state.levels[from]];
            clearRangeFiltersForLevel(Math.min(from, to));
            clearRangeFiltersForLevel(Math.max(from, to));
            state.groups.forEach((group) => { group.nodeKeys = []; });
            notifyAndRender();
        });
    });
    refs.treeScroll?.addEventListener("scroll", () => {
        if (state.visible) drawConnectors();
    });
    window.addEventListener("resize", () => {
        if (!state.visible) return;
        requestAnimationFrame(() => {
            ensureStageFitsRenderedNodes();
            drawConnectors();
        });
    });
    refs.addGroupBtn?.addEventListener("click", addGroup);
    refs.resetBtn?.addEventListener("click", reset);

    render();
    setVisible(Boolean(options.visible));

    return {
        mode,
        minGroups,
        maxGroups,
        setVisible,
        setMetadata,
        reset,
        applySnapshot,
        getSnapshot,
        getSummary,
        isValid,
        buildDerivedMetaCsv,
        render: notifyAndRender,
        setOnChange(callback) { state.onChange = typeof callback === "function" ? callback : null; },
    };
}
