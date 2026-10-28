import pandas as pd
import numpy as np
from scipy import stats
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.oneway import anova_oneway
import io
import json
import logging
import time
import scikit_posthocs as sp
import pingouin as pg

from services.common import *

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _games_howell_matrix(ph_input_df):
    """Return a symmetric p-value matrix for Games-Howell post-hoc results."""
    groups = sorted(ph_input_df["group"].dropna().astype(str).unique().tolist())
    if len(groups) < 2:
        return None

    try:
        gh_df = pg.pairwise_gameshowell(data=ph_input_df, dv="value", between="group")
    except Exception as exc:
        logger.warning("Games-Howell failed: %s", exc)
        return None

    ph_matrix = pd.DataFrame(np.nan, index=groups, columns=groups, dtype=float)
    for group_name in groups:
        ph_matrix.loc[group_name, group_name] = 1.0

    for _, row in gh_df.iterrows():
        group_a = str(row.get("A"))
        group_b = str(row.get("B"))
        p_value = row.get("pval")
        if group_a in ph_matrix.index and group_b in ph_matrix.columns and pd.notna(p_value):
            p_float = float(p_value)
            ph_matrix.loc[group_a, group_b] = p_float
            ph_matrix.loc[group_b, group_a] = p_float

    return ph_matrix


def _safe_shapiro_p(values):
    arr = np.asarray(values, dtype=float)
    if arr.size < 8:
        return np.nan
    if np.nanstd(arr) == 0:
        return np.nan
    if arr.size > 5000:
        rng = np.random.default_rng(42)
        arr = rng.choice(arr, size=5000, replace=False)
    try:
        return float(stats.shapiro(arr).pvalue)
    except Exception:
        return np.nan


def _safe_levene_p(data_groups):
    if len(data_groups) < 2:
        return np.nan
    try:
        return float(stats.levene(*data_groups, center="median").pvalue)
    except Exception:
        return np.nan


def _safe_anova_p(data_groups):
    try:
        return float(stats.f_oneway(*data_groups).pvalue)
    except Exception:
        return np.nan


def _safe_welch_anova_p(data_groups):
    try:
        return float(anova_oneway(data_groups, use_var="unequal").pvalue)
    except Exception:
        return np.nan


def _safe_kruskal_result(data_groups):
    try:
        res = stats.kruskal(*data_groups)
        return float(res.statistic), float(res.pvalue)
    except Exception:
        return np.nan, np.nan


def _eta_squared(data_groups):
    groups = [np.asarray(g, dtype=float) for g in data_groups]
    if not groups:
        return np.nan
    all_vals = np.concatenate(groups)
    if all_vals.size == 0:
        return np.nan
    grand_mean = np.mean(all_vals)
    ss_between = sum(len(g) * (np.mean(g) - grand_mean) ** 2 for g in groups)
    ss_total = np.sum((all_vals - grand_mean) ** 2)
    if ss_total <= 0:
        return 0.0
    return float(ss_between / ss_total)


def _epsilon_squared_kruskal(h_stat, n_total, k_groups):
    if not np.isfinite(h_stat) or n_total <= k_groups:
        return np.nan
    eps_sq = (h_stat - k_groups + 1) / (n_total - k_groups)
    return float(np.clip(eps_sq, 0.0, 1.0))


def run_anova_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    task_run_id = run_id or f"anova_{int(pd.Timestamp.now().timestamp() * 1000)}"
    analysis_name = settings.get("analysis_name") or f"ANOVA {task_run_id}"
    target_col = settings['target_meta']
    test_type = settings.get("test_type", "auto")  # "auto" | "anova" | "welch-anova" | "kruskal-wallis"
    try:
        logger.info(f"===== START ANOVA/KW ANALYSIS: {project_id} =====")
        started_at = utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "target": target_col,
            "started_at": started_at,
        }
        update_project(
            project_id,
            anova_task=build_task_payload(task_base, "running", "Running ANOVA/KW analysis.", started_at=started_at),
        )
        project_data = get_project_data(project_id)
        running_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": project_data.get("anova_task", {}).get("started_at") or started_at,
            "target": target_col,
            "status": "running",
            "message": "Running ANOVA/KW analysis.",
        }
        update_project(
            project_id,
            anova_history=[running_entry] + [
                item for item in (project_data.get("anova_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )

        # Load dữ liệu matrix và meta
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        df_meta[target_col] = df_meta[target_col].astype(str)
        df_meta.loc[df_meta[target_col].str.strip().str.lower().isin(['nan', 'none', 'null', '']), target_col] = np.nan

        groups = df_meta[target_col].dropna().unique()
        groups = np.sort(groups)
        logger.info(f"Groups found ({len(groups)}): {groups.tolist()}")

        group_indices = {g: df_meta[df_meta[target_col] == g].index.intersection(df.columns) for g in groups}

        full_json_data = []
        skipped_lipids = []

        import itertools
        all_possible_pairs = [
            tuple(sorted([str(g1), str(g2)]))
            for g1, g2 in itertools.combinations(groups, 2)
        ]
        total_features = len(df.index)
        last_heartbeat = time.monotonic()

        for index, lipid in enumerate(df.index):
            if time.monotonic() - last_heartbeat >= 15:
                heartbeat_task(
                    project_id,
                    "anova_task",
                    build_task_payload(
                        task_base,
                        "running",
                        f"Running ANOVA/KW analysis ({index}/{total_features} features processed).",
                        started_at=started_at,
                        extra={"processed_features": int(index), "total_features": int(total_features)},
                    ),
                )
                last_heartbeat = time.monotonic()

            data_groups = []
            valid_group_names = []

            for g in groups:
                vals = df.loc[lipid, group_indices[g]].dropna().values
                if len(vals) >= 3:
                    data_groups.append(vals)
                    valid_group_names.append(g)

            if len(data_groups) < 3:
                skipped_lipids.append(lipid)
                continue

            method = ""
            p_val = 1.0

            shapiro_by_group = {}
            group_normal_flags = []
            zero_var_groups = []
            group_vars = {}
            for i, g in enumerate(valid_group_names):
                vals = np.asarray(data_groups[i], dtype=float)
                p_norm = _safe_shapiro_p(vals)
                shapiro_by_group[str(g)] = float(p_norm) if np.isfinite(p_norm) else None
                group_vars[str(g)] = float(np.nanvar(vals, ddof=1)) if vals.size > 1 else 0.0
                is_zero_var = np.nanstd(vals) == 0
                if is_zero_var:
                    zero_var_groups.append(str(g))
                if vals.size < 8:
                    is_normal = not is_zero_var
                else:
                    is_normal = np.isfinite(p_norm) and p_norm > 0.05 and not is_zero_var
                group_normal_flags.append(is_normal)

            all_groups_normal = all(group_normal_flags)
            levene_p = _safe_levene_p(data_groups)
            small_n_variance_unstable = any(len(g) < 5 for g in data_groups)
            equal_var = np.isfinite(levene_p) and levene_p > 0.05
            if small_n_variance_unstable and np.isfinite(levene_p) and levene_p < 0.05:
                equal_var = False

            n_total = int(sum(len(g) for g in data_groups))
            k_groups = len(data_groups)
            kruskal_h = np.nan
            effect_size = np.nan
            effect_metric = None

            positive_vars = [v for v in group_vars.values() if np.isfinite(v) and v > 0]
            variance_ratio = float(max(positive_vars) / min(positive_vars)) if len(positive_vars) >= 2 else np.nan
            shape_warning = bool(np.isfinite(variance_ratio) and variance_ratio >= 4.0)

            decision_path = ""
            if zero_var_groups or test_type == "kruskal-wallis":
                kruskal_h, p_val = _safe_kruskal_result(data_groups)
                method = "Kruskal-Wallis"
                decision_path = "forced Kruskal due to zero-variance groups" if zero_var_groups else "user-forced"
                effect_size = _epsilon_squared_kruskal(kruskal_h, n_total, k_groups)
                effect_metric = "epsilon_sq"
            elif test_type == "anova":
                p_val = _safe_anova_p(data_groups)
                method = "One-way ANOVA (forced)"
                decision_path = "user-forced"
                effect_size = _eta_squared(data_groups)
                effect_metric = "eta_sq"
            elif test_type == "welch-anova":
                p_val = _safe_welch_anova_p(data_groups)
                method = "Welch ANOVA (forced)"
                decision_path = "user-forced"
                effect_size = _eta_squared(data_groups)
                effect_metric = "eta_sq (approx)"
            elif all_groups_normal and equal_var:
                p_val = _safe_anova_p(data_groups)
                method = "One-way ANOVA"
                decision_path = "all groups normal + equal variance"
                effect_size = _eta_squared(data_groups)
                effect_metric = "eta_sq"
            elif all_groups_normal and not equal_var:
                p_val = _safe_welch_anova_p(data_groups)
                method = "Welch ANOVA"
                if small_n_variance_unstable:
                    decision_path = "all groups normal + Levene indicates unequal variance with small n"
                else:
                    decision_path = "all groups normal + unequal variance"
                effect_size = _eta_squared(data_groups)
                effect_metric = "eta_sq (approx)"
            else:
                kruskal_h, p_val = _safe_kruskal_result(data_groups)
                method = "Kruskal-Wallis"
                decision_path = "at least one group non-normal or invalid normality"
                effect_size = _epsilon_squared_kruskal(kruskal_h, n_total, k_groups)
                effect_metric = "epsilon_sq"

            if method == "Kruskal-Wallis" and shape_warning:
                logger.warning(
                    "[KRUSKAL SHAPE WARNING] %s | variance_ratio=%.3f (>=4) may violate similar-shape assumption",
                    lipid,
                    variance_ratio,
                )

            if p_val is None or np.isnan(p_val):
                p_val = 1.0
                method = f"{method} Error"

            if len(full_json_data) < 10:
                logger.info(
                    "[ANOVA DEBUG] %s | method=%s | p=%.3e | levene_p=%s | all_normal=%s | zero_var_groups=%s",
                    lipid,
                    method,
                    p_val,
                    f"{levene_p:.3e}" if np.isfinite(levene_p) else "NA",
                    all_groups_normal,
                    ",".join(zero_var_groups) if zero_var_groups else "none",
                )

            box_data = {g: data_groups[i].tolist() for i, g in enumerate(valid_group_names)}

            lipid_res = {
                "lipid": lipid,
                "p_value": float(p_val),
                "method": method,
                "effect_size": float(effect_size) if np.isfinite(effect_size) else None,
                "effect_metric": effect_metric,
                "n_groups_used": int(len(valid_group_names)),
                "diagnostics": {
                    "group_n": {str(g): int(len(data_groups[i])) for i, g in enumerate(valid_group_names)},
                    "group_variance": group_vars,
                    "normality_p_by_group": shapiro_by_group,
                    "all_groups_normal": bool(all_groups_normal),
                    "levene_p": float(levene_p) if np.isfinite(levene_p) else None,
                    "equal_variance": bool(equal_var) if np.isfinite(levene_p) else None,
                    "small_n_force_unequal_var": bool(small_n_variance_unstable),
                    "kruskal_h": float(kruskal_h) if np.isfinite(kruskal_h) else None,
                    "kruskal_shape_warning": shape_warning,
                    "variance_ratio_max_min": variance_ratio if np.isfinite(variance_ratio) else None,
                    "zero_variance_groups": zero_var_groups,
                    "decision_path": decision_path,
                    "warning": "Zero variance groups present" if zero_var_groups else None,
                    "note": "Distribution shapes differ -> interpret Kruskal/Dunn with caution" if method == "Kruskal-Wallis" and shape_warning else None,
                },
                "box_data": box_data,
                "posthoc": [],
                "csv_posthoc_cols": {}
            }
            full_json_data.append(lipid_res)

        # --- FDR Correction (Global) ---
        if not full_json_data:
            raise ValueError("None of the features met the sample size requirement (n>=3 in at least 3 groups) for analysis.")

        temp_df = pd.DataFrame([{"p": r["p_value"]} for r in full_json_data])
        _, fdr, _, _ = multipletests(temp_df['p'], method='fdr_bh')
        fdr = np.clip(fdr, 1e-300, 1.0)

        for i, r in enumerate(full_json_data):
            r["fdr"] = float(fdr[i])

        # --- POST-HOC ANALYSIS ---
        logger.info("Running Post-hoc analysis for significant features...")
        count_posthoc = 0

        for r in full_json_data:
            if r["fdr"] >= 0.05 or str(r["method"]).endswith("Error"):
                continue

            group_names = list(r["box_data"].keys())

            lipid_data_for_ph = []
            lipid_groups_for_ph = []
            for g in group_names:
                vals = r["box_data"][g]
                lipid_data_for_ph.extend(vals)
                lipid_groups_for_ph.extend([g] * len(vals))

            ph_input_df = pd.DataFrame({'value': lipid_data_for_ph, 'group': lipid_groups_for_ph})

            ph_matrix = None
            posthoc_method = None
            if r["method"] == "Kruskal-Wallis":
                ph_matrix = sp.posthoc_dunn(ph_input_df, val_col='value', group_col='group', p_adjust='holm')
                posthoc_method = "Dunn-Holm"
            elif r["method"] == "Welch ANOVA":
                if hasattr(sp, "posthoc_gameshowell"):
                    ph_matrix = sp.posthoc_gameshowell(ph_input_df, val_col='value', group_col='group')
                    posthoc_method = "Games-Howell"
                else:
                    ph_matrix = _games_howell_matrix(ph_input_df)
                    if ph_matrix is not None:
                        posthoc_method = "Games-Howell"
                    else:
                        logger.warning(
                            "Games-Howell unavailable/failed; fallback to Dunn-Holm for feature %s",
                            r.get("lipid", "unknown"),
                        )
                        ph_matrix = sp.posthoc_dunn(ph_input_df, val_col='value', group_col='group', p_adjust='holm')
                        posthoc_method = "Dunn-Holm (fallback from Welch)"
            else:
                ph_matrix = sp.posthoc_tukey(ph_input_df, val_col='value', group_col='group')
                posthoc_method = "Tukey"

            if posthoc_method:
                r["posthoc_method"] = posthoc_method

            if ph_matrix is not None:
                count_posthoc += 1
                sig_pairs_str_list = []

                groups_ph = ph_matrix.columns.tolist()
                for i in range(len(groups_ph)):
                    for j in range(i + 1, len(groups_ph)):
                        g1 = groups_ph[i]
                        g2 = groups_ph[j]
                        p_adj = ph_matrix.loc[g1, g2]
                        p_adj_val = float(p_adj)
                        if not np.isfinite(p_adj_val):
                            continue

                        pair_names = sorted([str(g1), str(g2)])
                        col_name = f"p_{pair_names[0]}_vs_{pair_names[1]}"

                        r["csv_posthoc_cols"][col_name] = p_adj_val

                        if p_adj_val < 0.05:
                            stars = "*"
                            if p_adj_val < 0.001: stars = "***"
                            elif p_adj_val < 0.01: stars = "**"

                            r["posthoc"].append({"g1": g1, "g2": g2, "p_adj": p_adj_val, "stars": stars})

                            sig_pairs_str_list.append(f"{g1} vs {g2} ({stars})")

                if sig_pairs_str_list:
                    r["sig_pairs_string"] = ", ".join(sig_pairs_str_list)
                else:
                    r["sig_pairs_string"] = "NS"
            else:
                r["sig_pairs_string"] = "Error in Posthoc"

        logger.info(f"Post-hoc completed for {count_posthoc} features.")

        # --- TẠO CSV DỮ LIỆU ---
        csv_rows = []
        for r in full_json_data:
            row = {
                "Feature": r["lipid"],
                "Global p-value": r["p_value"],
                "Global FDR": r["fdr"],
                "Method": r["method"],
                "Effect Size": r.get("effect_size", np.nan),
                "Effect Metric": r.get("effect_metric", "NA"),
                "n_groups_used": r.get("n_groups_used", np.nan),
                "Posthoc Method": r.get("posthoc_method", "NA"),
                "Significant Pairs (Post-hoc)": r.get("sig_pairs_string", "NA" if r["fdr"] >= 0.05 else "NS")
            }

            for p1, p2 in all_possible_pairs:
                col_name = f"p_{p1}_vs_{p2}"
                row[col_name] = r["csv_posthoc_cols"].get(col_name, np.nan)

            csv_rows.append(row)

        csv_df = pd.DataFrame(csv_rows)
        csv_df = csv_df.sort_values("Global FDR")

        # --- SAVE & UPLOAD ---
        run_token = int(pd.Timestamp.now().timestamp() * 1000)

        json_dest = f"projects/{uid}/{project_id}/mutilgroup/anova_full_results_{run_token}.json"
        json_url = upload_public(
            uid, project_id, json_dest,
            json.dumps(full_json_data),
            "application/json",
        )

        csv_buf = io.StringIO()
        csv_df.to_csv(csv_buf, index=False)

        csv_dest = f"projects/{uid}/{project_id}/mutilgroup/anova_multi_group_results_{run_token}.csv"
        csv_url = upload_public(uid, project_id, csv_dest, csv_buf.getvalue(), 'text/csv')

        # 3. Update DB
        project_data = get_project_data(project_id)
        history_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": utc_now_iso(),
            "target": target_col,
            "results_url": json_url,
            "csv_url": csv_url,
            "status": "done",
            "message": "Analysis completed successfully.",
        }
        update_project(
            project_id,
            status="anova_success",
            anova_results=json_url,
            anova_csv_url=csv_url,
            anova_history=[history_entry] + [
                item for item in (project_data.get("anova_history") or [])
                if item.get("run_id") != task_run_id
            ],
            anova_task=build_task_payload(
                task_base,
                "done",
                "Analysis completed successfully.",
                started_at=project_data.get("anova_task", {}).get("started_at") or started_at,
                completed_at=utc_now_iso(),
                extra={
                    "results_url": json_url,
                    "csv_url": csv_url,
                },
            )
        )

        logger.info(f"Skipped features due to small n: {len(skipped_lipids)}")
        logger.info(f"===== ANOVA MULTI-GROUP DONE SUCCESSFULLY =====")

    except Exception as e:
        logger.error(f"===== ANOVA MULTI-GROUP ERROR =====")
        logger.error(str(e))
        import traceback
        logger.error(traceback.format_exc())
        project_data = get_project_data(project_id)
        error_entry = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "date": project_data.get("anova_task", {}).get("started_at") or utc_now_iso(),
            "target": target_col,
            "status": "error",
            "message": str(e),
        }
        update_project(
            project_id,
            status="anova_error",
            error_msg=str(e),
            anova_history=[error_entry] + [
                item for item in (project_data.get("anova_history") or [])
                if item.get("run_id") != task_run_id
            ],
            anova_task=build_task_payload(
                {
                    "run_id": task_run_id,
                    "task_id": task_id,
                    "name": analysis_name,
                    "target": target_col,
                    "started_at": project_data.get("anova_task", {}).get("started_at") or utc_now_iso(),
                },
                "error",
                str(e),
                completed_at=utc_now_iso(),
            )
        )
