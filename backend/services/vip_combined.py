import io
import json
import logging
import time

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests

from services.common import *

logger = logging.getLogger(__name__)


def _merge_vip_history(existing_history, entry):
    return [entry] + [
        item for item in (existing_history or [])
        if isinstance(item, dict) and item.get("run_id") != entry.get("run_id")
    ]


def _build_vip_task(base_payload, status, message, *, started_at=None, completed_at=None, extra=None):
    now_iso = utc_now_iso()
    payload = {
        **(base_payload or {}),
        "status": status,
        "message": message,
        "started_at": started_at or (base_payload or {}).get("started_at") or now_iso,
        "updated_at": now_iso,
        "heartbeat_at": now_iso,
    }
    if completed_at:
        payload["completed_at"] = completed_at
    if extra:
        payload.update(extra)
    return payload


def _norm_str(value) -> str:
    text = str(value).strip()
    try:
        num = float(text)
        if num == int(num):
            return str(int(num))
        return text
    except (ValueError, OverflowError):
        return text


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


def run_vip_combined(
    project_id: str,
    uid: str,
    matrix_path: str,
    meta_path: str,
    vip_scores: list,
    target_meta: str,
    comparison: str,
    analysis_name: str,
    run_id_src: str,
    method_src: str,
    run_id: str,
    task_id: int,
) -> tuple:
    """
    Merge VIP scores from a PLS/OPLS run with pairwise t-test statistics.

    vip_scores: list of {"feature": str, "vip": float|None}
    comparison:  "GroupA vs GroupB"

    Returns (results_url, csv_url)
    """
    logger.info("===== START VIP COMBINED ANALYSIS =====")
    logger.info(f"Project: {project_id} | User: {uid} | Source run: {method_src}/{run_id_src}")
    logger.info(f"Target: {target_meta} | Comparison: {comparison}")

    started_at = utc_now_iso()
    task_base = {
        "run_id": run_id,
        "task_id": task_id,
        "analysis_type": "vip_combined",
        "name": analysis_name,
        "target_meta": target_meta,
        "comparison": comparison,
        "run_id_src": run_id_src,
        "method_src": method_src,
        "started_at": started_at,
    }
    project_data = get_project_data(project_id) or {}
    running_entry = {
        "run_id": run_id,
        "task_id": task_id,
        "name": analysis_name,
        "date": (project_data.get("vip_combined_task") or {}).get("started_at") or started_at,
        "target_meta": target_meta,
        "comparison": comparison,
        "method_src": method_src,
        "run_id_src": run_id_src,
        "status": "running",
        "message": "Running VIP combined analysis.",
    }
    update_project(
        project_id,
        vip_combined_status="running",
        vip_combined_error=None,
        vip_combined_results_url=None,
        vip_combined_csv_url=None,
        vip_combined_history=_merge_vip_history(project_data.get("vip_combined_history") or [], running_entry),
        vip_combined_task=_build_vip_task(task_base, "running", "Running VIP combined analysis.", started_at=started_at),
    )

    # Match univariate/t-test behavior: use pre-scale matrix when available.
    matrix_prescale_path = (project_data.get("matrixPreScalePath") or "").strip()
    matrix_source_path = matrix_prescale_path or matrix_path
    if matrix_prescale_path:
        logger.info("Using pre-scale matrix for VIP combined stats")
    else:
        logger.info("matrixPreScalePath not found, falling back to request matrix_path for VIP combined stats")

    try:
        df = load_csv(uid, project_id, matrix_source_path, index_col=0)
    except Exception as exc:
        if matrix_source_path != matrix_path:
            logger.warning(
                "Failed to load matrixPreScalePath (%s). Falling back to matrix_path (%s). Error: %s",
                matrix_source_path,
                matrix_path,
                exc,
            )
            df = load_csv(uid, project_id, matrix_path, index_col=0)
        else:
            raise

    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    df.columns = [_norm_str(col) for col in df.columns]
    df_meta.index = [_norm_str(idx) for idx in df_meta.index]

    if target_meta not in df_meta.columns:
        raise ValueError(f"Metadata column not found: {target_meta}")

    normalized_target = df_meta[target_meta].map(_norm_str)

    group_names = [g.strip() for g in comparison.split(" vs ")]
    if len(group_names) != 2:
        raise ValueError(f"Invalid comparison (expected 'GroupA vs GroupB'): {comparison}")

    group_names = [_norm_str(group) for group in group_names]

    available_columns = pd.Index(df.columns.map(_norm_str))
    g1_id = normalized_target[normalized_target == group_names[0]].index.intersection(available_columns)
    g2_id = normalized_target[normalized_target == group_names[1]].index.intersection(available_columns)

    logger.info(f"Group '{group_names[0]}': {len(g1_id)} samples | Group '{group_names[1]}': {len(g2_id)} samples")

    if len(g1_id) < 2 or len(g2_id) < 2:
        raise ValueError(
            f"Insufficient samples for comparison: "
            f"{group_names[0]}={len(g1_id)}, {group_names[1]}={len(g2_id)}"
        )

    # Build VIP lookup map  {feature_name -> vip_value}
    vip_map: dict = {}
    for row in (vip_scores or []):
        feat = str(row.get("feature", "")).strip()
        vip_val = row.get("vip")
        if feat:
            vip_map[feat] = float(vip_val) if vip_val is not None else None

    results = []
    skipped = 0

    for lipid in df.index:
        v1 = pd.to_numeric(df.loc[lipid, g1_id], errors="coerce").dropna().to_numpy(dtype=float)
        v2 = pd.to_numeric(df.loc[lipid, g2_id], errors="coerce").dropna().to_numpy(dtype=float)

        if len(v1) < 3 or len(v2) < 3:
            skipped += 1
            continue

        # log2FC as difference of means (data assumed log-normalized)
        log2fc = float(np.mean(v1) - np.mean(v2))

        # Normality tests
        norm1 = _safe_shapiro_p(v1)
        norm2 = _safe_shapiro_p(v2)
        is_normal = (
            np.isfinite(norm1) and np.isfinite(norm2)
            and norm1 > 0.05 and norm2 > 0.05
        )

        if is_normal:
            _, levene_p = stats.levene(v1, v2)
            equal_var = np.isfinite(levene_p) and levene_p > 0.05
            _, p_val = stats.ttest_ind(v1, v2, equal_var=equal_var)
            method = "Student's T-test" if equal_var else "Welch's T-test"
        else:
            test = stats.mannwhitneyu(v1, v2, alternative="two-sided", method="auto")
            p_val = float(test.pvalue)
            method = "Mann-Whitney U"

        vip_val = vip_map.get(str(lipid).strip())

        results.append({
            "feature": str(lipid),
            "vip": vip_val,
            "log2fc": log2fc,
            "p_value": float(p_val),
            "method": method,
        })

    logger.info(f"Analyzed: {len(results)} features, skipped (low n): {skipped}")

    if not results:
        raise ValueError("No features with sufficient samples for VIP combined analysis")

    res_df = pd.DataFrame(results)
    _, fdr, _, _ = multipletests(res_df["p_value"], method="fdr_bh")
    res_df["fdr"] = fdr

    sig_count = int((res_df["fdr"] < 0.05).sum())
    vip_sig = int(((res_df["vip"] >= 1) & (res_df["fdr"] < 0.05)).sum())
    logger.info(f"FDR<0.05: {sig_count} | VIP>=1 & FDR<0.05: {vip_sig}")

    records = res_df.to_dict(orient="records")

    # Save JSON for frontend/history reload
    run_tok = int(time.time() * 1000)
    json_dest = f"projects/{uid}/{project_id}/vip_combined/{run_tok}.json"
    results_url = upload_public(uid, project_id, json_dest, records, "application/json")

    # Save CSV
    csv_buf = io.StringIO()
    res_df.to_csv(csv_buf, index=False)

    dest = f"projects/{uid}/{project_id}/vip_combined/{run_tok}.csv"
    csv_url = upload_public(uid, project_id, dest, csv_buf.getvalue(), "text/csv")

    project_data = get_project_data(project_id) or {}
    history_entry = {
        "run_id": run_id,
        "task_id": task_id,
        "name": analysis_name,
        "date": utc_now_iso(),
        "target_meta": target_meta,
        "comparison": comparison,
        "method_src": method_src,
        "run_id_src": run_id_src,
        "results_url": results_url,
        "csv_url": csv_url,
        "status": "done",
        "message": "VIP combined analysis completed successfully.",
    }

    update_project(
        project_id,
        vip_combined_status="done",
        vip_combined_error=None,
        vip_combined_results_url=results_url,
        vip_combined_csv_url=csv_url,
        vip_combined_history=_merge_vip_history(project_data.get("vip_combined_history") or [], history_entry),
        vip_combined_task=_build_vip_task(
            task_base,
            "done",
            "VIP combined analysis completed successfully.",
            started_at=(project_data.get("vip_combined_task") or {}).get("started_at") or started_at,
            completed_at=utc_now_iso(),
            extra={
                "results_url": results_url,
                "csv_url": csv_url,
                "result_count": int(len(records)),
            },
        ),
    )

    logger.info(f"VIP combined output saved: {json_dest} | {dest}")
    return results_url, csv_url
