/**
 * sidebar-normality.js
 * Defines window.renderNormSummary(cfg, normalityStat)
 * Loaded dynamically by sidebar.html so all analysis pages get it for free.
 */
window.renderNormSummary = function (cfg, normalityStat) {
    function getProjectIdFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search);
            return params.get("id") || "";
        } catch (_) {
            return "";
        }
    }

    function normalizeNormalityStat(raw) {
        if (!raw || typeof raw !== "object") return null;
        const n = Number(raw.normal_features ?? raw.normalFeatures ?? raw.count_normal ?? 0);
        const total = Number(raw.total_features ?? raw.totalFeatures ?? raw.count_total ?? 0);
        if (!Number.isFinite(total) || total <= 0) return null;
        return {
            normal_features: Number.isFinite(n) ? n : 0,
            total_features: total,
        };
    }

    function getCachedNormalityStat() {
        try {
            const pid = getProjectIdFromUrl();
            const scoped = pid ? localStorage.getItem(`normality_stat:${pid}`) : null;
            const generic = localStorage.getItem("normality_stat:last");
            return normalizeNormalityStat(JSON.parse(scoped || generic || "null"));
        } catch (_) {
            return null;
        }
    }

    function cacheNormalityStat(stat) {
        try {
            const pid = getProjectIdFromUrl();
            if (pid) localStorage.setItem(`normality_stat:${pid}`, JSON.stringify(stat));
            localStorage.setItem("normality_stat:last", JSON.stringify(stat));
        } catch (_) {
            // Ignore localStorage issues (private mode, quota, etc.)
        }
    }

    // ── Normalization settings card ──────────────────────────────────────
    const card = document.getElementById("normSummaryCard");
    const body = document.getElementById("normSummaryBody");
    if (card && body) {
        if (!cfg) {
            card.classList.remove("ready");
            card.classList.add("missing");
            body.innerHTML = "No normalization info found.";
        } else {
            function labelOrNone(v) { return (v && v !== "None") ? v : "None"; }
            const zeroVal = cfg.zero;
            const zeroLabel = zeroVal === -1 ? "None" : zeroVal === 0 ? "1/5 Minimum" : "QRILC";
            const batchLine = cfg.batch_corr === "ComBat"
                ? labelOrNone(cfg.batch_corr) + " (" + (cfg.batch_col || "no col") + ")"
                : labelOrNone(cfg.batch_corr);
            card.classList.remove("missing");
            card.classList.add("ready");
            body.innerHTML = [
                '<div class="norm-summary-line"><b>Sample Norm:</b> ' + labelOrNone(cfg.sample_norm) + '</div>',
                '<div class="norm-summary-line"><b>Zero Handling:</b> ' + zeroLabel + '</div>',
                '<div class="norm-summary-line"><b>Transform:</b> ' + labelOrNone(cfg.data_trans) + '</div>',
                '<div class="norm-summary-line"><b>Batch Corr:</b> ' + batchLine + '</div>',
                '<div class="norm-summary-line"><b>Scaling:</b> ' + labelOrNone(cfg.data_scaling) + '</div>'
            ].join("");
        }
    }

    // ── Normality stat card ──────────────────────────────────────────────
    const statCard = document.getElementById("normalityStatCard");
    const statBody = document.getElementById("normalityStatBody");
    if (!statCard || !statBody) return;

    const resolvedStat =
        normalizeNormalityStat(normalityStat) ||
        normalizeNormalityStat(cfg?.normality_stat) ||
        normalizeNormalityStat(cfg?.normalityStat) ||
        getCachedNormalityStat();

    if (!resolvedStat) {
        statCard.classList.remove("ready");
        statCard.classList.add("missing");
        statBody.innerHTML = "Run normalization to view.";
        return;
    }

    cacheNormalityStat(resolvedStat);

    const n = resolvedStat.normal_features;
    const total = resolvedStat.total_features;
    statCard.classList.remove("missing");
    statCard.classList.add("ready");
    statBody.innerHTML = `<div class="norm-summary-line"><b>${n} / ${total} features normal</b></div>`;
};
