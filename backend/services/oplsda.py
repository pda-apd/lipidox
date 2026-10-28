from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from pyopls import OPLS
from scipy import stats
from sklearn.cross_decomposition import PLSRegression
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import KFold, StratifiedKFold

from services.common import *

logger = logging.getLogger("OPLSDA_PIPELINE")


def _py_native(val):
    if isinstance(val, np.integer):
        return int(val)
    if isinstance(val, np.floating):
        return float(val)
    if isinstance(val, np.bool_):
        return bool(val)
    return val


def _as_1d_float(y: np.ndarray) -> np.ndarray:
    """Normalize target/prediction arrays to a 1-D float vector."""
    return np.asarray(y, dtype=float).ravel()


def _load_from_storage(
    uid: str, project_id: str, matrix_path: str, meta_path: str
) -> Tuple[pd.DataFrame, pd.DataFrame, List[str], List[Dict[str, Any]], List[str]]:
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
                row[col] = None if pd.isna(val) else _py_native(val)
        metadata.append(row)

    return x_df, df_meta, sample_ids, metadata, metadata_columns


def _encode_target(series: pd.Series, target_type: str, order_hint: Optional[List[str]] = None) -> Tuple[np.ndarray, List[str], List[str]]:
    """Encode target to a 1-D numeric array (required by pyopls.OPLS)."""
    y_raw = series.astype(str)

    if target_type == "categorical":
        encoded_labels = sorted(set(y_raw.tolist()))
        mapping = {label: i for i, label in enumerate(encoded_labels)}
        y_num = np.array([mapping[v] for v in y_raw.tolist()], dtype=float)
        return y_num, encoded_labels, y_raw.tolist()

    if target_type == "ordinal" and not order_hint:
        raise ValueError("ordinal_order is required when target_type='ordinal' to avoid ambiguous label encoding")

    if order_hint:
        ordered = [str(v) for v in order_hint if str(v) in set(y_raw.tolist())]
        missing = [v for v in y_raw.tolist() if v not in set(ordered)]
        ordered += [v for v in dict.fromkeys(missing)]
    else:
        ordered = list(dict.fromkeys(y_raw.tolist()))

    mapping = {label: idx for idx, label in enumerate(ordered)}
    y_num = np.array([mapping[v] for v in y_raw.tolist()], dtype=float)
    return y_num, ordered, y_raw.tolist()


def _classification_metrics(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    encoded_labels: List[str],
    target_type: str,
) -> Dict[str, Any]:
    """Compute classification metrics for 1-D encoded targets and continuous predictions."""
    if target_type != "categorical":
        return {
            "roc_auc_macro": None,
            "roc_auc_per_class": {},
            "balanced_accuracy": None,
            "auc_mode": None,
        }

    n_classes = len(encoded_labels)
    y_true_int = np.asarray(y_true, dtype=int).ravel()
    y_score = np.asarray(y_pred, dtype=float).ravel()
    y_pred_cls = np.clip(np.round(y_score).astype(int), 0, n_classes - 1)

    bal_acc: Optional[float]
    try:
        bal_acc = float(balanced_accuracy_score(y_true_int, y_pred_cls))
    except Exception:
        bal_acc = None

    roc_auc_macro: Optional[float] = None
    auc_mode: Optional[str] = None
    auc_per_class: Dict[str, float] = {}

    if n_classes == 2:
        try:
            if np.unique(y_true_int).size >= 2:
                roc_auc_macro = float(roc_auc_score(y_true_int, y_score))
                auc_mode = "binary_raw_score"
        except Exception:
            pass

    return {
        "roc_auc_macro": roc_auc_macro,
        "roc_auc_per_class": auc_per_class,
        "balanced_accuracy": bal_acc,
        "auc_mode": auc_mode,
    }


def _build_model_warnings(q2: Optional[float], permutation_p: Optional[float], roc_auc_macro: Optional[float]) -> List[str]:
    warnings: List[str] = []

    if q2 is not None:
        if q2 < 0:
            warnings.append("Severe warning: model has no predictive ability (Q2 < 0)")
        elif q2 < 0.3:
            warnings.append("Model has low predictive ability (Q2 < 0.3)")

    if permutation_p is not None and permutation_p >= 0.05:
        warnings.append("Model not statistically significant (permutation test failed)")

    if permutation_p is not None and permutation_p < 0.05 and q2 is not None and q2 < 0.3:
        warnings.append("Model statistically significant but weak predictive power")

    if roc_auc_macro is not None and roc_auc_macro > 0.8 and (q2 is None or q2 < 0.3):
        warnings.append("Potential overfitting: high AUC but low Q2")

    if roc_auc_macro is not None and roc_auc_macro < 0.6 and q2 is not None and q2 > 0.5:
        warnings.append("Model predicts Y well but classification separation is weak")

    return warnings


def _augment_model_warnings(
    warnings: List[str],
    *,
    r2y: Optional[float],
    q2: Optional[float],
    target_type: str,
    encoded_labels: List[str],
    original_labels: List[str],
) -> List[str]:
    merged = list(warnings)

    if r2y is not None and q2 is not None and (r2y - q2) > 0.3:
        merged.append("Potential overfitting: R2Y - Q2 > 0.3")

    if target_type == "categorical" and len(encoded_labels) > 2:
        merged.append("OPLS-DA is primarily binary; multiclass results should be interpreted cautiously or run One-vs-Rest")

    if target_type == "categorical":
        counts = pd.Series(original_labels).value_counts()
        if not counts.empty:
            min_ratio = float(counts.min() / counts.sum())
            if min_ratio < 0.2:
                merged.append("Class imbalance detected (min class ratio < 0.2); consider balancing or class-weighted validation")

    return merged


def _build_cv_splitter(y_raw_labels: List[str], y_encoded: np.ndarray, cv_folds: int, target_type: str):
    n_samples = y_encoded.shape[0]
    n_splits = max(2, min(int(cv_folds), n_samples))

    if target_type == "categorical":
        label_counts = pd.Series(y_raw_labels).value_counts()
        min_class_count = int(label_counts.min()) if not label_counts.empty else 0
        if min_class_count >= 3:
            n_splits = max(2, min(n_splits, min_class_count))
            return StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)

    return KFold(n_splits=n_splits, shuffle=True, random_state=42)


class _OPLSWrapper:
    """OPLS-DA model using pyopls.OPLS (orthogonal filter) + sklearn PLSRegression (predictive)."""

    def __init__(self, n_components: int = 1, scale: bool = True):
        self.n_components = max(0, int(n_components))
        self.scale = scale
        self.opls_: Optional[OPLS] = None
        self.pls_: Optional[PLSRegression] = None
        self.r2x_: float = 0.0
        self.n_orthogonal_fitted_: int = 0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "_OPLSWrapper":
        X = np.asarray(X, dtype=float)
        y = _as_1d_float(y)

        if self.n_components > 0:
            self.opls_ = OPLS(n_components=self.n_components, scale=self.scale)
            self.opls_.fit(X, y)
            Z = self.opls_.transform(X)
            self.n_orthogonal_fitted_ = self.n_components
            pls_scale = False  # Z is already centred/scaled by OPLS
        else:
            self.opls_ = None
            Z = X
            self.n_orthogonal_fitted_ = 0
            pls_scale = self.scale

        self.pls_ = PLSRegression(n_components=1, scale=pls_scale)
        self.pls_.fit(Z, y)

        # Follow pyopls definition directly: OPLS.score(X) = variance ratio
        # var(X_transformed) / var(X_original). Lower means more orthogonal
        # variance removed.
        if self.opls_ is not None:
            try:
                r2x_lib = float(self.opls_.score(X))
                # Keep metric in interpretable range in case of numerical drift.
                self.r2x_ = float(np.clip(r2x_lib, 0.0, 1.0)) if np.isfinite(r2x_lib) else 0.0
            except Exception:
                self.r2x_ = 0.0
        else:
            self.r2x_ = 0.0

        return self

    def _filter(self, X: np.ndarray) -> np.ndarray:
        """Return X with orthogonal variation removed (scaled space)."""
        if self.opls_ is not None:
            return self.opls_.transform(X)
        return np.asarray(X, dtype=float)

    def transform(self, X: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Return (t_predictive [n,1], t_orthogonal [n, n_orth]) score matrices."""
        X = np.asarray(X, dtype=float)
        Z = self._filter(X)
        t_p = self.pls_.transform(Z)  # shape [n, 1]

        if self.opls_ is None:
            return t_p, np.zeros((X.shape[0], 1), dtype=float)

        # Compute orthogonal scores iteratively for any X (mirrors OPLS.transform
        # but captures each t_orth before deflation).
        Xc = X.copy()
        Xc -= self.opls_.x_mean_
        if self.opls_.scale:
            Xc /= self.opls_.x_std_

        t_orth_list: List[np.ndarray] = []
        for i in range(self.n_components):
            t_o = Xc @ self.opls_.W_ortho_[:, i]
            t_orth_list.append(t_o)
            Xc -= np.outer(t_o, self.opls_.P_ortho_[:, i])

        t_orth = np.column_stack(t_orth_list)
        return t_p, t_orth

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Return 1-D continuous predictions."""
        Z = self._filter(np.asarray(X, dtype=float))
        return self.pls_.predict(Z).ravel()


def _r2y(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_true = _as_1d_float(y_true)
    y_pred = _as_1d_float(y_pred)
    if y_true.shape[0] != y_pred.shape[0] or y_true.shape[0] == 0:
        return 0.0

    y_mean = np.mean(y_true, axis=0, keepdims=True)
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - y_mean) ** 2))
    if ss_tot <= 0:
        return 0.0
    return float(1.0 - (ss_res / ss_tot))


def _cross_validated_predictions(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_orthogonal: int,
    cv_folds: int,
    target_type: str,
) -> np.ndarray:
    y = _as_1d_float(y)
    y_pred_cv = np.zeros(y.shape[0], dtype=float)
    splitter = _build_cv_splitter(y_raw_labels, y, cv_folds=cv_folds, target_type=target_type)
    y_labels = np.array(y_raw_labels, dtype=str)
    folds = splitter.split(x, y_labels) if isinstance(splitter, StratifiedKFold) else splitter.split(x)

    for train_idx, test_idx in folds:
        model = _OPLSWrapper(n_components=n_orthogonal)
        model.fit(x[train_idx], y[train_idx])
        fold_pred = np.asarray(model.predict(x[test_idx]), dtype=float)
        y_pred_cv[test_idx] = fold_pred.ravel()

    return y_pred_cv


def _q2_cv(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_orthogonal: int,
    cv_folds: int,
    target_type: str,
) -> Optional[float]:
    y = _as_1d_float(y)
    n_samples = x.shape[0]
    if n_samples < 3:
        return None

    splitter = _build_cv_splitter(y_raw_labels, y, cv_folds=cv_folds, target_type=target_type)
    y_labels = np.array(y_raw_labels, dtype=str)
    folds = splitter.split(x, y_labels) if isinstance(splitter, StratifiedKFold) else splitter.split(x)

    tss = 0.0
    press = 0.0
    for train_idx, test_idx in folds:
        x_train, x_test = x[train_idx], x[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]

        y_mean_fold = float(np.mean(y_train))
        tss += float(np.sum((y_test - y_mean_fold) ** 2))

        fold_model = _OPLSWrapper(n_components=n_orthogonal)
        fold_model.fit(x_train, y_train)
        y_pred = fold_model.predict(x_test)
        press += float(np.sum((y_test - y_pred) ** 2))

    if tss <= 0:
        return None
    return float(1.0 - (press / tss))


def _permutation_test(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_orthogonal: int,
    cv_folds: int,
    target_type: str,
    n_permutations: int,
) -> Dict[str, Any]:
    rng = np.random.default_rng(42)

    model_real = _OPLSWrapper(n_components=n_orthogonal)
    model_real.fit(x, y)
    y_pred_real_full = model_real.predict(x)

    y_pred_real_cv = _cross_validated_predictions(
        x=x,
        y=y,
        y_raw_labels=y_raw_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type=target_type,
    )
    q2_real = _q2_cv(
        x=x,
        y=y,
        y_raw_labels=y_raw_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type=target_type,
    )
    r2y_real = _r2y(y, y_pred_real_full)

    q2_perm_vals: List[float] = []
    r2y_perm_vals: List[float] = []

    for _ in range(int(n_permutations)):
        idx = rng.permutation(x.shape[0])
        y_perm = y[idx]
        y_perm_raw = [y_raw_labels[i] for i in idx]

        model_perm = _OPLSWrapper(n_components=n_orthogonal)
        model_perm.fit(x, y_perm)
        y_perm_pred_full = model_perm.predict(x)

        # y_perm_pred_cv = _cross_validated_predictions(
        #     x=x,
        #     y=y_perm,
        #     y_raw_labels=y_perm_raw,
        #     n_orthogonal=n_orthogonal,
        #     cv_folds=cv_folds,
        #     target_type=target_type,
        # )
        q2_perm = _q2_cv(
            x=x,
            y=y_perm,
            y_raw_labels=y_perm_raw,
            n_orthogonal=n_orthogonal,
            cv_folds=cv_folds,
            target_type=target_type,
        )

        if q2_perm is not None:
            q2_perm_vals.append(float(q2_perm))
            r2y_perm_vals.append(_r2y(y_perm, y_perm_pred_full))

    if not q2_perm_vals:
        return {
            "q2_real": None if q2_real is None else float(q2_real),
            "r2y_real": float(r2y_real),
            "q2_permuted": q2_perm_vals,
            "r2y_permuted": r2y_perm_vals,
            "q2_perm_mean": None,
            "p_value": None,
            "pass": None,
            "note": "Permutation test not computable (all Q2_perm invalid)",
        }

    if q2_real is None:
        p_value = None
    else:
        count = int(np.sum(np.array(q2_perm_vals) > float(q2_real)))
        p_value = float((count + 1) / (len(q2_perm_vals) + 1))

    q2_perm_mean = float(np.mean(q2_perm_vals)) if q2_perm_vals else None
    passed = bool(
        q2_real is not None
        and q2_real > 0
        and p_value is not None
        and p_value < 0.05
        and q2_perm_mean is not None
        and q2_real > q2_perm_mean
    )

    return {
        "q2_real": None if q2_real is None else float(q2_real),
        "r2y_real": float(r2y_real),
        "q2_permuted": q2_perm_vals,
        "r2y_permuted": r2y_perm_vals,
        "q2_perm_mean": q2_perm_mean,
        "p_value": p_value,
        "pass": passed,
    }


def _cv_anova(
    x: np.ndarray,
    y: np.ndarray,
    y_raw_labels: List[str],
    n_orthogonal: int,
    cv_folds: int,
    target_type: str,
) -> Dict[str, Optional[float]]:
    y_pred = _cross_validated_predictions(
        x=x,
        y=y,
        y_raw_labels=y_raw_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type=target_type,
    )

    y_mean = np.mean(y, axis=0, keepdims=True)
    press = float(np.sum((y - y_pred) ** 2))
    tss = float(np.sum((y - y_mean) ** 2))
    explained = tss - press
    if explained <= 0:
        return {"f_stat": None, "p_value": None, "pass": False}

    n_samples = y.shape[0]
    df_model = 1
    df_residual = max(1, int(n_samples) - df_model - 1)

    if press <= 0:
        return {"f_stat": float("inf"), "p_value": 0.0, "pass": True}

    ms_model = explained / df_model
    ms_residual = press / df_residual
    if ms_residual <= 0:
        return {"f_stat": float("inf"), "p_value": 0.0, "pass": True}

    f_stat = ms_model / ms_residual
    if not np.isfinite(f_stat):
        return {"f_stat": None, "p_value": None, "pass": False}

    p_value = float(1.0 - stats.f.cdf(f_stat, df_model, df_residual))
    return {"f_stat": float(f_stat), "p_value": p_value, "pass": bool(p_value < 0.05)}


def _prepare_oplsda_inputs(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    selected_groups: Optional[List[str]] = None,
) -> Tuple[np.ndarray, np.ndarray, List[str], List[str], List[Dict[str, Any]], List[str], List[str]]:
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
        raise ValueError("Not enough samples with non-null target values for OPLS-DA")

    kept_ids = [sid for sid, keep in zip(sample_ids_all, valid_mask.tolist()) if keep]
    x_df = x_df.loc[kept_ids]
    feature_names = [str(c) for c in x_df.columns]
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
    y_encoded, encoded_labels, original_labels = _encode_target(y_series, "categorical")
    return x, y_encoded, original_labels, encoded_labels, metadata, metadata_columns, feature_names


def _compute_vip_scores(model: _OPLSWrapper, n_features: int) -> np.ndarray:
    """VIP from PLS x-weights (1 predictive component)."""
    if model.pls_ is None:
        return np.full(n_features, np.nan, dtype=float)

    w = np.asarray(model.pls_.x_weights_[:, 0], dtype=float)
    if w.size != n_features:
        return np.full(n_features, np.nan, dtype=float)

    denom = float(np.sum(w ** 2))
    if denom <= 0:
        return np.full(n_features, np.nan, dtype=float)

    vip = np.sqrt(float(n_features) * (w ** 2) / denom)
    return vip.astype(float)


def run_oplsda_from_paths(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    n_predictive: int = 1,
    n_orthogonal: int = 0,
    cv_folds: int = 5,
    normalize_config: Optional[Dict[str, Any]] = None,
    selected_groups: Optional[List[str]] = None,
    s_plot_corr: str = "spearman",
    s_plot_scale: str = "pareto",
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START OPLS-DA =====")

    x, y_encoded, original_labels, encoded_labels, metadata, metadata_columns, feature_names = _prepare_oplsda_inputs(
        uid=uid,
        project_id=project_id,
        matrix_path=matrix_path,
        meta_path=meta_path,
        target_meta=target_meta,
        selected_groups=selected_groups,
    )

    # Re-encode: G1 (selected_groups[0]) = 1, G2 = 0 regardless of alphabetical order
    if selected_groups and len(selected_groups) == 2:
        g1_str, g2_str = str(selected_groups[0]), str(selected_groups[1])
        enc_mapping = {g2_str: 0, g1_str: 1}
        y_encoded = np.array([enc_mapping.get(v, 0) for v in original_labels], dtype=float)
        encoded_labels = [g2_str, g1_str]

    y_encoded = _as_1d_float(y_encoded)

    n_predictive = 1 if int(n_predictive) != 1 else int(n_predictive)
    n_orthogonal = max(0, min(3, int(n_orthogonal)))
    cv_folds = max(2, int(cv_folds))

    model = _OPLSWrapper(n_components=n_orthogonal)
    model.fit(x, y_encoded)
    y_pred = model.predict(x)
    y_pred_cv = _cross_validated_predictions(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type="categorical",
    )
    t_p, t_o = model.transform(x)

    q2 = _q2_cv(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type="categorical",
    )
    r2y = _r2y(y_encoded, y_pred)
    cls_metrics = _classification_metrics(
        y_true=y_encoded.astype(int).ravel(),
        y_pred=y_pred_cv,
        encoded_labels=encoded_labels,
        target_type="categorical",
    )
    warnings_base = _build_model_warnings(
        q2=q2,
        permutation_p=None,
        roc_auc_macro=cls_metrics.get("roc_auc_macro"),
    )
    warnings = _augment_model_warnings(
        warnings_base,
        r2y=float(r2y),
        q2=None if q2 is None else float(q2),
        target_type="categorical",
        encoded_labels=encoded_labels,
        original_labels=original_labels,
    )
    vip_scores = _compute_vip_scores(model, n_features=x.shape[1])
    vip = [
        {
            "feature": feature_names[i],
            "vip": None if not np.isfinite(vip_scores[i]) else float(vip_scores[i]),
        }
        for i in range(len(feature_names))
    ]
    vip_sorted = sorted(
        vip,
        key=lambda d: (d["vip"] is None, -(d["vip"] if d["vip"] is not None else -np.inf)),
    )

    t_predictive = np.asarray(t_p[:, 0], dtype=float)
    # Scale X for the S-plot covariance axis. The matrix is already the
    # normalize-step output; if normalize already scaled it, choose "none"
    # here to avoid double-scaling.
    x_splot = splot_scaled_x(x, s_plot_scale)

    # Ensure t_p > 0 corresponds to G1 (encoded as 1); flip if needed
    y_1d = y_encoded.ravel()
    mask_g1 = y_1d > 0.5
    mask_g2 = ~mask_g1
    if mask_g1.any() and mask_g2.any():
        if np.mean(t_predictive[mask_g1]) < np.mean(t_predictive[mask_g2]):
            t_predictive = -t_predictive

    # logFC = mean(G1) - mean(G2) per feature on raw data
    logfc_arr = np.full(len(feature_names), np.nan)
    if mask_g1.any() and mask_g2.any():
        logfc_arr = np.mean(x[mask_g1], axis=0) - np.mean(x[mask_g2], axis=0)

    s_plot_data = []
    for i, feature in enumerate(feature_names):
        col = np.asarray(x_splot[:, i], dtype=float)
        cov_val = None
        corr_val = None
        if col.size > 1 and np.std(col) > 0 and np.std(t_predictive) > 0:
            # Covariance (x-axis): positive = feature is higher in G1
            cov = float(np.cov(col, t_predictive)[0, 1])
            cov_val = float(cov) if np.isfinite(cov) else None
            # Correlation (y-axis): positive = feature is higher in G1
            corr = splot_correlation(col, t_predictive, s_plot_corr)
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
            if cov_val is not None and np.isfinite(cov_val) and cov_val != 0.0 and np.sign(cov_val) != desired_sign:
                cov_val = -cov_val
            if corr_val is not None and np.isfinite(corr_val) and corr_val != 0.0 and np.sign(corr_val) != desired_sign:
                corr_val = -corr_val

        s_plot_data.append({
            "feature": feature,
            "p": cov_val,
            "p_corr": corr_val,
            "vip": vip_val,
            "logFC": float(logfc_arr[i]) if np.isfinite(logfc_arr[i]) else None,
        })

    points = []
    for i, sid in enumerate([m.get("sample_id") for m in metadata]):
        points.append({
            "sample_id": str(sid),
            "x": float(t_predictive[i]),
            "y": float(t_o[i, 0]) if t_o.shape[1] > 0 else 0.0,
            "group": str(original_labels[i]),
        })

    return {
        "method": "OPLS-DA",
        "n_predictive": 1,
        "n_orthogonal": int(model.n_orthogonal_fitted_),
        "target_meta": target_meta,
        "selected_groups": selected_groups or [],
        "encoded_labels": encoded_labels,
        "plot_points": points,
        "sample_ids": [str(m.get("sample_id")) for m in metadata],
        "metadata": metadata,
        "metadata_columns": metadata_columns,
        "feature_names": feature_names,
        "vip_scores": vip,
        "vip_top": vip_sorted[:50],
        "s_plot_data": s_plot_data,
        "metrics": {
            "r2x": float(model.r2x_),
            "r2y": float(r2y),
            "q2": None if q2 is None else float(q2),
            "accuracy": None,
            "roc_auc_macro": None if cls_metrics.get("roc_auc_macro") is None else float(cls_metrics["roc_auc_macro"]),
            "roc_auc_per_class": cls_metrics.get("roc_auc_per_class", {}),
            "balanced_accuracy": None if cls_metrics.get("balanced_accuracy") is None else float(cls_metrics["balanced_accuracy"]),
            "auc_mode": cls_metrics.get("auc_mode"),
        },
        "warnings": warnings,
        "axis_labels": {
            "x": "t_p[1]",
            "y": "t_o[1]",
        },
        "normalization": normalize_config or {},
    }


def run_oplsda_permutation_checking_from_paths(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    n_predictive: int = 1,
    n_orthogonal: int = 0,
    cv_folds: int = 5,
    n_permutations: int = 100,
    selected_groups: Optional[List[str]] = None,
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START OPLS-DA PERMUTATION CHECKING =====")

    x, y_encoded, original_labels, _, _, _, _ = _prepare_oplsda_inputs(
        uid=uid,
        project_id=project_id,
        matrix_path=matrix_path,
        meta_path=meta_path,
        target_meta=target_meta,
        selected_groups=selected_groups,
    )

    _ = 1 if int(n_predictive) != 1 else 1
    n_orthogonal = max(0, min(3, int(n_orthogonal)))
    cv_folds = max(2, int(cv_folds))
    n_permutations = min(int(n_permutations), 1000)
    if n_permutations < 10:
        raise ValueError("n_permutations too small (minimum is 10)")

    permutation = _permutation_test(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type="categorical",
        n_permutations=n_permutations,
    )

    return {
        "method": "OPLS-DA Permutation Checking",
        "target_meta": target_meta,
        "n_predictive": 1,
        "n_orthogonal": int(n_orthogonal),
        "cv_folds": int(cv_folds),
        "n_permutations": int(n_permutations),
        "permutation": permutation,
    }


def run_oplsda_cvanova_checking_from_paths(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    n_predictive: int = 1,
    n_orthogonal: int = 0,
    cv_folds: int = 5,
    selected_groups: Optional[List[str]] = None,
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START OPLS-DA CV-ANOVA CHECKING =====")

    x, y_encoded, original_labels, _, _, _, _ = _prepare_oplsda_inputs(
        uid=uid,
        project_id=project_id,
        matrix_path=matrix_path,
        meta_path=meta_path,
        target_meta=target_meta,
        selected_groups=selected_groups,
    )

    _ = 1 if int(n_predictive) != 1 else 1
    n_orthogonal = max(0, min(3, int(n_orthogonal)))
    cv_folds = max(2, int(cv_folds))
    cv_anova = _cv_anova(
        x=x,
        y=y_encoded,
        y_raw_labels=original_labels,
        n_orthogonal=n_orthogonal,
        cv_folds=cv_folds,
        target_type="categorical",
    )

    return {
        "method": "OPLS-DA CV-ANOVA Checking",
        "target_meta": target_meta,
        "n_predictive": 1,
        "n_orthogonal": int(n_orthogonal),
        "cv_folds": int(cv_folds),
        "cv_anova": cv_anova,
    }
