import io
import json
import logging
import time

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests

from services.common import *

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _strip_inline_results(entry):
    if not isinstance(entry, dict):
        return entry
    return {key: value for key, value in entry.items() if key != "results"}


def _safe_shapiro_p(values):
    arr = np.asarray(values, dtype=float)
    if arr.size < 3:
        return np.nan
    if arr.size > 5000:
        rng = np.random.default_rng(42)
        arr = rng.choice(arr, size=5000, replace=False)
    try:
        return float(stats.shapiro(arr).pvalue)
    except Exception:
        return np.nan


def _cohens_d_unpaired(v1, v2):
    n1, n2 = len(v1), len(v2)
    if n1 < 2 or n2 < 2:
        return np.nan
    s1 = np.var(v1, ddof=1)
    s2 = np.var(v2, ddof=1)
    denom_df = n1 + n2 - 2
    if denom_df <= 0:
        return np.nan
    pooled_var = ((n1 - 1) * s1 + (n2 - 1) * s2) / denom_df
    if pooled_var <= 0:
        return 0.0
    return float((np.mean(v1) - np.mean(v2)) / np.sqrt(pooled_var))


def _cohens_d_paired(diff):
    if len(diff) < 2:
        return np.nan
    sd = np.std(diff, ddof=1)
    if sd == 0:
        return 0.0
    return float(np.mean(diff) / sd)


def _rank_biserial_from_u(u_stat, n1, n2):
    denom = n1 * n2
    if denom <= 0:
        return np.nan
    return float((2.0 * u_stat) / denom - 1.0)


def _rank_biserial_signed(diff):
    diff = np.asarray(diff, dtype=float)
    non_zero = diff[diff != 0]
    if non_zero.size == 0:
        return 0.0

    ranks = stats.rankdata(np.abs(non_zero), method="average")
    w_pos = ranks[non_zero > 0].sum()
    w_neg = ranks[non_zero < 0].sum()
    denom = w_pos + w_neg
    if denom == 0:
        return 0.0
    return float((w_pos - w_neg) / denom)


def _build_paired_sample_pairs(df_meta, df_columns, target_col, group_names, pair_id_col):
    if pair_id_col not in df_meta.columns:
        raise ValueError(f"pair_id_col '{pair_id_col}' not found in metadata")

    meta = df_meta.loc[df_meta.index.intersection(df_columns), [target_col, pair_id_col]].copy()
    meta[pair_id_col] = meta[pair_id_col].astype(str).str.strip()
    meta = meta[meta[pair_id_col].str.lower().ne("nan") & meta[pair_id_col].ne("")]

    g1_meta = meta[meta[target_col] == group_names[0]]
    g2_meta = meta[meta[target_col] == group_names[1]]

    g1_map = g1_meta.groupby(pair_id_col).apply(lambda x: list(x.index)).to_dict()
    g2_map = g2_meta.groupby(pair_id_col).apply(lambda x: list(x.index)).to_dict()

    common_pair_ids = sorted(set(g1_map.keys()).intersection(g2_map.keys()))

    pairs = []
    duplicate_pairs = 0
    for pair_id in common_pair_ids:
        s1_list = g1_map.get(pair_id, [])
        s2_list = g2_map.get(pair_id, [])
        if not s1_list or not s2_list:
            continue
        if len(s1_list) > 1 or len(s2_list) > 1:
            duplicate_pairs += 1
        pairs.append((s1_list[0], s2_list[0], pair_id))

    return pairs, duplicate_pairs


def run_univariate_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    task_run_id = run_id or f"ttest_{int(time.time() * 1000)}"
    analysis_name = settings.get("analysis_name") or f"Analysis {task_run_id}"
    target_col = settings.get("target_meta")
    comparison = settings.get("comparison")
    paired = bool(settings.get("paired", False))
    pair_id_col = settings.get("pair_id_col")
    test_type = str(settings.get("test_type", "auto")).strip().lower()  # "auto" | "wilcoxon" | "student" | "welch"
    if test_type not in {"auto", "wilcoxon", "student", "welch", "t-test"}:
        test_type = "auto"

    try:
        logger.info("===== START UNIVARIATE ANALYSIS =====")
        logger.info(f"Project: {project_id} | User: {uid}")

        started_at = utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "target": target_col,
            "comparison": comparison,
            "paired": paired,
            "pair_id_col": pair_id_col if paired else None,
            "started_at": started_at,
        }

        update_project(
            project_id,
            ttest_task=build_task_payload(task_base, "running", "Running t-test analysis.", started_at=started_at),
        )

        project_data = get_project_data(project_id)
        running_history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": project_data.get("ttest_task", {}).get("started_at") or started_at,
            "target": target_col,
            "comparison": comparison,
            "paired": paired,
            "pair_id_col": pair_id_col if paired else None,
            "status": "running",
            "message": "Running t-test analysis.",
        }
        update_project(
            project_id,
            ttest_history=[running_history_entry]
            + [
                _strip_inline_results(item)
                for item in (project_data.get("ttest_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )

        logger.info("Loading matrix & metadata...")
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        logger.info(f"Matrix shape: {df.shape}")
        logger.info(f"Meta shape: {df_meta.shape}")

        log_base = settings.get("log_base", 2)

        logger.info(f"Target column: {target_col}")
        logger.info(f"Comparison: {comparison}")
        logger.info(f"Paired mode: {paired}")
        if paired:
            logger.info(f"Pair ID column: {pair_id_col}")

        group_names = comparison.split(" vs ")
        if len(group_names) != 2:
            raise ValueError(f"Invalid comparison format: {comparison}")

        g1_id = df_meta[df_meta[target_col] == group_names[0]].index.intersection(df.columns)
        g2_id = df_meta[df_meta[target_col] == group_names[1]].index.intersection(df.columns)

        logger.info(f"Group1 ({group_names[0]}): {len(g1_id)} samples")
        logger.info(f"Group2 ({group_names[1]}): {len(g2_id)} samples")

        paired_sample_pairs = []
        duplicate_pairs = 0
        if paired:
            if not pair_id_col:
                raise ValueError("pair_id_col is required when paired=True")
            paired_sample_pairs, duplicate_pairs = _build_paired_sample_pairs(
                df_meta=df_meta,
                df_columns=df.columns,
                target_col=target_col,
                group_names=group_names,
                pair_id_col=pair_id_col,
            )
            logger.info(f"Matched pairs: {len(paired_sample_pairs)}")
            if duplicate_pairs > 0:
                logger.warning(
                    "Detected %s pair IDs with duplicate samples in at least one group; using first sample per group.",
                    duplicate_pairs,
                )
            if len(paired_sample_pairs) < 3:
                raise ValueError("Too few matched pairs (<3) for paired analysis")

        results = []
        skipped = 0
        total_features = len(df.index)
        last_heartbeat = time.monotonic()

        for i, lipid in enumerate(df.index):
            if time.monotonic() - last_heartbeat >= 15:
                heartbeat_task(
                    project_id,
                    "ttest_task",
                    build_task_payload(
                        task_base,
                        "running",
                        f"Running t-test analysis ({i}/{total_features} features processed).",
                        started_at=started_at,
                        extra={"processed_features": int(i), "total_features": int(total_features)},
                    ),
                )
                last_heartbeat = time.monotonic()

            if paired:
                s1_cols = [p[0] for p in paired_sample_pairs]
                s2_cols = [p[1] for p in paired_sample_pairs]
                raw_v1 = pd.to_numeric(df.loc[lipid, s1_cols], errors="coerce").to_numpy(dtype=float)
                raw_v2 = pd.to_numeric(df.loc[lipid, s2_cols], errors="coerce").to_numpy(dtype=float)
                valid_mask = np.isfinite(raw_v1) & np.isfinite(raw_v2)
                v1 = raw_v1[valid_mask]
                v2 = raw_v2[valid_mask]
            else:
                v1 = pd.to_numeric(df.loc[lipid, g1_id], errors="coerce").dropna().to_numpy(dtype=float)
                v2 = pd.to_numeric(df.loc[lipid, g2_id], errors="coerce").dropna().to_numpy(dtype=float)

            if len(v1) < 3 or len(v2) < 3:
                skipped += 1
                continue

            log_fc = float(np.mean(v1) - np.mean(v2))
            p_val = 1.0
            method = ""
            effect_size = np.nan
            effect_metric = None

            normality_p_group1 = np.nan
            normality_p_group2 = np.nan
            normality_p_diff = np.nan
            levene_p = np.nan

            if paired:
                diff = v1 - v2
                normality_p_diff = _safe_shapiro_p(diff)
                is_normal = np.isfinite(normality_p_diff) and normality_p_diff > 0.05

                if test_type == "wilcoxon" or (test_type == "auto" and not is_normal):
                    try:
                        test = stats.wilcoxon(v1, v2, alternative="two-sided", zero_method="wilcox", method="auto")
                        p_val = float(test.pvalue)
                    except ValueError:
                        p_val = 1.0
                    method = "Wilcoxon signed-rank"
                    effect_size = _rank_biserial_signed(diff)
                    effect_metric = "rank_biserial"
                else:
                    _, p_val = stats.ttest_rel(v1, v2, nan_policy="omit")
                    method = "Paired t-test" if test_type == "auto" else "Paired t-test (forced)"
                    effect_size = _cohens_d_paired(diff)
                    effect_metric = "cohens_dz"
            else:
                normality_p_group1 = _safe_shapiro_p(v1)
                normality_p_group2 = _safe_shapiro_p(v2)
                is_normal = (
                    np.isfinite(normality_p_group1)
                    and np.isfinite(normality_p_group2)
                    and normality_p_group1 > 0.05
                    and normality_p_group2 > 0.05
                )

                if test_type == "wilcoxon" or (test_type == "auto" and not is_normal):
                    test = stats.mannwhitneyu(v1, v2, alternative="two-sided", method="auto")
                    p_val = float(test.pvalue)
                    method = "Mann-Whitney U" if test_type == "auto" else "Mann-Whitney U (forced)"
                    effect_size = _rank_biserial_from_u(test.statistic, len(v1), len(v2))
                    effect_metric = "rank_biserial"
                else:
                    forced_student = test_type == "student"
                    forced_welch = test_type == "welch"
                    if forced_student:
                        equal_var = True
                    elif forced_welch:
                        equal_var = False
                    else:
                        _, levene_p = stats.levene(v1, v2)
                        equal_var = np.isfinite(levene_p) and levene_p > 0.05
                    _, p_val = stats.ttest_ind(v1, v2, equal_var=equal_var)
                    method = ("Student's T-test" if equal_var else "Welch's T-test") + ("" if test_type == "auto" else " (forced)")
                    effect_size = _cohens_d_unpaired(v1, v2)
                    effect_metric = "cohens_d"

            if i < 5:
                logger.info(
                    "[DEBUG] %s | logFC=%.3f | p=%.3e | method=%s | effect=%s",
                    lipid,
                    log_fc,
                    p_val,
                    method,
                    f"{effect_size:.3f}" if np.isfinite(effect_size) else "NA",
                )

            results.append(
                {
                    "lipid": lipid,
                    "log_fc": log_fc,
                    "log2fc": log_fc,
                    "log_base": log_base,
                    "p_value": float(p_val),
                    "method": method,
                    "effect_size": float(effect_size) if np.isfinite(effect_size) else None,
                    "effect_metric": effect_metric,
                    "normality_p_group1": float(normality_p_group1) if np.isfinite(normality_p_group1) else None,
                    "normality_p_group2": float(normality_p_group2) if np.isfinite(normality_p_group2) else None,
                    "normality_p_diff": float(normality_p_diff) if np.isfinite(normality_p_diff) else None,
                    "levene_p": float(levene_p) if np.isfinite(levene_p) else None,
                    "paired": paired,
                    "pair_id_col": pair_id_col if paired else None,
                }
            )

        logger.info(f"Total lipids analyzed: {len(results)}")
        logger.info(f"Skipped (insufficient samples): {skipped}")

        res_df = pd.DataFrame(results)

        if not res_df.empty:
            logger.info("Running FDR correction (Benjamini-Hochberg)...")
            _, fdr, _, _ = multipletests(res_df["p_value"], method="fdr_bh")
            res_df["fdr"] = fdr
            logger.info(f"Significant (FDR < 0.05): {(res_df['fdr'] < 0.05).sum()}")
        else:
            logger.warning("Result dataframe is empty!")

        csv_buf = io.StringIO()
        res_df.to_csv(csv_buf, index=False)

        results_records = make_json_safe(res_df.to_dict(orient="records"))
        results_payload = {
            "run_id": task_run_id,
            "name": analysis_name,
            "target": target_col,
            "comparison": comparison,
            "paired": paired,
            "pair_id_col": pair_id_col if paired else None,
            "results": results_records,
            "generated_at": utc_now_iso(),
        }
        results_json = json.dumps(make_json_safe(results_payload), ensure_ascii=False, allow_nan=False)

        run_token = int(time.time() * 1000)
        csv_dest = f"projects/{uid}/{project_id}/univariate_results/{run_token}.csv"
        json_dest = f"projects/{uid}/{project_id}/univariate_results/{run_token}.json"
        csv_url = upload_public(uid, project_id, csv_dest, csv_buf.getvalue(), "text/csv")
        json_url = upload_public(uid, project_id, json_dest, results_json, "application/json")

        project_data = get_project_data(project_id)
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": utc_now_iso(),
            "target": target_col,
            "comparison": comparison,
            "paired": paired,
            "pair_id_col": pair_id_col if paired else None,
            "result_count": int(len(results_records)),
            "csv_url": csv_url,
            "results_url": json_url,
            "data_url": json_url,
            "status": "done",
            "message": "Analysis completed successfully.",
        }

        existing_history = project_data.get("ttest_history") or []
        next_history = [history_entry] + [
            _strip_inline_results(item)
            for item in existing_history
            if item.get("run_id") != task_run_id
        ]

        update_project(
            project_id,
            univariate_results=None,
            univariate_results_url=json_url,
            univariate_csv_url=csv_url,
            target_meta=target_col,
            comparison=comparison,
            ttest_history=next_history,
            ttest_task=build_task_payload(
                task_base,
                "done",
                "Analysis completed successfully.",
                started_at=project_data.get("ttest_task", {}).get("started_at") or started_at,
                completed_at=utc_now_iso(),
                extra={
                    "result_count": int(len(results_records)),
                    "csv_url": csv_url,
                    "results_url": json_url,
                    "data_url": json_url,
                },
            ),
        )

    except Exception as e:
        logger.error(f"Univariate Error: {str(e)}")
        logger.exception("Univariate analysis failed")
        completed_at = utc_now_iso()
        update_project(
            project_id,
            ttest_task=build_task_payload(
                {
                    "run_id": task_run_id,
                    "task_id": task_id,
                    "name": analysis_name,
                    "target": target_col,
                    "comparison": comparison,
                    "paired": paired,
                    "pair_id_col": pair_id_col if paired else None,
                    "started_at": utc_now_iso(),
                },
                "error",
                str(e),
                completed_at=completed_at,
            ),
        )
        project_data = get_project_data(project_id)
        error_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": project_data.get("ttest_task", {}).get("started_at") or utc_now_iso(),
            "target": target_col,
            "comparison": comparison,
            "paired": paired,
            "pair_id_col": pair_id_col if paired else None,
            "status": "error",
            "message": str(e),
        }
        update_project(
            project_id,
            ttest_history=[error_entry]
            + [
                _strip_inline_results(item)
                for item in (project_data.get("ttest_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )
