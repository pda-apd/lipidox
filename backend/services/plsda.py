from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import KFold, StratifiedKFold

from services.common import *

logger = logging.getLogger("PLSDA_PIPELINE")


def _load_from_storage(uid: str, project_id: str, matrix_path: str, meta_path: str) -> Tuple[pd.DataFrame, pd.DataFrame, List[str], List[Dict[str, Any]], List[str]]:
    df_matrix = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    sample_ids = [str(s) for s in df_matrix.columns]
    x_df = df_matrix.T.copy()
    x_df.index = sample_ids

    metadata_columns = [c for c in df_meta.columns if c.lower() != "sample_id" and c != df_meta.index.name]
    metadata = []
    for sid in sample_ids:
        row = {"sample_id": sid}
        if sid in df_meta.index:
            for col in metadata_columns:
                val = df_meta.at[sid, col]
                row[col] = None if pd.isna(val) else py_native(val)
        metadata.append(row)

    return x_df, df_meta, sample_ids, metadata, metadata_columns


def _encode_target(series: pd.Series, target_type: str, order_hint: Optional[List[str]] = None) -> Tuple[np.ndarray, List[str], List[str]]:
    y_raw = series.astype(str)

    if target_type == "categorical":
        encoded_labels = sorted(set(y_raw.tolist()))
        if len(encoded_labels) == 2:
            mapping = {label: idx for idx, label in enumerate(encoded_labels)}
            y_bin = np.array([mapping[v] for v in y_raw.tolist()], dtype=float).reshape(-1, 1)
            return y_bin, encoded_labels, y_raw.tolist()

        dummies = pd.get_dummies(y_raw)
        return dummies.values.astype(float), [str(c) for c in dummies.columns], y_raw.tolist()

    # ordinal
    if order_hint:
        ordered = [str(v) for v in order_hint if str(v) in set(y_raw.tolist())]
        missing = [v for v in y_raw.tolist() if v not in ordered]
        ordered += [v for v in dict.fromkeys(missing)]
    else:
        # Fallback: preserve ordinal nature by sorted values.
        unique_vals = list(set(y_raw.tolist()))
        try:
            ordered = sorted(unique_vals, key=lambda x: float(x))
        except ValueError:
            ordered = sorted(unique_vals)

    mapping = {label: idx for idx, label in enumerate(ordered)}
    y_num = y_raw.map(mapping).values.astype(float).reshape(-1, 1)
    return y_num, ordered, y_raw.tolist()


def _safe_n_components(n_components: int, x: np.ndarray, y: np.ndarray) -> int:
    n_samples, n_features = x.shape
    hard_cap = max(1, min(n_samples - 1, n_features))
    return max(1, min(int(n_components), hard_cap))


def _apply_pareto_scale(x_train: np.ndarray, x_test: Optional[np.ndarray] = None) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    """Tự động tính Pareto Scaling (X - Mean) / sqrt(SD)"""
    x_mean = np.mean(x_train, axis=0)
    x_std = np.std(x_train, axis=0)
    x_std[x_std == 0] = 1.0  # Tránh lỗi chia cho 0
    x_scale = np.sqrt(x_std)
    
    x_train_pareto = (x_train - x_mean) / x_scale
    x_test_pareto = None
    if x_test is not None:
        x_test_pareto = (x_test - x_mean) / x_scale
        
    return x_train_pareto, x_test_pareto

def _r2x(x: np.ndarray, model: PLSRegression) -> float:
    t = model.x_scores_
    p = model.x_loadings_
    x_mean = np.mean(x, axis=0)
    x_hat = np.dot(t, p.T) + x_mean

    ss_res = float(np.sum((x - x_hat) ** 2))
    ss_tot = float(np.sum((x - np.mean(x, axis=0)) ** 2))
    if ss_tot <= 0:
        return 0.0
    return max(0.0, 1.0 - ss_res / ss_tot)


def _r2y(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_mean = np.mean(y_true, axis=0, keepdims=True)
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - y_mean) ** 2))
    if ss_tot <= 0:
        return 0.0
    return float(1.0 - (ss_res / ss_tot))


def _classification_accuracy(y_true: np.ndarray, y_pred: np.ndarray, target_type: str) -> Optional[float]:
    if target_type != "categorical":
        return None
    if y_true.ndim != 2 or y_pred.ndim != 2 or y_true.shape[0] == 0:
        return None

    if y_true.shape[1] == 1 and y_pred.shape[1] == 1:
        y_true_cls = (y_true[:, 0] >= 0.5).astype(int)
        y_pred_cls = (y_pred[:, 0] >= 0.5).astype(int)
    else:
        y_true_cls = np.argmax(y_true, axis=1)
        y_pred_cls = np.argmax(y_pred, axis=1)

    return float(np.mean(y_true_cls == y_pred_cls))


def _build_cv_splitter(y_raw_labels: List[str], y_encoded: np.ndarray, cv_folds: int, target_type: str):
    n_samples = y_encoded.shape[0]
    n_splits = max(2, min(int(cv_folds), n_samples))

    if target_type == "categorical":
        label_counts = pd.Series(y_raw_labels).value_counts()
        min_class_count = int(label_counts.min()) if not label_counts.empty else 0
        if min_class_count >= 2:
            n_splits = max(2, min(n_splits, min_class_count))
            return StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)

    return KFold(n_splits=n_splits, shuffle=True, random_state=42)


def _q2_cv(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_components: int,
    cv_folds: int,
    target_type: str,
) -> Optional[float]:
    n_samples = x.shape[0]
    if n_samples < 3:
        return None

    splitter = _build_cv_splitter(y_raw_labels, y, cv_folds=cv_folds, target_type=target_type)
    if isinstance(splitter, StratifiedKFold):
        folds = splitter.split(x, y_raw_labels)
    else:
        folds = splitter.split(x)

    tss = 0.0
    press = 0.0
    for train_idx, test_idx in folds:
        x_train, x_test = x[train_idx], x[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        y_mean_fold = np.mean(y_train, axis=0, keepdims=True)
        tss += float(np.sum((y_test - y_mean_fold) ** 2))

        x_train_p, x_test_p = _apply_pareto_scale(x_train, x_test)

        n_comp_fold = _safe_n_components(n_components, x_train_p, y_train)
        fold_model = PLSRegression(n_components=n_comp_fold, scale=False)
        fold_model.fit(x_train_p, y_train)
        y_pred = fold_model.predict(x_test_p)
        press += float(np.sum((y_test - y_pred) ** 2))

    if tss <= 0:
        return None
    return float(1.0 - (press / tss))


def _cross_validated_predictions(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_components: int,
    cv_folds: int,
    target_type: str,
) -> np.ndarray:
    y_pred_cv = np.zeros_like(y, dtype=float)
    splitter = _build_cv_splitter(y_raw_labels, y, cv_folds=cv_folds, target_type=target_type)
    if isinstance(splitter, StratifiedKFold):
        folds = splitter.split(x, y_raw_labels)
    else:
        folds = splitter.split(x)

    for train_idx, test_idx in folds:
        x_train, x_test = x[train_idx], x[test_idx]
        y_train = y[train_idx]

        x_train_p, x_test_p = _apply_pareto_scale(x_train, x_test)
        n_comp_fold = _safe_n_components(n_components, x_train_p, y_train)

        fold_model = PLSRegression(n_components=n_comp_fold, scale=False)
        fold_model.fit(x_train_p, y_train)
        y_pred_cv[test_idx] = fold_model.predict(x_test_p)

    return y_pred_cv


def _safe_corr(a: np.ndarray, b: np.ndarray) -> float:
    av = a.reshape(-1).astype(float)
    bv = b.reshape(-1).astype(float)
    if av.size == 0 or bv.size == 0:
        return 0.0
    if np.std(av) <= 0 or np.std(bv) <= 0:
        return 0.0
    corr = np.corrcoef(av, bv)[0, 1]
    if not np.isfinite(corr):
        return 0.0
    return float(corr)


def _permutation_corr(y: np.ndarray, y_perm: np.ndarray, target_type: str) -> float:
    # Correlation should be computed on 1D label codes, not flattened one-hot matrices.
    if target_type == "categorical":
        y_arr = np.asarray(y, dtype=float)
        y_perm_arr = np.asarray(y_perm, dtype=float)
        if y_arr.ndim == 2 and y_arr.shape[1] == 1 and y_perm_arr.ndim == 2 and y_perm_arr.shape[1] == 1:
            y_cls = (y_arr[:, 0] >= 0.5).astype(int)
            y_perm_cls = (y_perm_arr[:, 0] >= 0.5).astype(int)
        else:
            y_cls = np.argmax(y_arr, axis=1)
            y_perm_cls = np.argmax(y_perm_arr, axis=1)
        return _safe_corr(y_cls, y_perm_cls)

    return _safe_corr(np.asarray(y, dtype=float).reshape(-1), np.asarray(y_perm, dtype=float).reshape(-1))


def _calculate_vips(model: PLSRegression) -> np.ndarray:
    t = model.x_scores_
    w = model.x_weights_
    q = model.y_loadings_

    p, h = w.shape
    if p == 0 or h == 0:
        return np.array([], dtype=float)

    s = np.diag(t.T @ t @ q.T @ q).reshape(-1)
    total_s = float(np.sum(s))
    if total_s <= 0 or not np.isfinite(total_s):
        return np.full((p,), np.nan, dtype=float)

    w_norms = np.linalg.norm(w, axis=0)
    vips = np.zeros((p,), dtype=float)
    for i in range(p):
        weight = np.array([
            (w[i, j] / w_norms[j]) ** 2 if w_norms[j] > 0 else 0.0
            for j in range(h)
        ])
        contrib = float(np.dot(s, weight))
        if not np.isfinite(contrib) or contrib < 0:
            vips[i] = np.nan
        else:
            vips[i] = np.sqrt(float(p) * contrib / total_s)

    return vips


def _fit_intercept(x_vals: List[float], y_vals: List[float]) -> Optional[float]:
    if not x_vals or not y_vals or len(x_vals) != len(y_vals):
        return None

    x_arr = np.array(x_vals, dtype=float)
    y_arr = np.array(y_vals, dtype=float)
    if x_arr.size < 2 or np.std(x_arr) <= 0:
        return float(np.mean(y_arr)) if y_arr.size else None

    slope, intercept = np.polyfit(x_arr, y_arr, 1)
    if not np.isfinite(intercept):
        return None
    return float(intercept)


def _permutation_test(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_components: int,
    cv_folds: int,
    target_type: str,
    n_permutations: int,
) -> Dict[str, Any]:
    rng = np.random.default_rng(42)

    y_pred_real_cv = _cross_validated_predictions(
        x=x,
        y=y,
        y_raw_labels=y_raw_labels,
        n_components=n_components,
        cv_folds=cv_folds,
        target_type=target_type,
    )

    q2_real = _q2_cv(x, y, y_raw_labels, n_components=n_components, cv_folds=cv_folds, target_type=target_type)
    r2y_real = _r2y(y, y_pred_real_cv)

    q2_perm_vals: List[float] = []
    r2y_perm_vals: List[float] = []
    corr_vals: List[float] = []

    for _ in range(int(n_permutations)):
        idx = rng.permutation(x.shape[0])
        y_perm = y[idx]
        y_perm_raw = [y_raw_labels[i] for i in idx]

        y_perm_pred_cv = _cross_validated_predictions(
            x=x,
            y=y_perm,
            y_raw_labels=y_perm_raw,
            n_components=n_components,
            cv_folds=cv_folds,
            target_type=target_type,
        )

        q2_perm = _q2_cv(x, y_perm, y_perm_raw, n_components=n_components, cv_folds=cv_folds, target_type=target_type)
        if q2_perm is not None:
            q2_perm_vals.append(float(q2_perm))
            r2y_perm_vals.append(_r2y(y_perm, y_perm_pred_cv))
            corr_vals.append(_permutation_corr(y, y_perm, target_type=target_type))

    if q2_real is None or not q2_perm_vals:
        p_value = None
    else:
        count = int(np.sum(np.array(q2_perm_vals) >= float(q2_real)))
        p_value = float((count + 1) / (len(q2_perm_vals) + 1))

    q2_intercept = _fit_intercept(corr_vals, q2_perm_vals)
    r2y_intercept = _fit_intercept(corr_vals, r2y_perm_vals)
    passed = bool(
        q2_real is not None
        and q2_real > 0
        and p_value is not None
        and p_value < 0.05
        and q2_intercept is not None
        and q2_intercept < 0
        and r2y_intercept is not None
        and r2y_intercept < 0.4
    )

    return {
        "q2_real": None if q2_real is None else float(q2_real),
        "r2y_real": float(r2y_real),
        "q2_permuted": q2_perm_vals,
        "r2y_permuted": r2y_perm_vals,
        "corr": corr_vals,
        "q2_intercept": q2_intercept,
        "r2y_intercept": r2y_intercept,
        "p_value": p_value,
        "pass": passed,
    }


def _cv_anova(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_components: int,
    cv_folds: int,
    target_type: str,
) -> Dict[str, Optional[float]]:
    y_pred = _cross_validated_predictions(
        x=x,
        y=y,
        y_raw_labels=y_raw_labels,
        n_components=n_components,
        cv_folds=cv_folds,
        target_type=target_type,
    )

    y_mean = np.mean(y, axis=0, keepdims=True)
    ss_model = float(np.sum((y_pred - y_mean) ** 2))
    ss_residual = float(np.sum((y - y_pred) ** 2))
    if ss_model <= 0:
        return {"f_stat": None, "p_value": None, "pass": False}

    n_samples, y_cols = y.shape
    y_df = max(1, int(y_cols - 1)) if target_type == "categorical" else 1
    df_model = max(1, int(n_components) * y_df)
    df_residual = max(1, int(n_samples) - df_model - 1)

    if ss_residual <= 0:
        return {"f_stat": float("inf"), "p_value": 0.0}

    ms_model = ss_model / df_model
    ms_residual = ss_residual / df_residual
    if ms_residual <= 0:
        return {"f_stat": float("inf"), "p_value": 0.0}

    f_stat = ms_model / ms_residual
    if not np.isfinite(f_stat):
        return {"f_stat": None, "p_value": None}

    p_value = float(1.0 - stats.f.cdf(f_stat, df_model, df_residual))
    return {"f_stat": float(f_stat), "p_value": p_value, "pass": bool(p_value < 0.05)}


def _prepare_plsda_inputs(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    n_components: int,
    selected_groups: Optional[List[str]] = None,
) -> Tuple[np.ndarray, np.ndarray, List[str], int]:
    x_df, df_meta, sample_ids_all, _, _ = _load_from_storage(uid, project_id, matrix_path, meta_path)

    if target_meta not in df_meta.columns:
        raise ValueError(f"target_meta '{target_meta}' not found in metadata")

    if selected_groups and len(selected_groups) >= 2:
        allowed = set(str(g) for g in selected_groups)
        sample_ids_all = [
            sid for sid in sample_ids_all
            if sid in df_meta.index and str(df_meta.at[sid, target_meta]) in allowed
        ]

    y_series_all = df_meta.reindex(sample_ids_all)[target_meta]
    valid_mask = ~y_series_all.isna()
    if int(valid_mask.sum()) < 3:
        raise ValueError("Not enough samples with non-null target values for PLS-DA checking")

    kept_ids = [sid for sid, keep in zip(sample_ids_all, valid_mask.tolist()) if keep]
    x_df = x_df.loc[kept_ids]
    y_series = y_series_all.loc[kept_ids]

    x = x_df.values.astype(float)
    # Impute NaN with column mean
    if np.isnan(x).any():
        col_means = np.nanmean(x, axis=0)
        nan_mask = np.isnan(x)
        x[nan_mask] = np.take(col_means, np.where(nan_mask)[1])
        x = np.nan_to_num(x, nan=0.0)  # Handle all-NaN columns
    y_encoded, _, original_labels = _encode_target(y_series, "categorical", None)
    n_comp = _safe_n_components(n_components, x, y_encoded)
    return x, y_encoded, original_labels, n_comp


def run_plsda_from_paths(
    matrix_path: str,
    meta_path: str,
    uid: str,
    project_id: str,
    target_meta: str,
    n_components: int = 2,
    cv_folds: int = 5,
    normalize_config: Optional[Dict[str, Any]] = None,
    selected_groups: Optional[List[str]] = None,
    s_plot_corr: str = "spearman",
    s_plot_scale: str = "pareto",
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START PLS-DA =====")
    x_df, df_meta, sample_ids_all, metadata_all, metadata_columns = _load_from_storage(uid, project_id, matrix_path, meta_path)

    if target_meta not in df_meta.columns:
        raise ValueError(f"target_meta '{target_meta}' not found in metadata")

    # Filter to selected_groups if provided
    if selected_groups and len(selected_groups) >= 2:
        allowed = set(str(g) for g in selected_groups)
        sample_ids_all = [
            sid for sid in sample_ids_all
            if sid in df_meta.index and str(df_meta.at[sid, target_meta]) in allowed
        ]

    y_series_all = df_meta.reindex(sample_ids_all)[target_meta]
    valid_mask = ~y_series_all.isna()
    if int(valid_mask.sum()) < 3:
        raise ValueError("Not enough samples with non-null target values for PLS-DA")

    kept_ids = [sid for sid, keep in zip(sample_ids_all, valid_mask.tolist()) if keep]
    x_df = x_df.loc[kept_ids]
    y_series = y_series_all.loc[kept_ids]

    metadata_by_id = {str(m.get("sample_id")): m for m in metadata_all}
    metadata = [metadata_by_id.get(sid, {"sample_id": sid}) for sid in kept_ids]

    x = x_df.values.astype(float)
    # Impute NaN with column mean
    if np.isnan(x).any():
        col_means = np.nanmean(x, axis=0)
        nan_mask = np.isnan(x)
        x[nan_mask] = np.take(col_means, np.where(nan_mask)[1])
        x = np.nan_to_num(x, nan=0.0)  # Handle all-NaN columns
    feature_names = [str(c) for c in x_df.columns]
    # Encode G1 (selected_groups[0]) = 1, G2 = 0 so that t[1] > 0 ↔ G1
    if selected_groups and len(selected_groups) == 2:
        g1_str, g2_str = str(selected_groups[0]), str(selected_groups[1])
        y_series_str = y_series.astype(str)
        enc_mapping = {g2_str: 0, g1_str: 1}
        y_encoded = np.array([enc_mapping.get(v, 0) for v in y_series_str], dtype=float).reshape(-1, 1)
        encoded_labels = [g2_str, g1_str]
        original_labels = y_series_str.tolist()
    else:
        y_encoded, encoded_labels, original_labels = _encode_target(y_series, "categorical", None)

    cv_folds = max(2, int(cv_folds))

    n_comp = _safe_n_components(n_components, x, y_encoded)

    x_pareto, _ = _apply_pareto_scale(x)
    model = PLSRegression(n_components=n_comp, scale=False)
    model.fit(x_pareto, y_encoded)
    y_pred = model.predict(x_pareto)
    vip_scores = _calculate_vips(model)

    vip_payload = [
        {
            "feature": feature_names[i],
            "vip": None if i >= len(vip_scores) or not np.isfinite(vip_scores[i]) else float(vip_scores[i]),
        }
        for i in range(len(feature_names))
    ]
    vip_top = sorted(
        vip_payload,
        key=lambda d: (d["vip"] is None, -(d["vip"] if d["vip"] is not None else -np.inf)),
    )[:50]

    predictive_scores = np.asarray(model.x_scores_[:, 0], dtype=float)
    scores = np.asarray(model.x_scores_, dtype=float).copy()

    # Ensure t[1] > 0 corresponds to G1 (encoded as 1); flip if the model chose the opposite sign
    # NOTE: this G1/G2 sign-flip and logFC logic only applies to the binary (2-group) case
    # where y_encoded is shape (n_samples, 1). For multi-class (one-hot y_encoded of shape
    # (n_samples, n_groups)), raveling would produce a mask of length n_samples*n_groups and
    # break boolean indexing.
    is_binary = y_encoded.shape[1] == 1
    mask_g1 = None
    mask_g2 = None
    if is_binary:
        y_1d = y_encoded.ravel()
        mask_g1 = y_1d > 0.5
        mask_g2 = ~mask_g1
        if mask_g1.any() and mask_g2.any():
            if np.mean(predictive_scores[mask_g1]) < np.mean(predictive_scores[mask_g2]):
                predictive_scores = -predictive_scores
                if scores.shape[1] > 0:
                    scores[:, 0] = -scores[:, 0]

    # logFC = mean(G1) - mean(G2) per feature on raw (un-scaled) data (binary only)
    logfc_arr = np.full(len(feature_names), np.nan)
    if is_binary and mask_g1 is not None and mask_g2 is not None:
        if mask_g1.any() and mask_g2.any():
            logfc_arr = np.mean(x[mask_g1], axis=0) - np.mean(x[mask_g2], axis=0)

    s_plot_data = []
    x_splot = splot_scaled_x(x, s_plot_scale)
    for i, feature in enumerate(feature_names):
        col = np.asarray(x_splot[:, i], dtype=float)

        p_val = None
        corr_val = None
        if col.size > 1 and np.std(col) > 0 and np.std(predictive_scores) > 0:
            # Covariance (x-axis): positive = feature is higher in G1
            cov = float(np.cov(col, predictive_scores)[0, 1])
            p_val = float(cov) if np.isfinite(cov) else None

            # Correlation (y-axis): positive = feature is higher in G1
            corr = splot_correlation(col, predictive_scores, s_plot_corr)
            corr_val = float(corr) if np.isfinite(corr) else None

        vip_val = None
        if i < len(vip_scores) and np.isfinite(vip_scores[i]):
            vip_val = float(vip_scores[i])

        # Enforce sign consistency with logFC: if logFC > 0 then p (covariance)
        # and p_corr (correlation) must be > 0 (and vice versa). Flip the sign
        # of either when it disagrees with logFC, so the S-plot always aligns
        # with the fold-change direction.
        logfc_i = logfc_arr[i]
        if np.isfinite(logfc_i) and logfc_i != 0.0:
            desired_sign = 1.0 if logfc_i > 0 else -1.0
            if p_val is not None and np.isfinite(p_val) and p_val != 0.0 and np.sign(p_val) != desired_sign:
                p_val = -p_val
            if corr_val is not None and np.isfinite(corr_val) and corr_val != 0.0 and np.sign(corr_val) != desired_sign:
                corr_val = -corr_val

        s_plot_data.append({
            "feature": feature,
            "p": p_val,
            "p_corr": corr_val,
            "vip": vip_val,
            "logFC": float(logfc_arr[i]) if np.isfinite(logfc_arr[i]) else None,
        })

    if scores.shape[1] < 2:
        scores = np.column_stack([scores[:, 0], np.zeros(scores.shape[0])])

    score_vars = np.var(model.x_scores_, axis=0)
    var_total = float(np.sum(score_vars)) if float(np.sum(score_vars)) > 0 else 1.0
    comp1_pct = float((score_vars[0] / var_total) * 100.0) if score_vars.shape[0] >= 1 else 0.0
    comp2_pct = float((score_vars[1] / var_total) * 100.0) if score_vars.shape[0] >= 2 else 0.0
    component_variance_proxy = None
    component_percentages = [float(comp1_pct), float(comp2_pct)]

    r2x = _r2x(x_pareto, model)
    r2y = _r2y(y_encoded, y_pred)
    accuracy = _classification_accuracy(y_encoded, y_pred, target_type="categorical")
    q2 = _q2_cv(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_components=n_comp,
        cv_folds=cv_folds,
        target_type="categorical",
    )

    points = []
    for i, sid in enumerate(kept_ids):
        points.append({
            "sample_id": sid,
            "x": float(scores[i, 0]),
            "y": float(scores[i, 1]),
            "group": str(original_labels[i]),
        })

    return {
        "method": "PLS-DA",
        "n_components": int(n_comp),
        "target_meta": target_meta,
        "selected_groups": selected_groups or [],
        "encoded_labels": encoded_labels,
        "plot_points": points,
        "sample_ids": kept_ids,
        "metadata": metadata,
        "metadata_columns": metadata_columns,
        "feature_names": feature_names,
        "vip_scores": vip_payload,
        "vip_top": vip_top,
        "s_plot_data": s_plot_data,
        "metrics": {
            "r2x": float(r2x),
            "r2y": float(r2y),
            "accuracy": None if accuracy is None else float(accuracy),
            "q2": None if q2 is None else float(q2),
        },
        "component_variance_proxy": component_variance_proxy,
        "component_percentages": component_percentages,
        "axis_labels": {
            "x": "LV1",
            "y": "LV2",
        },
        "normalization": normalize_config or {},
    }


def run_plsda_permutation_checking_from_paths(
    matrix_path: str,
    meta_path: str,
    uid: str,
    project_id: str,
    target_meta: str,
    n_components: int = 2,
    cv_folds: int = 5,
    n_permutations: int = 100,
    selected_groups: Optional[List[str]] = None,
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START PLS-DA PERMUTATION CHECKING =====")

    x, y_encoded, original_labels, n_comp = _prepare_plsda_inputs(
        uid=uid,
        project_id=project_id,
        matrix_path=matrix_path,
        meta_path=meta_path,
        target_meta=target_meta,
        n_components=n_components,
        selected_groups=selected_groups,
    )

    cv_folds = max(2, int(cv_folds))
    n_permutations = min(int(n_permutations), 1000)
    if n_permutations < 10:
        raise ValueError("n_permutations too small (minimum is 10)")

    permutation = _permutation_test(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_components=n_comp,
        cv_folds=cv_folds,
        target_type="categorical",
        n_permutations=n_permutations,
    )

    return {
        "method": "PLS-DA Permutation Checking",
        "target_meta": target_meta,
        "n_components": int(n_comp),
        "cv_folds": int(cv_folds),
        "n_permutations": int(n_permutations),
        "permutation": permutation,
    }


def run_plsda_cvanova_checking_from_paths(
    matrix_path: str,
    meta_path: str,
    uid: str,
    project_id: str,
    target_meta: str,
    n_components: int = 2,
    cv_folds: int = 5,
    selected_groups: Optional[List[str]] = None,
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START PLS-DA CV-ANOVA CHECKING =====")

    x, y_encoded, original_labels, n_comp = _prepare_plsda_inputs(
        uid=uid,
        project_id=project_id,
        matrix_path=matrix_path,
        meta_path=meta_path,
        target_meta=target_meta,
        n_components=n_components,
        selected_groups=selected_groups,
    )

    cv_folds = max(2, int(cv_folds))
    cv_anova = _cv_anova(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_components=n_comp,
        cv_folds=cv_folds,
        target_type="categorical",
    )

    return {
        "method": "PLS-DA CV-ANOVA Checking",
        "target_meta": target_meta,
        "n_components": int(n_comp),
        "cv_folds": int(cv_folds),
        "cv_anova": cv_anova,
    }
