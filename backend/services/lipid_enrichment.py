"""Lipid-native enrichment for two-group comparisons (LipidSig-style).

ORA  : Fisher exact test of significant lipids per characteristic value.
LSEA : preranked enrichment (gseapy.prerank) over lipid-characteristic sets
       built from the LION/annotation snapshots — a Python re-implementation
       of LipidSigR's enrichment_lsea() (fgsea). Scores will not be
       bit-identical to fgsea but follow the same semantics
       (rank by log2FC by default, min set size n_lipid=2).

Both reuse the exact payload/history contract of services/enrichment.py so
the existing enrichment UI renders lipid results identically to gene results.
"""
from __future__ import annotations

import io
import json
import logging
import time

import numpy as np
import pandas as pd
import gseapy as gp
from scipy.stats import fisher_exact
from statsmodels.stats.multitest import multipletests

from services.common import *
from services.idconvert import convert_ids, _LION_CHAR_COLS
from services.enrichment import (
    _build_network_payload,
    _build_ora_network_payload,
    _build_term_payload,
    _clean_feature_name,
    _load_source_ttest_run,
    _safe_float,
)
from services.enrichment import _resolve_feature_percent_mode

logger = logging.getLogger(__name__)

# Characteristic keys usable for ORA/LSEA (value -> set of lipids).
CHARACTERISTICS = (
    [{"key": "main_class", "label": "LIPID MAPS main class"},
     {"key": "sub_class", "label": "LIPID MAPS sub class"},
     {"key": "core", "label": "Lipid core structure"}]
    + [{"key": f"LION.{c}", "label": f"LION {c}"} for c in _LION_CHAR_COLS]
)

_DEFAULT_CHARACTERISTICS = ["main_class", "LION.Category", "LION.Main.Class", "LION.Function"]

MAPPING_FRACTION_THRESHOLD = 0.5  # >50% unmappable ⇒ hard error (user requirement)


def get_lipid_characteristics() -> list[dict]:
    """Characteristic selector options for the enrichment modal."""
    return list(CHARACTERISTICS)


# ─── helpers ────────────────────────────────────────────────────────

def _extract_feature_stats(source_results):
    """(feature, log2fc, fdr, pval) tuples from a DAL result payload."""
    rows = []
    for record in source_results or []:
        feature = _clean_feature_name(
            record.get("gene") or record.get("Gene") or record.get("feature")
            or record.get("Feature") or record.get("lipid") or record.get("Lipid")
        )
        logfc = _safe_float(record.get("log2fc", record.get("Log2FC", record.get("log_fc", record.get("LogFC")))))
        fdr = _safe_float(record.get("fdr", record.get("FDR")))
        pval = _safe_float(record.get("p_value", record.get("pvalue", record.get("p_val", record.get("P.Value")))))
        if not feature:
            continue
        rows.append({"Feature": feature, "LogFC": logfc, "FDR": fdr, "PValue": pval})
    return rows


def _annotate(features: list[str]) -> pd.DataFrame:
    """feature -> annotation row (one row per input feature)."""
    conv = convert_ids(features)
    table = pd.DataFrame(conv["rows"])
    return table


def _check_mapping_gate(anno: pd.DataFrame) -> None:
    total = len(anno)
    mapped = int(((anno["Matched.Name"] != "") | (anno["LION_ID"] != "")).sum())
    fraction = (mapped / total) if total else 0.0
    if fraction < MAPPING_FRACTION_THRESHOLD:
        unmapped = anno.loc[(anno["Matched.Name"] == "") & (anno["LION_ID"] == ""), "Input.Name"].tolist()
        raise ValueError(
            f"Only {mapped}/{total} features ({fraction:.0%}) could be mapped to lipid IDs — "
            "at least 50% mappable features are required for lipid enrichment/network. "
            "Fix feature names first (see ID Conversion page). Unmapped examples: "
            + ", ".join(unmapped[:10])
        )


def _char_series(anno: pd.DataFrame, char_key: str) -> pd.Series:
    if char_key.startswith("LION."):
        col = char_key  # annotation rows already use "LION.<char>" columns
    else:
        col = char_key  # main_class / sub_class / core
    if col not in anno.columns:
        return pd.Series([""] * len(anno), index=anno.index, dtype=str)
    return anno[col].fillna("").astype(str)


def _build_sets(anno: pd.DataFrame, char_key: str, min_size: int = 2, max_size: int = 500) -> dict[str, list[str]]:
    values = _char_series(anno, char_key)
    sets: dict[str, list[str]] = {}
    for feature, value in zip(anno["Input.Name"], values):
        value = value.strip()
        if not value or value.lower() == "nan":
            continue
        sets.setdefault(value, []).append(feature)
    return {k: sorted(set(v)) for k, v in sets.items() if min_size <= len(set(v)) <= max_size}


# ─── main runner ────────────────────────────────────────────────────

def run_ttest_enrichment_lipid(project_id, uid, settings, run_id=None, task_id=None):
    """Background runner for lipid ORA/LSEA. Mirrors run_ttest_enrichment{,_ora}."""
    task_run_id = run_id or f"enrich_lipid_{int(time.time() * 1000)}"
    source_run_id = settings.get("source_run_id")
    title = settings.get("title") or f"Lipid enrichment {time.strftime('%Y-%m-%d %H:%M:%S')}"
    method = str(settings.get("method") or "LSEA").upper()     # ORA | LSEA
    if method not in ("ORA", "LSEA"):
        method = "LSEA"
    rank_by = settings.get("rank_by") or "log2fc"            # log2fc | signed_fdr
    significant_by = settings.get("significant") or "fdr"    # fdr | pval
    p_cutoff = _safe_float(settings.get("p_cutoff"), 0.05) or 0.05
    feature_source = settings.get("feature_source") or "all"  # all | up | down (ORA)
    n_lipid = int(_safe_float(settings.get("n_lipid"), 2) or 2)
    characteristics = [c for c in (settings.get("characteristics") or []) if c] or list(_DEFAULT_CHARACTERISTICS)
    characteristics = [c for c in characteristics if any(ch["key"] == c for ch in CHARACTERISTICS)]
    if not characteristics:
        characteristics = list(_DEFAULT_CHARACTERISTICS)
    databases = [f"LIPID::{c}" for c in characteristics]
    feature_percent_mode = _resolve_feature_percent_mode(settings)

    project_data = get_project_data(project_id)
    existing_task = project_data.get("ttest_enrichment_task") or {}
    task_started_at = existing_task.get("started_at") or utc_now_iso()

    def _task(status, message, **extra):
        return {
            "run_id": task_run_id, "task_id": task_id, "title": title,
            "source_run_id": source_run_id, "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"), "method": method,
            "input_type": "Lipid", "databases": databases,
            "status": status, "message": message,
            "started_at": task_started_at, **extra,
        }

    def _history(status, message, date, **extra):
        return {
            "run_id": task_run_id, "task_id": task_id, "title": title, "date": date,
            "source_run_id": source_run_id, "target": settings.get("target_meta"),
            "comparison": settings.get("comparison"), "method": method,
            "input_type": "Lipid", "databases": databases,
            "status": status, "message": message, **extra,
        }

    try:
        update_project(project_id, ttest_enrichment_task=_task("running", f"Running lipid {method} enrichment."))
        existing_history = project_data.get("ttest_enrichment_history") or []
        update_project(
            project_id,
            ttest_enrichment_history=[_history("running", f"Running lipid {method} enrichment.", task_started_at)]
            + [item for item in existing_history if item.get("run_id") != task_run_id],
        )

        project_data, source_entry = _load_source_ttest_run(uid, project_id, source_run_id=source_run_id)
        source_results = source_entry.get("results") or []
        stats_rows = _extract_feature_stats(source_results)
        if len(stats_rows) < 5:
            raise ValueError("Too few DAL records for lipid enrichment.")

        features = [r["Feature"] for r in stats_rows]
        anno = _annotate(features)
        _check_mapping_gate(anno)

        feature_stats = {r["Feature"]: r for r in stats_rows}
        anno = anno[anno["Input.Name"].isin(feature_stats)].copy()

        result_records: list[dict] = []
        term_details: dict = {}
        raw_result_frames: list = []

        if method == "ORA":
            sig_mask = []
            for f in anno["Input.Name"]:
                st = feature_stats[f]
                stat_value = st["FDR"] if significant_by == "fdr" else st["PValue"]
                stat_value = _safe_float(stat_value, 1.0)
                logfc = _safe_float(st["LogFC"], 0.0)
                is_sig = stat_value is not None and stat_value < p_cutoff
                if feature_source == "up" and (logfc is None or logfc <= 0):
                    is_sig = False
                if feature_source == "down" and (logfc is None or logfc >= 0):
                    is_sig = False
                sig_mask.append(bool(is_sig))
            anno["_sig"] = sig_mask
            n_sig = int(anno["_sig"].sum())
            if n_sig < n_lipid:
                raise ValueError(f"Only {n_sig} significant lipids ({significant_by} < {p_cutoff}) — too few for ORA.")

            term_rows = []
            for char_key in characteristics:
                database = f"LIPID::{char_key}"
                values = _char_series(anno, char_key)
                universe = [(f, v.strip(), s) for f, v, s in zip(anno["Input.Name"], values, anno["_sig"]) if v.strip() and v.strip().lower() != "nan"]
                if not universe:
                    continue
                vals = sorted({v for _, v, _ in universe})
                n_universe = len(universe)
                sig_in_universe = sum(1 for _, _, s in universe if s)
                for v in vals:
                    in_set = [f for f, fv, _ in universe if fv == v]
                    if not (n_lipid <= len(in_set)):
                        continue
                    a = sum(1 for f, fv, s in universe if fv == v and s)
                    if a == 0:
                        continue
                    b = sig_in_universe - a
                    c = len(in_set) - a
                    d = n_universe - a - b - c
                    if min(a, b, c, d) < 0:
                        continue  # defensive; impossible with consistent sets
                    _, p = fisher_exact([[a, b], [c, d]], alternative="greater")
                    term_rows.append({
                        "Term": v, "Database": database, "p_raw": p,
                        "matched": sorted([f for f, fv, s in universe if fv == v and s]),
                        "set_size": len(in_set), "universe": n_universe,
                    })
            if not term_rows:
                raise ValueError("No characteristic term has significant lipid overlap.")

            raw_ps = np.array([t["p_raw"] for t in term_rows])
            fdrs = multipletests(raw_ps, method="fdr_bh")[1]
            for t, fdr in zip(term_rows, fdrs):
                term_id = f"{t['Database']}::{t['Term']}"
                result_records.append({
                    "term_id": term_id,
                    "Term": t["Term"],
                    "Database": t["Database"],
                    # Mirrors the gene-side ORA convention: p-value column
                    # carries the adjusted value; raw p kept separately.
                    "p-value": float(fdr),
                    "FDR": float(fdr),
                    "p.raw": float(t["p_raw"]),
                    "Feature count": len(t["matched"]),
                    "Matched features": ", ".join(t["matched"]),
                    "Set size": t["set_size"],
                })
            result_table = (
                pd.DataFrame(result_records).sort_values(by="p-value", ascending=True).reset_index(drop=True)
            )
            network_payload = _build_ora_network_payload(result_records)
            export_table = result_table[
                ["Term", "Database", "p-value", "FDR", "p.raw", "Feature count", "Set size", "Matched features"]
            ].copy()

        else:  # LSEA
            rank_rows = []
            for f in anno["Input.Name"]:
                st = feature_stats[f]
                logfc = _safe_float(st["LogFC"])
                fdr = _safe_float(st["FDR"], 1.0)
                if logfc is None:
                    continue
                if rank_by == "signed_fdr":
                    score = float(np.sign(logfc) * -np.log10(max(fdr, 1e-300)))
                else:
                    score = float(logfc)
                rank_rows.append((f, score))
            if len(rank_rows) < 10:
                raise ValueError("Too few ranked lipids with log2FC for LSEA.")
            rank_df = pd.DataFrame(rank_rows, columns=["Feature", "Rank"])
            rank_df = rank_df.sort_values("Rank", ascending=False).reset_index(drop=True)
            ranked_features = rank_df["Feature"].tolist()

            for char_key in characteristics:
                database = f"LIPID::{char_key}"
                sets = _build_sets(anno, char_key, min_size=n_lipid)
                if not sets:
                    continue
                pre_res = gp.prerank(
                    rnk=rank_df,
                    gene_sets=sets,
                    processes=4,
                    permutation_num=1000,
                    outdir=None,
                    seed=42,
                    verbose=False,
                )
                result_df = pre_res.res2d.copy().reset_index(drop=True)
                if result_df.empty:
                    continue
                raw_frame = result_df.copy()
                raw_frame["Term"] = raw_frame["Term"].map(lambda t: f"{database}::{t}")
                raw_frame["Database"] = database
                raw_result_frames.append(raw_frame)
                for _, row in result_df.iterrows():
                    raw_term = str(row.get("Term") or "")
                    detail = pre_res.results.get(raw_term) or {}
                    table_record, detail_payload = _build_term_payload(
                        raw_term, database, row, detail, ranked_features,
                        feature_percent_mode=feature_percent_mode,
                    )
                    result_records.append(table_record)
                    term_details[table_record["term_id"]] = detail_payload

            if not result_records:
                raise ValueError("No LSEA result returned (sets may be too small; lower n_lipid).")

            result_table = (
                pd.DataFrame(result_records)
                .sort_values(by=["|NES|", "FDR"], ascending=[False, True])
                .reset_index(drop=True)
            )
            network_payload = _build_network_payload(raw_result_frames, term_details)
            export_table = result_table[
                ["Term", "Database", "Matched features", "p-value", "FDR", "NES", "|NES|", "ES",
                 "Feature count", "Feature percent", "Tag percent"]
            ].copy()

        payload = {
            "run_id": task_run_id,
            "title": title,
            "date": utc_now_iso(),
            "source_run_id": source_entry.get("run_id"),
            "source_name": source_entry.get("name") or "DAL",
            "target": source_entry.get("target") or settings.get("target_meta"),
            "comparison": source_entry.get("comparison") or settings.get("comparison"),
            "method": method,
            "input_type": "Lipid",
            "rank_by": rank_by if method == "LSEA" else None,
            "databases": databases,
            "results_table": make_json_safe(result_table.to_dict(orient="records")),
            "term_details": make_json_safe(term_details),
            "network": make_json_safe(network_payload),
        }

        csv_buffer = io.StringIO()
        export_table.to_csv(csv_buffer, index=False)
        data_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.json"
        csv_dest = f"projects/{uid}/{project_id}/ttest_enrichment_{task_run_id}.csv"
        data_url = upload_public(
            uid, project_id, data_dest,
            json.dumps(make_json_safe(payload), ensure_ascii=False, allow_nan=False),
            "application/json",
        )
        csv_url = upload_public(
            uid, project_id, csv_dest,
            csv_buffer.getvalue().encode("utf-8-sig"),
            "text/csv; charset=utf-8",
        )

        sig_col = "FDR" if "FDR" in result_table.columns else "p-value"
        significant_count = int((result_table[sig_col] < 0.05).sum())
        history_entry = _history(
            "done", f"Lipid {method} enrichment completed.", payload["date"],
            source_name=payload["source_name"],
            term_count=int(len(result_table)),
            significant_count=significant_count,
            csv_url=csv_url, data_url=data_url,
        )
        # Re-read right before writing: another enrichment running in parallel
        # (e.g. ORA + LSEA submitted together) would otherwise be clobbered.
        project_data = get_project_data(project_id)
        existing_history = project_data.get("ttest_enrichment_history") or []
        update_project(
            project_id,
            ttest_enrichment_history=[history_entry]
            + [item for item in existing_history if item.get("run_id") != task_run_id],
            ttest_enrichment_task=_task(
                "done", f"Lipid {method} enrichment completed.",
                term_count=int(len(result_table)), significant_count=significant_count,
                csv_url=csv_url, data_url=data_url, completed_at=utc_now_iso(),
            ),
        )
        logger.info("Lipid %s done | project=%s run=%s terms=%s", method, project_id, task_run_id, len(result_table))
        payload["csv_url"] = csv_url
        payload["data_url"] = data_url
        payload["history_entry"] = history_entry
        return payload

    except Exception as exc:
        logger.exception("Lipid %s enrichment failed", method)
        update_project(
            project_id,
            ttest_enrichment_task=_task("error", str(exc), completed_at=utc_now_iso()),
        )
        project_data = get_project_data(project_id)
        update_project(
            project_id,
            ttest_enrichment_history=[_history("error", str(exc), task_started_at)]
            + [item for item in (project_data.get("ttest_enrichment_history") or []) if item.get("run_id") != task_run_id],
        )
        return None
