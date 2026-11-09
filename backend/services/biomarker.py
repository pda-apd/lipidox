import pandas as pd
import numpy as np
import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests
import io
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.stats import pearsonr, spearmanr, shapiro
from sklearn.metrics import roc_curve, auc
from sklearn.model_selection import StratifiedKFold
from sklearn.utils import resample
from statsmodels.stats.outliers_influence import variance_inflation_factor
import plotly.graph_objects as go
import time
import json
from urllib.parse import unquote, urlparse

from services.common import *
from storage import _normalize_rel_path


TASK_HEARTBEAT_INTERVAL_SECONDS = 15


def _merge_biomarker_history(existing_history, entry):
    return [entry] + [
        item for item in (existing_history or [])
        if isinstance(item, dict) and item.get("run_id") != entry.get("run_id")
    ]


def _build_biomarker_task(base_payload, status, message, *, started_at=None, completed_at=None, extra=None):
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


def _extract_rel_path_from_url_or_path(uid, project_id, url_or_path):
    """Convert a stored path/URL back to a rel path suitable for storage APIs."""
    value = str(url_or_path or "").strip()
    if not value:
        return None
    if not value.startswith("http://") and not value.startswith("https://"):
        # Treat as a stored path directly; normalize to rel
        return _normalize_rel_path(uid, project_id, value.lstrip("/"))

    parsed = urlparse(value)
    path = parsed.path or ""
    # New-style REST URLs: /files/projects/{uid}/{project_id}/rel_path
    if "/files/" in path:
        marker = "/files/"
        idx = path.find(marker)
        if idx >= 0:
            tail = path[idx + len(marker):]
            # tail = projects/{uid}/{project_id}/rel_path
            return _normalize_rel_path(uid, project_id, tail)

    # Legacy URLs — best-effort extract the path after the bucket
    parts = path.lstrip("/").split("/", 1)
    if len(parts) == 2:
        return _normalize_rel_path(uid, project_id, unquote(parts[1]))
    return _normalize_rel_path(uid, project_id, path.lstrip("/"))


def _load_records_from_storage(uid, project_id, *, path=None, url=None, kind="json"):
    rel_path = _extract_rel_path_from_url_or_path(uid, project_id, path or url)
    if rel_path:
        raw_bytes = read_bytes(uid, project_id, rel_path)
        if kind == "json":
            return json.loads(raw_bytes.decode("utf-8"))
        return pd.read_csv(io.BytesIO(raw_bytes)).to_dict(orient="records")
    return None


def _normalize_ols_results_df(raw_df):
    if raw_df is None:
        return pd.DataFrame(columns=["lipid", "beta", "p_value", "adj_r2", "fdr"])

    df = pd.DataFrame(raw_df).copy()
    if df.empty:
        return pd.DataFrame(columns=["lipid", "beta", "p_value", "adj_r2", "fdr"])

    alias_map = {
        "lipid": ["lipid", "feature", "Feature", "Lipid"],
        "beta": ["beta", "Beta", "coef", "coefficient"],
        "p_value": ["p_value", "p", "pvalue", "P", "P-value", "p.value"],
        "adj_r2": ["adj_r2", "adj_r_squared", "adjr2", "Adj R2", "Adj R²", "adj_R2"],
        "fdr": ["fdr", "FDR", "q_value", "qvalue", "adj_p", "adj_p_value"],
    }

    rename_map = {}
    for canonical, aliases in alias_map.items():
        if canonical in df.columns:
            continue
        for alias in aliases:
            if alias in df.columns:
                rename_map[alias] = canonical
                break
    if rename_map:
        df = df.rename(columns=rename_map)

    if "lipid" not in df.columns:
        raise ValueError("OLS source is missing the 'lipid' column.")

    df["lipid"] = df["lipid"].astype(str).str.strip()
    df = df[df["lipid"] != ""]

    for col in ("beta", "p_value", "adj_r2", "fdr"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    if "fdr" not in df.columns:
        if "p_value" not in df.columns:
            raise ValueError("OLS source is missing both 'fdr' and 'p_value' columns.")
        valid_mask = df["p_value"].notna()
        df["fdr"] = np.nan
        if valid_mask.any():
            _, fdr_vals, _, _ = multipletests(df.loc[valid_mask, "p_value"], method="fdr_bh")
            df.loc[valid_mask, "fdr"] = fdr_vals

    for col in ("beta", "p_value", "adj_r2"):
        if col not in df.columns:
            df[col] = np.nan

    return df[["lipid", "beta", "p_value", "adj_r2", "fdr"]].drop_duplicates(subset=["lipid"], keep="first")


def _load_ols_results_df(uid, project_id, source_run_id, inline_results=None):
    if inline_results:
        normalized_inline = _normalize_ols_results_df(inline_results)
        if not normalized_inline.empty:
            return normalized_inline

    project_data = get_project_data(project_id)
    history = project_data.get("biomarker_history") or []
    source_entry = next(
        (
            item for item in history
            if isinstance(item, dict)
            and item.get("run_id") == source_run_id
            and (item.get("analysis_type") == "ols" or item.get("ols_results_url") or item.get("ols_csv_url") or item.get("ols_results"))
        ),
        None,
    )

    candidates = []
    if source_entry:
        candidates.extend([
            (source_entry.get("ols_results"), None, None, "inline"),
            (None, source_entry.get("ols_results_path"), source_entry.get("ols_results_url"), "json"),
            (None, source_entry.get("ols_csv_path"), source_entry.get("ols_csv_url"), "csv"),
        ])

    candidates.extend([
        (project_data.get("ols_results"), None, None, "inline"),
        (None, project_data.get("ols_results_path"), project_data.get("ols_results_url"), "json"),
        (None, project_data.get("ols_csv_path"), project_data.get("ols_csv_url"), "csv"),
    ])

    for inline_records, path, url, kind in candidates:
        try:
            if kind == "inline" and inline_records:
                df = _normalize_ols_results_df(inline_records)
            elif path or url:
                records = _load_records_from_storage(uid, project_id, path=path, url=url, kind=kind)
                df = _normalize_ols_results_df(records)
            else:
                continue
            if not df.empty:
                return df
        except Exception:
            continue

    raise ValueError("Unable to load source OLS results from project history or storage.")


def _build_label_lookup(label_to_code):
    lookup = {}
    for raw_label, code in (label_to_code or {}).items():
        candidates = {raw_label, str(raw_label).strip()}
        try:
            num = float(str(raw_label).strip())
            candidates.update({num, int(num) if num.is_integer() else num, format(num, 'g')})
        except Exception:
            pass
        for candidate in candidates:
            lookup[str(candidate).strip()] = code
    return lookup


def _resolve_label_code(raw_label, label_lookup):
    if raw_label is None:
        return None
    candidates = {raw_label, str(raw_label).strip()}
    try:
        num = float(str(raw_label).strip())
        candidates.update({num, int(num) if num.is_integer() else num, format(num, 'g')})
    except Exception:
        pass

    for candidate in candidates:
        code = label_lookup.get(str(candidate).strip())
        if code is not None:
            return code
    return None


def _encode_metadata_column(series, col, enc_map):
    """Encode a single metadata column to numeric using enc_map configuration."""
    conf = enc_map.get(col, {"type": "continuous"})
    if conf.get("type") == "ordinal":
        mapping = {val: i for i, val in enumerate(conf.get("order", []))}
        return series.map(mapping)
    elif conf.get("type") == "onehot":
        return pd.get_dummies(series, prefix=col, drop_first=True)
    return pd.to_numeric(series, errors="coerce")


def get_lipid_progression_data(uid, project_id, matrix_path, meta_path, settings):
    """Return per-sample lipid abundance grouped by target stage for frontend plotting."""
    df = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    lipid_name = settings.get("lipid_name")
    target_meta = settings.get("target_meta")
    encoding_map = settings.get("encoding_map", {}) or {}
    allowed_groups = [str(v) for v in (settings.get("allowed_groups") or []) if str(v).strip()]

    if not lipid_name or not target_meta:
        raise ValueError("Missing lipid_name or target_meta.")

    if lipid_name not in df.index:
        raise ValueError(f"Lipid '{lipid_name}' not found in matrix.")

    if target_meta not in df_meta.columns:
        raise ValueError(f"Target metadata '{target_meta}' not found.")

    lipid_series = pd.to_numeric(df.loc[lipid_name], errors="coerce")
    target_series = df_meta[target_meta]

    common_samples = lipid_series.index.intersection(target_series.index)
    data_df = pd.DataFrame({
        "abundance": lipid_series.loc[common_samples],
        "target_raw": target_series.loc[common_samples]
    }).dropna()

    if allowed_groups:
        allowed_set = set(allowed_groups)
        data_df = data_df[data_df["target_raw"].astype(str).isin(allowed_set)].copy()

    if data_df.empty:
        raise ValueError("No overlap samples after filtering missing values.")

    conf = encoding_map.get(target_meta, {"type": "continuous"})

    if conf.get("type") == "ordinal":
        order = conf.get("order", [])
        if allowed_groups:
            order = [label for label in order if str(label) in set(allowed_groups)] if order else allowed_groups
        if not order:
            order = list(pd.Series(data_df["target_raw"]).dropna().unique())
        mapping = {label: i for i, label in enumerate(order)}
        data_df["stage_code"] = data_df["target_raw"].map(mapping)
        data_df["stage_label"] = data_df["target_raw"].astype(str)
    else:
        numeric_target = pd.to_numeric(data_df["target_raw"], errors="coerce")
        if numeric_target.notna().sum() >= 3:
            data_df["stage_code"] = numeric_target
            data_df["stage_label"] = numeric_target.astype(str)
        else:
            cats = allowed_groups or pd.Series(data_df["target_raw"].astype(str)).dropna().unique().tolist()
            mapping = {label: i for i, label in enumerate(cats)}
            data_df["stage_code"] = data_df["target_raw"].astype(str).map(mapping)
            data_df["stage_label"] = data_df["target_raw"].astype(str)

    data_df = data_df.dropna(subset=["stage_code", "abundance"])
    if data_df.empty:
        raise ValueError("No valid stage/lipid data available.")

    stage_summary = []
    for code in sorted(data_df["stage_code"].unique()):
        stage_slice = data_df[data_df["stage_code"] == code]
        label = str(stage_slice["stage_label"].iloc[0])
        stage_summary.append({
            "code": float(code),
            "label": label,
            "n": int(len(stage_slice))
        })

    x = data_df["stage_code"].astype(float).to_numpy()
    y = data_df["abundance"].astype(float).to_numpy()
    if len(np.unique(x)) >= 2 and len(x) >= 3:
        slope, intercept = np.polyfit(x, y, 1)
        y_pred = slope * x + intercept
        ss_res = float(np.sum((y - y_pred) ** 2))
        ss_tot = float(np.sum((y - np.mean(y)) ** 2))
        r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
    else:
        slope, intercept, r2 = 0.0, float(np.mean(y) if len(y) > 0 else 0.0), 0.0

    points = [
        {
            "sample": str(idx),
            "stage_code": float(row.stage_code),
            "stage_label": str(row.stage_label),
            "abundance": float(row.abundance)
        }
        for idx, row in data_df.iterrows()
    ]

    return {
        "lipid": lipid_name,
        "target_meta": target_meta,
        "points": points,
        "stages": stage_summary,
        "regression": {
            "slope": float(slope),
            "intercept": float(intercept),
            "r2": float(r2)
        }
    }

# --- STEP 1: OLS DISCOVERY ---
def run_ols_discovery(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    try:
        task_run_id = run_id or f"ols_{int(time.time() * 1000)}"
        analysis_name = settings.get("analysis_name") or f"OLS {task_run_id}"
        started_at = utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "ols",
            "name": analysis_name,
            "target": settings.get("target"),
            "covariates": [value for value in (settings.get("covariates") or []) if value],
            "started_at": started_at,
        }
        update_project(
            project_id,
            ols_status="running",
            message="Running OLS analysis.",
            biomarker_ols_task=_build_biomarker_task(task_base, "running", "Running OLS analysis.", started_at=started_at),
        )
        project_data = get_project_data(project_id)
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "ols",
            "name": analysis_name,
            "date": project_data.get("biomarker_ols_task", {}).get("started_at") or started_at,
            "target": settings.get("target"),
            "covariates": [value for value in (settings.get("covariates") or []) if value],
            "encoding_map": settings.get("encoding_map") or {},
            "status": "running",
            "message": "Running OLS analysis.",
        }
        update_project(
            project_id,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], running_entry)
        )

        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        map_enc_to_orig = {f"feat_{i:04d}": n for i, n in enumerate(df.index.tolist())}
        df.index = [f"feat_{i:04d}" for i in range(len(df.index))]
        df_t = df.T

        target, covs, enc_map = settings['target'], settings['covariates'], settings['encoding_map']
        cols_to_check = [target] + covs
        meta_clean = df_meta.dropna(subset=cols_to_check)
        common_samples = meta_clean.index.intersection(df_t.index)

        if len(common_samples) < 3:
            completed_at = utc_now_iso()
            error_entry = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "ols",
                "name": analysis_name,
                "date": started_at,
                "target": target,
                "covariates": covs,
                "encoding_map": enc_map,
                "status": "error",
                "message": "Too few samples.",
            }
            project_data = get_project_data(project_id)
            update_project(
                project_id,
                ols_status="error",
                message="Too few samples.",
                biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                biomarker_ols_task=_build_biomarker_task(task_base, "error", "Too few samples.", started_at=started_at, completed_at=completed_at),
            )
            return

        X_df = pd.DataFrame(index=common_samples)
        for col in cols_to_check:
            encoded = _encode_metadata_column(df_meta.loc[common_samples, col], col, enc_map)
            if isinstance(encoded, pd.DataFrame):
                for c in encoded.columns:
                    X_df[c] = encoded[c]
            else:
                X_df[col] = encoded

        X_df = X_df.dropna()
        common_samples = X_df.index

        vif_warnings = {}
        if covs and len(X_df) > X_df.shape[1] + 1:
            try:
                X_vif = X_df.astype(float)
                vif_series = pd.Series(
                    [variance_inflation_factor(X_vif.values, i) for i in range(X_vif.shape[1])],
                    index=X_vif.columns,
                )
                vif_warnings = {col: round(float(vif_series[col]), 2) for col in X_df.columns if col in vif_series.index}
                high_vif = [c for c in covs if vif_warnings.get(c, 0) >= 10]
                if high_vif:
                    print(f"OLS VIF warning (>= 10): {high_vif} — kept in model, UI will warn user")
            except Exception as vif_e:
                print(f"OLS VIF computation skipped: {vif_e}")

        X = sm.add_constant(X_df.astype(float))
        results = []
        last_heartbeat = time.monotonic()
        total_features = len(df_t.columns)

        residuals_collection = []
        for feature_index, feat_id in enumerate(df_t.columns):
            if time.monotonic() - last_heartbeat >= TASK_HEARTBEAT_INTERVAL_SECONDS:
                heartbeat_task(
                    project_id,
                    "biomarker_ols_task",
                    _build_biomarker_task(
                        task_base,
                        "running",
                        f"Running OLS analysis ({feature_index}/{total_features} features processed).",
                        started_at=started_at,
                        extra={"processed_features": int(feature_index), "total_features": int(total_features)},
                    ),
                )
                last_heartbeat = time.monotonic()
            try:
                y_raw = pd.to_numeric(df_t.loc[common_samples, feat_id], errors='coerce').dropna()
                if len(y_raw) < 3:
                    continue
                clip_outliers = bool(settings.get('clip_outliers', False))
                y_use = np.clip(y_raw, np.percentile(y_raw, 1), np.percentile(y_raw, 99)) if clip_outliers else y_raw
                X_aligned = X.loc[y_raw.index]
                model = sm.OLS(y_use, X_aligned).fit()
                residuals_collection.append(model.resid.values)
                results.append({
                    "lipid": map_enc_to_orig[feat_id],
                    "beta": float(model.params[target]),
                    "p_value": float(model.pvalues[target]),
                    "adj_r2": float(model.rsquared_adj),
                    "n_obs": int(model.nobs),
                })
            except Exception:
                continue

        res_df = pd.DataFrame(results)
        if not res_df.empty:
            _, fdr, _, _ = multipletests(res_df['p_value'], method='fdr_bh')
            res_df['fdr'] = fdr
            for cov in covs:
                vif_val = vif_warnings.get(cov, None)
                res_df[f'VIF_{cov}'] = vif_val if vif_val is not None else ''

        residual_normality_check = None
        if residuals_collection:
            n_tested = len(residuals_collection)
            n_failed = 0
            for resid in residuals_collection:
                try:
                    if len(resid) >= 3:
                        _, sw_p = shapiro(resid)
                        if sw_p < 0.05:
                            n_failed += 1
                except Exception:
                    pass
            failed_pct = round(100 * n_failed / n_tested, 1) if n_tested > 0 else 0.0
            warn = failed_pct > 50
            residual_normality_check = {"tested": n_tested, "n_failed": n_failed, "failed_pct": failed_pct, "warning": warn}
            if warn:
                print(f"[OLS] WARNING: {failed_pct}% of all features have non-normal residuals (Shapiro-Wilk p<0.05). ")
            else:
                print(f"[OLS] Residual normality OK: {failed_pct}% of all features failed Shapiro-Wilk (threshold: 50%)")

        records = res_df.to_dict(orient='records')
        run_token = int(time.time() * 1000)
        json_dest = f"projects/{uid}/{project_id}/ols_results/{run_token}.json"
        json_url = upload_public(uid, project_id, json_dest, json.dumps(records), "application/json")

        csv_buf = io.StringIO(); csv_safe_frame(res_df).to_csv(csv_buf, index=False)
        dest = f"projects/{uid}/{project_id}/ols_results/{run_token}.csv"
        csv_url = upload_public(uid, project_id, dest, csv_buf.getvalue(), 'text/csv')

        project_data = get_project_data(project_id)
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "ols",
            "name": analysis_name,
            "date": utc_now_iso(),
            "target": target,
            "covariates": covs,
            "encoding_map": enc_map,
            "ols_results_url": json_url,
            "ols_results_path": json_dest,
            "ols_csv_url": csv_url,
            "ols_csv_path": dest,
            "ols_sample_info": {"used": len(common_samples), "total": len(df_meta)},
            "vif_warnings": vif_warnings,
            "residual_normality_check": residual_normality_check,
            "result_count": int(len(records)),
            "corr_html_url": None,
            "corr_csv_url": None,
            "roc_results": None,
            "roc_csv_url": None,
            "status": "done",
            "message": "OLS completed successfully.",
        }

        update_project(
            project_id,
            ols_results=None,
            ols_results_url=json_url,
            ols_results_path=json_dest,
            ols_csv_url=csv_url,
            ols_csv_path=dest,
            ols_sample_info={"used": len(common_samples), "total": len(df_meta)},
            ols_status="done",
            message=None,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], history_entry),
            biomarker_ols_task=_build_biomarker_task(
                task_base,
                "done",
                "OLS completed successfully.",
                started_at=project_data.get("biomarker_ols_task", {}).get("started_at") or started_at,
                completed_at=utc_now_iso(),
                extra={
                    "ols_results_url": json_url,
                    "ols_csv_url": csv_url,
                    "ols_sample_info": {"used": len(common_samples), "total": len(df_meta)},
                    "result_count": int(len(records)),
                },
            ),
        )
    except Exception as e:
        try:
            project_data = get_project_data(project_id)
            task_run_id = run_id or f"ols_{int(time.time() * 1000)}"
            analysis_name = settings.get("analysis_name") or f"OLS {task_run_id}"
            started_at = project_data.get("biomarker_ols_task", {}).get("started_at") or utc_now_iso()
            task_base = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "ols",
                "name": analysis_name,
                "target": settings.get("target"),
                "covariates": [value for value in (settings.get("covariates") or []) if value],
                "started_at": started_at,
            }
            error_entry = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "ols",
                "name": analysis_name,
                "date": started_at,
                "target": settings.get("target"),
                "covariates": [value for value in (settings.get("covariates") or []) if value],
                "encoding_map": settings.get("encoding_map") or {},
                "status": "error",
                "message": str(e),
            }
            update_project(
                project_id,
                ols_status="error",
                message=str(e),
                biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                biomarker_ols_task=_build_biomarker_task(task_base, "error", str(e), started_at=started_at, completed_at=utc_now_iso()),
            )
        except Exception:
            pass
        print(f"OLS Error: {e}")

# --- STEP 2: CORRELATION (LOGIC CHUẨN) ---
def run_correlation_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    try:
        task_run_id = run_id or f"corr_{int(time.time() * 1000)}"
        analysis_name = settings.get("analysis_name") or f"Correlation {task_run_id}"
        started_at = utc_now_iso()
        corr_method = str(settings.get("corr_method") or settings.get("method") or "spearman").strip().lower()
        corr_method = "pearson" if corr_method == "pearson" else "spearman"
        corr_label = "Pearson" if corr_method == "pearson" else "Spearman"

        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "corr",
            "name": analysis_name,
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "corr_method": corr_method,
            "clinical_vars": [value for value in (settings.get("clinical_vars") or []) if value],
            "corr_top_n": settings.get("top_n"),
            "corr_sort_by": settings.get("sort_by"),
            "started_at": started_at,
        }
        update_project(
            project_id,
            corr_status="running",
            corr_error_msg=None,
            biomarker_corr_task=_build_biomarker_task(task_base, "running", "Running correlation analysis.", started_at=started_at),
        )
        project_data = get_project_data(project_id)
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "corr",
            "name": analysis_name,
            "date": project_data.get("biomarker_corr_task", {}).get("started_at") or started_at,
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "corr_method": corr_method,
            "clinical_vars": [value for value in (settings.get("clinical_vars") or []) if value],
            "corr_top_n": settings.get("top_n"),
            "corr_sort_by": settings.get("sort_by"),
            "status": "running",
            "message": "Running correlation analysis.",
        }
        update_project(
            project_id,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], running_entry)
        )

        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        # 1. Determine feature list
        source_ols_run_id = settings.get('source_ols_run_id')
        if source_ols_run_id:
            ols_res = _load_ols_results_df(uid, project_id, source_ols_run_id, settings.get('ols_results'))
            all_lipids = ols_res[ols_res['fdr'] < 0.05]['lipid'].dropna().unique().tolist()
            if not all_lipids:
                all_lipids = ols_res['lipid'].dropna().unique().tolist()
                print(f"[Corr] No significant OLS features (FDR<0.05) — using all {len(all_lipids)} OLS features as fallback.")
            else:
                print(f"[Corr] Using {len(all_lipids)} significant OLS features (FDR<0.05) from source run: {source_ols_run_id}")
        else:
            all_lipids = df.index.tolist()
            print(f"[Corr] No OLS source — running on all {len(all_lipids)} matrix features.")
        all_lipids = [lip for lip in all_lipids if lip in df.index]
        df_lipids = df.loc[all_lipids].T

        clin_vars = settings['clinical_vars']
        enc_map = settings['encoding_map']
        df_clinical = pd.DataFrame(index=df_meta.index)

        for col in clin_vars:
            print(f"Log: Đang xử lý cột Metadata '{col}'...")
            conf = enc_map.get(col, {"type": "continuous"})
            encoded = _encode_metadata_column(df_meta[col], col, enc_map)
            if isinstance(encoded, pd.DataFrame):
                for c in encoded.columns:
                    df_clinical[c] = encoded[c]
                print(f"   -> Loại: One-hot. Thêm các cột: {list(encoded.columns)}")
            elif conf['type'] == 'ordinal':
                mapping = {val: i for i, val in enumerate(conf['order'])}
                print(f"   -> Loại: Ordinal. Mapping: {mapping}")
                df_clinical[col] = encoded
            else:
                if conf.get('type') not in ('continuous', 'numeric', None):
                    print(f"   -> WARNING: column '{col}' has type '{conf.get('type')}' — using numeric cast. Spearman on non-ordinal categories may be invalid.")
                df_clinical[col] = encoded
                print(f"   -> Loại: Continuous. Số giá trị hợp lệ: {df_clinical[col].notna().sum()}")

        df_clinical = df_clinical.loc[~df_clinical.index.duplicated(keep='first')]
        df_lipids = df_lipids.loc[~df_lipids.index.duplicated(keep='first')]
        df_combined = pd.concat([df_clinical, df_lipids], axis=1, join='inner')

        corr_matrix = pd.DataFrame(index=all_lipids, columns=clin_vars)
        pval_matrix = pd.DataFrame(index=all_lipids, columns=clin_vars)
        table_results = []
        last_heartbeat = time.monotonic()

        for lipid_index, lipid in enumerate(all_lipids):
            if time.monotonic() - last_heartbeat >= TASK_HEARTBEAT_INTERVAL_SECONDS:
                heartbeat_task(
                    project_id,
                    "biomarker_corr_task",
                    _build_biomarker_task(
                        task_base,
                        "running",
                        f"Running correlation analysis ({lipid_index}/{len(all_lipids)} lipids processed).",
                        started_at=started_at,
                        extra={"processed_lipids": int(lipid_index), "total_lipids": int(len(all_lipids))},
                    ),
                )
                last_heartbeat = time.monotonic()
            for clin in clin_vars:
                valid_data = df_combined[[lipid, clin]].dropna()
                if len(valid_data) > 5:
                    if corr_method == "pearson":
                        r, p = pearsonr(valid_data[lipid], valid_data[clin])
                    else:
                        r, p = spearmanr(valid_data[lipid], valid_data[clin])
                    corr_matrix.loc[lipid, clin] = r
                    pval_matrix.loc[lipid, clin] = p
                    table_results.append({"lipid": lipid, "clinical": clin, "r": r, "p": p})
                else:
                    print(f"Log: Bỏ qua cặp {lipid} vs {clin} (Chỉ có {len(valid_data)} mẫu)")

        fdr_matrix = pval_matrix.copy()
        if table_results:
            tbl_df = pd.DataFrame(table_results)
            valid_p_mask = tbl_df["p"].notna()
            tbl_df["fdr"] = np.nan
            if valid_p_mask.any():
                _, fdr_vals, _, _ = multipletests(tbl_df.loc[valid_p_mask, "p"], method="fdr_bh")
                tbl_df.loc[valid_p_mask, "fdr"] = fdr_vals
            for _, r_row in tbl_df.iterrows():
                if pd.notna(r_row.get("fdr")):
                    fdr_matrix.loc[r_row["lipid"], r_row["clinical"]] = r_row["fdr"]
            table_results = tbl_df.to_dict(orient="records")

        corr_num = corr_matrix.astype(float)
        if len(all_lipids) > 50:
            median_abs_r = corr_num.abs().median(axis=1)
            plot_lipids = median_abs_r.nlargest(50).index.tolist()
        else:
            plot_lipids = all_lipids

        def get_stars(p):
            if pd.isna(p): return ""
            elif p < 0.001: return "***"
            elif p < 0.01: return "**"
            elif p < 0.05: return "*"
            return ""

        text_matrix = corr_matrix.loc[plot_lipids].astype(str).copy()
        for lipid in plot_lipids:
            for clin in clin_vars:
                r_val = corr_matrix.loc[lipid, clin]
                if pd.notna(r_val):
                    text_matrix.loc[lipid, clin] = f"{r_val:.2f}{get_stars(fdr_matrix.loc[lipid, clin])}"

        fig = go.Figure(data=go.Heatmap(
            z=corr_matrix.loc[plot_lipids].astype(float).values, x=clin_vars, y=plot_lipids,
            text=text_matrix.values, texttemplate='%{text}', textfont={"size": 10},
            colorscale='RdBu_r', zmid=0, zmin=-1, zmax=1,
            colorbar=dict(title=f"{corr_label} r")
        ))
        fig.update_layout(xaxis_title="Parameters", yaxis_title="Features", height=min(800, 400 + len(plot_lipids)*20), margin=dict(t=50))

        run_token = int(time.time() * 1000)
        html_dest = f"projects/{uid}/{project_id}/corr_results/{run_token}.html"
        html_url = upload_public(uid, project_id, html_dest, fig.to_html(include_plotlyjs='cdn'), 'text/html')

        corr_json_dest = f"projects/{uid}/{project_id}/corr_results/{run_token}.json"
        corr_json_url = upload_public(
            uid, project_id, corr_json_dest,
            json.dumps(table_results, ensure_ascii=False),
            'application/json',
        )

        csv_buf = io.StringIO(); csv_safe_frame(pd.DataFrame(table_results)).to_csv(csv_buf, index=False)
        csv_dest = f"projects/{uid}/{project_id}/corr_results/{run_token}.csv"
        csv_url = upload_public(uid, project_id, csv_dest, csv_buf.getvalue(), 'text/csv')

        project_data = get_project_data(project_id)
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "corr",
            "name": analysis_name,
            "date": utc_now_iso(),
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "corr_method": corr_method,
            "clinical_vars": [value for value in (settings.get("clinical_vars") or []) if value],
            "corr_top_n": settings.get("top_n"),
            "corr_sort_by": settings.get("sort_by"),
            "corr_html_url": html_url,
            "corr_results_url": corr_json_url,
            "corr_csv_url": csv_url,
            "status": "done",
            "message": "Correlation completed successfully.",
        }
        update_project(
            project_id,
            corr_results=None,
            corr_results_url=corr_json_url,
            corr_html_url=html_url,
            corr_csv_url=csv_url,
            corr_method=corr_method,
            corr_timestamp=int(time.time() * 1000),
            corr_status="done",
            corr_error_msg=None,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], history_entry),
            biomarker_corr_task=_build_biomarker_task(
                task_base,
                "done",
                "Correlation completed successfully.",
                started_at=project_data.get("biomarker_corr_task", {}).get("started_at") or started_at,
                completed_at=utc_now_iso(),
                extra={"corr_html_url": html_url, "corr_results_url": corr_json_url, "corr_csv_url": csv_url, "result_count": int(len(table_results))},
            ),
        )
    except Exception as e:
        print(f"!!! Error Correlation: {e}")
        try:
            project_data = get_project_data(project_id)
            task_run_id = run_id or f"corr_{int(time.time() * 1000)}"
            analysis_name = settings.get("analysis_name") or f"Correlation {task_run_id}"
            corr_method = str(settings.get("corr_method") or settings.get("method") or "spearman").strip().lower()
            corr_method = "pearson" if corr_method == "pearson" else "spearman"
            started_at = project_data.get("biomarker_corr_task", {}).get("started_at") or utc_now_iso()
            task_base = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "corr",
                "name": analysis_name,
                "source_ols_run_id": settings.get("source_ols_run_id"),
                "source_ols_name": settings.get("source_ols_name"),
                "corr_method": corr_method,
                "clinical_vars": [value for value in (settings.get("clinical_vars") or []) if value],
                "corr_top_n": settings.get("top_n"),
                "corr_sort_by": settings.get("sort_by"),
                "started_at": started_at,
            }
            error_entry = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "corr",
                "name": analysis_name,
                "date": started_at,
                "source_ols_run_id": settings.get("source_ols_run_id"),
                "source_ols_name": settings.get("source_ols_name"),
                "corr_method": corr_method,
                "clinical_vars": [value for value in (settings.get("clinical_vars") or []) if value],
                "corr_top_n": settings.get("top_n"),
                "corr_sort_by": settings.get("sort_by"),
                "status": "error",
                "message": str(e),
            }
            update_project(
                project_id,
                corr_status="error",
                corr_error_msg=str(e),
                biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                biomarker_corr_task=_build_biomarker_task(task_base, "error", str(e), started_at=started_at, completed_at=utc_now_iso()),
            )
        except Exception:
            pass

# --- STEP 3: ROC ANALYSIS ---

# ═══ Panel ROC (fig6-style, 2-group comparison) helpers ═══════════
# Mode "panel" (default): greedy forward feature selection with CV
# out-of-fold AUC feedback + panel-size optimisation, mirroring the
# fig6.html/fig6.py reference. Mode "feature" keeps the legacy
# per-feature behaviour unchanged.

def _panel_oof_proba(X: np.ndarray, y: np.ndarray, model: str, cv_folds: int, seed: int = 42) -> np.ndarray:
    """Out-of-fold P(y=1) via stratified CV with the chosen estimator."""
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression

    n_pos = int(y.sum())
    n_neg = int((y == 0).sum())
    n_splits = max(2, min(int(cv_folds or 5), n_pos, n_neg))
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    oof = np.full(len(y), np.nan)
    for tr_idx, te_idx in skf.split(X, y):
        if model == "rf":
            mdl = RandomForestClassifier(n_estimators=200, random_state=seed, n_jobs=-1)
        else:
            mdl = LogisticRegression(max_iter=2000)
        mdl.fit(X[tr_idx], y[tr_idx])
        oof[te_idx] = mdl.predict_proba(X[te_idx])[:, 1]
    return oof


def _panel_auc_ci_boot(y: np.ndarray, scores: np.ndarray, n_boot: int = 500, seed: int = 42):
    rng = np.random.default_rng(seed)
    aucs = []
    n = len(y)
    for _ in range(n_boot):
        bi = rng.integers(0, n, size=n)
        y_b, s_b = y[bi], scores[bi]
        if len(np.unique(y_b)) < 2:
            continue
        fpr_b, tpr_b, _ = roc_curve(y_b, s_b, drop_intermediate=False)
        aucs.append(auc(fpr_b, tpr_b))
    lo = float(np.percentile(aucs, 2.5)) if aucs else None
    hi = float(np.percentile(aucs, 97.5)) if aucs else None
    return lo, hi


def _sens_at_spec(fpr: np.ndarray, tpr: np.ndarray, spec: float) -> float:
    mask = fpr <= (1.0 - spec) + 1e-12
    return float(np.max(tpr[mask])) if mask.any() else 0.0


def _standardize(X: np.ndarray) -> np.ndarray:
    mu = np.nanmean(X, axis=0)
    sd = np.nanstd(X, axis=0)
    sd[sd == 0] = 1.0
    # ponytail: scaling on the full set slightly leaks into CV folds; acceptable
    # for feature ranking panels, flagged for users who need pristine OOF.
    return (X - mu) / sd


def _run_roc_panel(comp_df: pd.DataFrame, y_binary: pd.Series, comp: str,
                   sig_lipids, full_auc_map: dict, df_meta: pd.DataFrame, settings,
                   cfg: Optional[dict] = None) -> dict:
    """fig6-style panel for one comparison. All maths on out-of-fold
    predictions; waterfall = greedy forward selection trace, optimisation =
    panel-size sweep (lipid-only vs lipid + clinical).

    cfg (per-panel config):
      name           label shown on the ROC curve
      features       manual feature list; empty/None => auto top-N ranking
      model          'logit' | 'rf'  (overrides settings.model)
      clinical_cols  numeric metadata columns merged into the panel matrix
    Manual-feature configs skip the greedy waterfall and the size sweep
    (the feature set is already fixed by the user).
    """
    cfg = cfg or {}
    model = str(cfg.get("model") or settings.get("model") or "logit").lower()
    if model not in ("logit", "rf"):
        model = "logit"
    cv_folds = int(settings.get("cv_folds") or 5)
    top_n = int(settings.get("top_n") or 20)
    cfg_name = str(cfg.get("name") or "auto (top-N greedy)")

    manual_features = [f for f in (cfg.get("features") or []) if f in comp_df.columns]
    is_manual = bool(manual_features)

    ranking = sorted(
        ((lipid, full_auc_map[(comp, lipid)][0]) for lipid in sig_lipids if (comp, lipid) in full_auc_map),
        key=lambda x: x[1], reverse=True,
    )
    if is_manual:
        # manual order preserved; univariate AUC attached for display only
        auc_lookup = {l: a for l, a in ranking}
        ranking = [(l, auc_lookup.get(l, full_auc_map.get((comp, l), (0.5,))[0])) for l in manual_features]
    else:
        ranking = ranking[: max(2, top_n)]
    if len(ranking) < 1:
        return {}

    X_lip = comp_df[[l for l, _ in ranking]].apply(pd.to_numeric, errors="coerce")
    valid = X_lip.notna().all(axis=1)
    X_lip = X_lip.loc[valid]
    yb = y_binary.loc[valid].values.astype(int)
    if len(np.unique(yb)) < 2 or len(yb) < 10:
        return {}

    # Optional numeric clinical covariates (per-config overrides global)
    include_clinical = cfg.get("include_clinical", settings.get("include_clinical"))
    clinical_cols_req = cfg.get("clinical_cols") or settings.get("clinical_cols") or []
    used_clinical = []
    X_cli = None
    if include_clinical and clinical_cols_req:
        cli = df_meta.reindex(X_lip.index)
        for c in clinical_cols_req:
            if c not in cli.columns:
                continue
            v = pd.to_numeric(cli[c], errors="coerce")
            if v.notna().mean() >= 0.9 and v.std(skipna=True) not in (0, None, np.nan):
                v = v.fillna(v.median())
                if X_cli is None:
                    X_cli = pd.DataFrame(index=X_lip.index)
                X_cli[c] = v
                used_clinical.append(c)

    Xl = _standardize(X_lip.values)
    y = yb
    n_pos = int(y.sum()); n_neg = int((y == 0).sum())

    # ── greedy forward waterfall (AUC-guided; auto configs only) ──
    names = [l for l, _ in ranking]
    chosen = []
    chain = []
    best_auc = -1.0
    best_members = []
    if is_manual:
        best_members = list(names)
    else:
        for step, cand in enumerate(names):
            trial = chosen + [cand]
            Xs = _standardize(X_lip[trial].values)
            oof = _panel_oof_proba(Xs, y, model, cv_folds)
            if np.isnan(oof).all():
                continue
            fpr, tpr, _ = roc_curve(y, oof, drop_intermediate=False)
            a = float(auc(fpr, tpr))
            if not chosen:
                chain.append({"label": cand, "val": a, "measure": "absolute"})
            else:
                chain.append({"label": cand, "val": a - current_auc, "measure": "relative"})
            current_auc = a
            chosen.append(cand)
            if a > best_auc:
                best_auc = a
                best_members = list(chosen)
    if chain:
        chain.append({"label": "Panel", "val": best_auc, "measure": "total"})

    # ── panel-size optimisation sweep (auto configs only) ──
    sweep = []
    if not is_manual:
        max_n = len(names)
        for n in range(1, max_n + 1):
            feat_n = names[:n]
            Xn = _standardize(X_lip[feat_n].values)
            oof_n = _panel_oof_proba(Xn, y, model, cv_folds)
            fpr_n, tpr_n, _ = roc_curve(y, oof_n, drop_intermediate=False)
            rec = {"n": n, "lipid_auc": float(auc(fpr_n, tpr_n)), "combined_auc": None}
            if used_clinical:
                Xc = _standardize(np.hstack([X_lip[feat_n].values, X_cli.values]))
                oof_c = _panel_oof_proba(Xc, y, model, cv_folds)
                fpr_c, tpr_c, _ = roc_curve(y, oof_c, drop_intermediate=False)
                rec["combined_auc"] = float(auc(fpr_c, tpr_c))
            sweep.append(rec)

    # ── BEST panel ROC detail ──
    Xb = _standardize(X_lip[best_members].values)
    if used_clinical:
        Xb = _standardize(np.hstack([X_lip[best_members].values, X_cli.values]))
    oof_b = _panel_oof_proba(Xb, y, model, cv_folds)
    fpr_b, tpr_b, _ = roc_curve(y, oof_b, drop_intermediate=False)
    best_auc_final = float(auc(fpr_b, tpr_b))
    ci_lo, ci_hi = _panel_auc_ci_boot(y, oof_b)

    individual = {}
    for lipid, auc_i in ranking:
        bs = pd.to_numeric(comp_df[lipid], errors="coerce")
        vv = bs.notna()
        yv = y_binary.loc[vv].values
        sv = bs.loc[vv].values
        auc_v, flipped = full_auc_map[(comp, lipid)]
        sv_plot = -sv if flipped else sv
        fpr_i, tpr_i, _ = roc_curve(yv, sv_plot, drop_intermediate=False)
        individual[lipid] = {
            "auc": round(auc_i, 4),
            "s90": round(_sens_at_spec(fpr_i, tpr_i, 0.90), 4),
            "s95": round(_sens_at_spec(fpr_i, tpr_i, 0.95), 4),
            "fpr": [round(float(v), 4) for v in fpr_i],
            "tpr": [round(float(v), 4) for v in tpr_i],
        }

    # Final-model feature importance (top → low) for CSV export.
    importance = []
    try:
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.linear_model import LogisticRegression as _LR

        final_cols = list(best_members) + list(used_clinical)
        X_final = _standardize(X_lip[best_members].values)
        if used_clinical:
            X_final = _standardize(np.hstack([X_lip[best_members].values, X_cli.values]))
        mdl = RandomForestClassifier(n_estimators=300, random_state=42, n_jobs=-1) if model == "rf" else _LR(max_iter=2000)
        mdl.fit(X_final, y)
        w = mdl.feature_importances_ if model == "rf" else np.abs(mdl.coef_[0])
        importance = [
            {"feature": f, "weight": round(float(w[i]), 6)}
            for i, f in sorted(enumerate(final_cols), key=lambda t: -float(w[t[0]]))
        ]
    except Exception as imp_e:
        print(f"[ROC panel] importance failed for {comp}: {imp_e}")

    return {
        "comparison": comp,
        "config": cfg_name,
        "manual": is_manual,
        "importance": importance,
        "n_pos": n_pos, "n_neg": n_neg,
        "model": model, "cv_folds": cv_folds, "top_n": top_n,
        "clinical_cols": used_clinical,
        "ranking": [{"lipid": l, "auc": round(a, 4)} for l, a in ranking],
        "waterfall": [{"label": c["label"], "val": round(c["val"], 4), "measure": c["measure"]} for c in chain],
        "best": {
            "name": ' + '.join(best_members) + (' + clinical' if used_clinical else ''),
            "members": best_members,
            "auc": round(best_auc_final, 4),
            "auc_ci_low": round(ci_lo, 4) if ci_lo is not None else None,
            "auc_ci_high": round(ci_hi, 4) if ci_hi is not None else None,
            "s90": round(_sens_at_spec(fpr_b, tpr_b, 0.90), 4),
            "s95": round(_sens_at_spec(fpr_b, tpr_b, 0.95), 4),
            "fpr": [round(float(v), 4) for v in fpr_b],
            "tpr": [round(float(v), 4) for v in tpr_b],
        },
        "individual": individual,
        "optimization": [
            {"n": r["n"], "lipid_auc": round(r["lipid_auc"], 4),
             "combined_auc": round(r["combined_auc"], 4) if r["combined_auc"] is not None else None}
            for r in sweep
        ],
    }

# step 3 implementation continues below (def run_roc_analysis)
def run_roc_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    print(f"\n>>> Starting ROC Analysis for project: {project_id}")
    try:
        task_run_id = run_id or f"roc_{int(time.time() * 1000)}"
        analysis_name = settings.get("analysis_name") or f"ROC {task_run_id}"
        started_at = utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "roc",
            "name": analysis_name,
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "roc_target": settings.get("target_meta"),
            "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
            "started_at": started_at,
        }
        update_project(
            project_id,
            roc_status="running",
            roc_error_msg=None,
            roc_results=None,
            message="Running ROC analysis.",
            biomarker_roc_task=_build_biomarker_task(task_base, "running", "Running ROC analysis.", started_at=started_at),
        )
        project_data = get_project_data(project_id)
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "roc",
            "name": analysis_name,
            "date": project_data.get("biomarker_roc_task", {}).get("started_at") or started_at,
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "roc_target": settings.get("target_meta"),
            "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
            "status": "running",
            "message": "Running ROC analysis.",
        }
        update_project(
            project_id,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], running_entry),
        )

        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)
        print(f"Log 1: Matrix shape {df.shape}, Metadata shape {df_meta.shape}")

        source_ols_run_id = settings.get('source_ols_run_id')
        if source_ols_run_id:
            ols_res = _load_ols_results_df(uid, project_id, source_ols_run_id, settings.get('ols_results'))
            sig_lipids = ols_res[ols_res['fdr'] < 0.05]['lipid'].tolist()
            if not sig_lipids:
                project_data = get_project_data(project_id)
                error_entry = {
                    "run_id": task_run_id, "task_id": task_id, "analysis_type": "roc",
                    "name": analysis_name, "date": started_at,
                    "source_ols_run_id": source_ols_run_id,
                    "source_ols_name": settings.get("source_ols_name"),
                    "roc_target": settings.get("target_meta"),
                    "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
                    "status": "error", "message": "No significant lipids from OLS (FDR < 0.05).",
                }
                update_project(
                    project_id,
                    roc_status="error",
                    roc_error_msg="No significant lipids from OLS (FDR < 0.05).",
                    message="No significant lipids from OLS (FDR < 0.05).",
                    biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                    biomarker_roc_task=_build_biomarker_task(task_base, "error", "No significant lipids from OLS (FDR < 0.05).", started_at=started_at, completed_at=utc_now_iso()),
                )
                return
            print(f"Log 2: {len(sig_lipids)} significant OLS features (FDR<0.05) for ROC")
        else:
            sig_lipids = df.index.tolist()
            print(f"Log 2: No OLS source — running ROC on all {len(sig_lipids)} matrix features.")
        sig_lipids = [f for f in sig_lipids if f in df.index]
        df_lipids = df.loc[sig_lipids].T

        target_meta = settings['target_meta']
        enc_map = settings['encoding_map']
        if enc_map.get(target_meta, {}).get('type') == 'ordinal':
            order = enc_map[target_meta]['order']
            label_to_code = {label: i for i, label in enumerate(order)}
            y = df_meta[target_meta].map(label_to_code)
        else:
            y = df_meta[target_meta]
            unique_labels = y.dropna().unique()
            label_to_code = {label: label for label in unique_labels}

        label_lookup = _build_label_lookup(label_to_code)

        df_combined = pd.concat([df_lipids, y.rename('target')], axis=1, join='inner')
        df_combined = df_combined.dropna()
        print(f"Log 3: Combined shape after merge: {df_combined.shape}")
        if df_combined.empty:
            update_project(
                project_id,
                roc_status="error",
                roc_error_msg="No valid overlap samples after merging matrix and metadata for ROC.",
                roc_results=None,
                roc_results_url=None,
                roc_csv_url=None,
            )
            print("Skipping ROC: no overlap samples after merge")
            return

        comparisons = settings['comparisons']
        results = []
        summary_results = []
        skip_reasons = []

        comp_resolved = {}
        for comp in comparisons:
            if ' vs Rest' in comp:
                pos_label = comp.replace(' vs Rest', '')
                pos_code = _resolve_label_code(pos_label, label_lookup)
                if pos_code is None:
                    skip_reasons.append(f"{comp}: label not found")
                    continue
                comp_resolved[comp] = (
                    (df_combined['target'] == pos_code).astype(int),
                    df_combined,
                )
            else:
                classes = comp.split(' vs ')
                codes = [_resolve_label_code(c, label_lookup) for c in classes]
                if None in codes:
                    skip_reasons.append(f"{comp}: labels not found")
                    continue
                mask = df_combined['target'].isin(codes)
                comp_df_tmp = df_combined[mask].copy()
                pos_code = codes[0]
                y_bin_tmp = comp_df_tmp['target'].apply(lambda x: 1 if x == pos_code else 0)
                comp_resolved[comp] = (y_bin_tmp, comp_df_tmp)

        full_auc_map = {}
        for comp, (y_binary_q, comp_df_q) in comp_resolved.items():
            if y_binary_q.sum() == 0 or (len(y_binary_q) - y_binary_q.sum()) == 0 or len(comp_df_q) < 10:
                continue
            for lipid in sig_lipids:
                if lipid not in comp_df_q.columns:
                    continue
                bs_q = pd.to_numeric(comp_df_q[lipid], errors='coerce')
                valid_q = bs_q.notna()
                if valid_q.sum() < 10:
                    continue
                bs_q = bs_q.loc[valid_q]
                yb_q = y_binary_q.loc[valid_q]
                if yb_q.sum() == 0 or (yb_q == 0).sum() == 0:
                    continue
                try:
                    fpr_q, tpr_q, _ = roc_curve(yb_q, bs_q, drop_intermediate=False)
                    auc_q = float(auc(fpr_q, tpr_q))
                    score_flipped = auc_q < 0.5
                    if score_flipped:
                        fpr_q, tpr_q, _ = roc_curve(yb_q, -bs_q, drop_intermediate=False)
                        auc_q = float(auc(fpr_q, tpr_q))
                    full_auc_map[(comp, lipid)] = (auc_q, score_flipped)
                except Exception:
                    continue

        last_heartbeat = time.monotonic()
        for comp_index, (comp, (y_binary, comp_df)) in enumerate(comp_resolved.items()):
            if time.monotonic() - last_heartbeat >= TASK_HEARTBEAT_INTERVAL_SECONDS:
                heartbeat_task(
                    project_id,
                    "biomarker_roc_task",
                    _build_biomarker_task(
                        task_base,
                        "running",
                        f"Running ROC analysis ({comp_index}/{len(comp_resolved)} comparisons processed).",
                        started_at=started_at,
                        extra={"processed_comparisons": int(comp_index), "total_comparisons": int(len(comp_resolved))},
                    ),
                )
                last_heartbeat = time.monotonic()
            print(f"Processing comparison: {comp}")
            if y_binary.sum() == 0 or (len(y_binary) - y_binary.sum()) == 0 or len(comp_df) < 10:
                print(f"Skipping {comp}: insufficient data")
                skip_reasons.append(f"{comp}: insufficient data")
                continue

            for lipid in sig_lipids:
                if lipid not in comp_df.columns:
                    continue
                if (comp, lipid) not in full_auc_map:
                    continue
                auc_full, score_flipped = full_auc_map[(comp, lipid)]

                base_scores = pd.to_numeric(comp_df[lipid], errors='coerce')
                valid_mask = base_scores.notna()
                base_scores = base_scores.loc[valid_mask]
                y_binary_valid = y_binary.loc[valid_mask]
                scores = -base_scores if score_flipped else base_scores

                try:
                    scores_arr = scores.values
                    y_arr = y_binary_valid.values
                    n_pos = int(y_arr.sum())
                    n_neg = int((y_arr == 0).sum())
                    n_splits = min(5, n_pos, n_neg)

                    if n_splits >= 2:
                        skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
                        fold_aucs = []
                        for train_idx, test_idx in skf.split(scores_arr.reshape(-1, 1), y_arr):
                            y_te = y_arr[test_idx]
                            s_te = scores_arr[test_idx]
                            if len(np.unique(y_te)) < 2:
                                continue
                            fpr_f, tpr_f, _ = roc_curve(y_te, s_te, drop_intermediate=False)
                            fold_aucs.append(auc(fpr_f, tpr_f))
                        roc_auc = float(np.mean(fold_aucs)) if fold_aucs else auc_full
                    else:
                        roc_auc = auc_full
                    n_boot = 500

                    rng = np.random.default_rng(42)
                    boot_aucs = []
                    for _ in range(n_boot):
                        idx = rng.integers(0, len(scores_arr), size=len(scores_arr))
                        y_b, s_b = y_arr[idx], scores_arr[idx]
                        if len(np.unique(y_b)) < 2:
                            continue
                        fpr_b, tpr_b, _ = roc_curve(y_b, s_b, drop_intermediate=False)
                        boot_aucs.append(auc(fpr_b, tpr_b))
                    auc_ci_low = float(np.percentile(boot_aucs, 2.5)) if boot_aucs else None
                    auc_ci_high = float(np.percentile(boot_aucs, 97.5)) if boot_aucs else None

                    fpr_plot, tpr_plot, thresholds = roc_curve(y_binary_valid, scores, drop_intermediate=False)
                    youden = tpr_plot - fpr_plot
                    optimal_idx = int(np.argmax(youden))
                    raw_cutoff = float(thresholds[optimal_idx])
                    optimal_cutoff = -raw_cutoff if score_flipped else raw_cutoff
                    sensitivity = float(tpr_plot[optimal_idx])
                    specificity = float(1 - fpr_plot[optimal_idx])

                    results.append({
                        "lipid": lipid,
                        "comparison": comp,
                        "auc": roc_auc,
                        "auc_ci_low": auc_ci_low,
                        "auc_ci_high": auc_ci_high,
                        "cutoff": optimal_cutoff,
                        "score_flipped": score_flipped,
                        "sensitivity": sensitivity,
                        "specificity": specificity,
                        "fpr": fpr_plot.tolist(),
                        "tpr": tpr_plot.tolist(),
                    })
                    summary_results.append({
                        "lipid": lipid,
                        "comparison": comp,
                        "auc": roc_auc,
                        "auc_ci_low": auc_ci_low,
                        "auc_ci_high": auc_ci_high,
                        "cutoff": optimal_cutoff,
                        "score_flipped": score_flipped,
                        "sensitivity": sensitivity,
                        "specificity": specificity,
                    })
                except Exception as roc_e:
                    print(f"Error computing ROC for {lipid} in {comp}: {roc_e}")
                    continue

        # ── Panel mode (fig6-style 2-group comparison) — default ──
        panels = []
        if settings.get("mode", "panel") != "feature":
            panel_configs = settings.get("panel_configs") or [{}]  # {} = default auto greedy config
            for comp, (y_binary_p, comp_df_p) in comp_resolved.items():
                for cfg in panel_configs:
                    try:
                        panel = _run_roc_panel(comp_df_p, y_binary_p, comp, sig_lipids, full_auc_map, df_meta, settings, cfg=cfg)
                        if panel:
                            panels.append(panel)
                            print(f"[ROC panel] {comp} | {panel['config']}: AUC={panel['best']['auc']}")
                    except Exception as panel_e:
                        print(f"[ROC panel] {comp} | {cfg.get('name') if isinstance(cfg, dict) else cfg} failed: {panel_e}")

        plt.switch_backend('Agg')
        plt.figure(figsize=(10, 8))
        plt.plot([0, 1], [0, 1], 'k--', label='Random (AUC=0.5)')

        if results:
            for r in sorted(results, key=lambda x: x['auc'], reverse=True)[:10]:
                plt.plot(r['fpr'], r['tpr'], label=f"{r['lipid']} (AUC={r['auc']:.3f})")

        plt.xlabel('False Positive Rate')
        plt.ylabel('True Positive Rate')
        plt.title('ROC Curves for Top Lipids' if results else 'ROC Analysis - No Results')
        plt.legend(loc='lower right')
        plt.grid(True, alpha=0.3)

        img_buf = io.BytesIO()
        plt.close('all')
        img_buf.seek(0)
        run_token = int(time.time() * 1000)
        img_buf.close()

        results_json_dest = ""
        results_json_url = ""
        if results:
            csv_buf = io.StringIO()
            res_df = pd.DataFrame(results)[['lipid', 'comparison', 'auc', 'auc_ci_low', 'auc_ci_high', 'cutoff', 'sensitivity', 'specificity']]
            csv_safe_frame(res_df).to_csv(csv_buf, index=False)
            csv_dest = f"projects/{uid}/{project_id}/roc_results/{run_token}.csv"
            csv_url = upload_public(uid, project_id, csv_dest, csv_buf.getvalue(), 'text/csv')

            results_json_dest = f"projects/{uid}/{project_id}/roc_results/{run_token}.json"
            roc_json_str = json.dumps(
                {"results": results, "panels": panels, "mode": settings.get("mode", "panel")},
                ensure_ascii=False, allow_nan=False)
            results_json_url = upload_public(uid, project_id, results_json_dest, roc_json_str, 'application/json')
        else:
            csv_url = ""

        if not results:
            reason = '; '.join(skip_reasons[:5]) if skip_reasons else 'No valid ROC curves were generated.'
            project_data = get_project_data(project_id)
            error_entry = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "roc",
                "name": analysis_name,
                "date": started_at,
                "source_ols_run_id": settings.get("source_ols_run_id"),
                "source_ols_name": settings.get("source_ols_name"),
                "roc_target": settings.get("target_meta"),
                "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
                "status": "error",
                "message": f"ROC could not be computed: {reason}",
            }
            update_project(
                project_id,
                roc_status="error",
                roc_error_msg=f"ROC could not be computed: {reason}",
                roc_results=None,
                roc_results_url=None,
                roc_csv_url=None,
                biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                biomarker_roc_task=_build_biomarker_task(task_base, "error", f"ROC could not be computed: {reason}", started_at=started_at, completed_at=utc_now_iso()),
            )
            print(f"Skipping ROC save: no valid result. Reason: {reason}")
            return

        project_data = get_project_data(project_id)
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "analysis_type": "roc",
            "name": analysis_name,
            "date": utc_now_iso(),
            "source_ols_run_id": settings.get("source_ols_run_id"),
            "source_ols_name": settings.get("source_ols_name"),
            "roc_target": settings.get("target_meta"),
            "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
            "roc_results": build_roc_history_summary(summary_results),
            "mode": settings.get("mode", "panel"),
            "roc_panel_summary": [
                {"comparison": p["comparison"], "config": p.get("config"),
                 "best_auc": p["best"]["auc"], "n_members": len(p["best"]["members"]),
                 "model": p["model"], "clinical_cols": p["clinical_cols"],
                 "manual": p.get("manual", False)}
                for p in panels
            ],
            "roc_results_url": results_json_url,
            "roc_csv_url": csv_url,
            "roc_img_url": None,
            "status": "done",
            "message": "ROC completed successfully.",
        }

        update_project(
            project_id,
            roc_results=None,
            roc_results_url=results_json_url,
            roc_img_url=None,
            roc_csv_url=csv_url,
            roc_result_count=int(len(summary_results)),
            roc_status="done",
            roc_error_msg=None,
            biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], history_entry),
            biomarker_roc_task=_build_biomarker_task(
                task_base,
                "done",
                "ROC completed successfully.",
                started_at=project_data.get("biomarker_roc_task", {}).get("started_at") or started_at,
                completed_at=utc_now_iso(),
                extra={"roc_results_url": results_json_url, "roc_csv_url": csv_url, "roc_img_url": None, "result_count": int(len(summary_results))},
            ),
        )
        print("Log 4: >>> ROC Analysis Completed Successfully.")
    except Exception as e:
        print(f"!!! Error ROC: {e}")
        try:
            project_data = get_project_data(project_id)
            task_run_id = run_id or f"roc_{int(time.time() * 1000)}"
            analysis_name = settings.get("analysis_name") or f"ROC {task_run_id}"
            started_at = project_data.get("biomarker_roc_task", {}).get("started_at") or utc_now_iso()
            task_base = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "roc",
                "name": analysis_name,
                "source_ols_run_id": settings.get("source_ols_run_id"),
                "source_ols_name": settings.get("source_ols_name"),
                "roc_target": settings.get("target_meta"),
                "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
                "started_at": started_at,
            }
            error_entry = {
                "run_id": task_run_id,
                "task_id": task_id,
                "analysis_type": "roc",
                "name": analysis_name,
                "date": started_at,
                "source_ols_run_id": settings.get("source_ols_run_id"),
                "source_ols_name": settings.get("source_ols_name"),
                "roc_target": settings.get("target_meta"),
                "roc_comparisons": [value for value in (settings.get("comparisons") or []) if value],
                "status": "error",
                "message": str(e),
            }
            update_project(
                project_id,
                roc_status="error",
                roc_error_msg=str(e),
                biomarker_history=_merge_biomarker_history(project_data.get("biomarker_history") or [], error_entry),
                biomarker_roc_task=_build_biomarker_task(task_base, "error", str(e), started_at=started_at, completed_at=utc_now_iso()),
            )
        except Exception:
            pass


def build_roc_history_summary(rows):
    def _safe_float(v):
        try:
            f = float(v)
            return f if np.isfinite(f) else None
        except (TypeError, ValueError):
            return None

    return [
        {
            "lipid": row.get("lipid"),
            "comparison": row.get("comparison"),
            "auc": _safe_float(row.get("auc", 0.0)),
            "auc_ci_low": _safe_float(row.get("auc_ci_low")),
            "auc_ci_high": _safe_float(row.get("auc_ci_high")),
            "cutoff": _safe_float(row.get("cutoff", 0.0)),
            "sensitivity": _safe_float(row.get("sensitivity", 0.0)),
            "specificity": _safe_float(row.get("specificity", 0.0)),
        }
        for row in (rows or [])
    ]
