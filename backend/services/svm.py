import io
import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support, roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.svm import SVC

from services.common import *
from services.random_forest import _build_task_payload, _derive_selected_groups_display, _utc_now_iso

logger = logging.getLogger(__name__)


def _normalize_text_value(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    if text.lower() in {"nan", "none", "null"}:
        return ""
    return text


def _safe_float(value: Any, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        out = default
    return out


def _safe_int(value: Any, default: int) -> int:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        out = default
    return out


def _load_data(uid: str, project_id: str, matrix_path: str, meta_path: str, target_col: str, allowed_labels: Optional[List[str]] = None):
    df_matrix = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    common_samples = [sample_id for sample_id in df_matrix.columns if sample_id in df_meta.index]
    if len(common_samples) < 3:
        raise ValueError("At least 3 matched samples are required for SVM.")

    df_matrix = df_matrix.loc[:, common_samples].apply(pd.to_numeric, errors="coerce")
    if target_col not in df_meta.columns:
        raise ValueError(f"Target metadata '{target_col}' not found in metadata file.")

    y_raw = df_meta.loc[common_samples, target_col].apply(_normalize_text_value).replace("", np.nan)

    if allowed_labels:
        allowed = {str(item).strip() for item in allowed_labels if str(item).strip()}
        if allowed:
            y_raw = y_raw.where(y_raw.astype(str).isin(allowed), np.nan)

    valid_mask = y_raw.notna()
    df_matrix = df_matrix.loc[:, valid_mask.values]
    y_raw = y_raw.loc[valid_mask]

    if y_raw.nunique(dropna=True) < 2:
        raise ValueError("SVM requires at least 2 classes.")

    feature_mask = df_matrix.notna().any(axis=1)
    df_matrix = df_matrix.loc[feature_mask]
    if df_matrix.empty:
        raise ValueError("No usable features remain after filtering missing values.")

    features = [str(feature) for feature in df_matrix.index.tolist()]
    sample_ids = [str(sample_id) for sample_id in df_matrix.columns.tolist()]

    imputer = SimpleImputer(strategy="median")
    X_imputed = imputer.fit_transform(df_matrix.T.values)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_imputed)

    encoder = LabelEncoder()
    y_encoded = encoder.fit_transform(y_raw.astype(str).values)

    return {
        "matrix": df_matrix,
        "meta": df_meta,
        "features": features,
        "sample_ids": sample_ids,
        "X_imputed": X_imputed,
        "X_scaled": X_scaled,
        "y_encoded": y_encoded,
        "y_raw": y_raw,
        "label_encoder": encoder,
        "imputer": imputer,
        "scaler": scaler,
    }


def _compute_ci_bootstrap(y_true_bin: np.ndarray, y_score: np.ndarray, n_bootstrap: int, ci_level: float, random_state: int):
    rng = np.random.RandomState(random_state)
    auc_values = []
    n = y_true_bin.shape[0]
    for _ in range(max(1, n_bootstrap)):
        idx = rng.randint(0, n, n)
        y_b = y_true_bin[idx]
        s_b = y_score[idx]
        if np.unique(y_b).shape[0] < 2:
            continue
        try:
            auc_values.append(float(roc_auc_score(y_b, s_b)))
        except Exception:
            continue

    if not auc_values:
        return None, None

    alpha = 1.0 - float(ci_level)
    low = float(np.quantile(auc_values, alpha / 2))
    high = float(np.quantile(auc_values, 1 - alpha / 2))
    return low, high


def _optimal_cutoff(fpr: np.ndarray, tpr: np.ndarray, thresholds: np.ndarray, method: str):
    if method == "closest_topleft":
        dist = np.sqrt(np.square(fpr) + np.square(1 - tpr))
        idx = int(np.argmin(dist))
    else:
        youden = tpr - fpr
        idx = int(np.argmax(youden))
    return idx


def _classification_report_rows(y_true: np.ndarray, y_pred: np.ndarray, class_labels: List[str]):
    rows: List[Dict[str, Any]] = []
    p, r, f1, s = precision_recall_fscore_support(y_true, y_pred, labels=list(range(len(class_labels))), zero_division=0)
    for i, label in enumerate(class_labels):
        rows.append({
            "label": label,
            "precision": float(p[i]),
            "recall": float(r[i]),
            "f1_score": float(f1[i]),
            "support": int(s[i]),
        })

    total_support = int(y_true.size)
    accuracy = float(np.mean(y_true == y_pred)) if total_support else None
    rows.append({"label": "accuracy", "precision": None, "recall": None, "f1_score": accuracy, "support": total_support})

    mp, mr, mf1, _ = precision_recall_fscore_support(y_true, y_pred, average="macro", zero_division=0)
    rows.append({"label": "macro avg", "precision": float(mp), "recall": float(mr), "f1_score": float(mf1), "support": total_support})

    wp, wr, wf1, _ = precision_recall_fscore_support(y_true, y_pred, average="weighted", zero_division=0)
    rows.append({"label": "weighted avg", "precision": float(wp), "recall": float(wr), "f1_score": float(wf1), "support": total_support})

    return rows


def run_svm_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    task_run_id = run_id or f"svm_{int(time.time() * 1000)}"
    analysis_name = settings.get("analysis_name") or f"SVM {task_run_id}"
    target_col = settings.get("target_meta") or settings.get("target")
    comparison = settings.get("comparison")
    display_target = settings.get("displayTarget") or target_col
    selected_groups_display = _derive_selected_groups_display(settings)

    kernel = str(settings.get("kernel") or "rbf").strip().lower()
    if kernel not in {"rbf", "linear"}:
        kernel = "rbf"
    C = max(0.01, min(1000.0, _safe_float(settings.get("C"), 1.0)))
    cv_folds = _safe_int(settings.get("cv_folds"), 5)
    if cv_folds not in {3, 5, 10}:
        cv_folds = 5
    class_weight_raw = str(settings.get("class_weight") or "balanced").strip().lower()
    class_weight = None if class_weight_raw == "none" else "balanced"
    n_bootstrap = _safe_int(settings.get("n_bootstrap"), 1000)
    if n_bootstrap not in {500, 1000, 2000}:
        n_bootstrap = 1000
    ci_level = _safe_float(settings.get("ci_level"), 0.95)
    if ci_level not in {0.90, 0.95, 0.99}:
        ci_level = 0.95
    cutoff_method = str(settings.get("cutoff_method") or "youden").strip().lower()
    if cutoff_method not in {"youden", "closest_topleft"}:
        cutoff_method = "youden"
    max_importance_top = _safe_int(settings.get("max_importance_top"), 15)
    if max_importance_top not in {10, 15, 25, 50}:
        max_importance_top = 15
    n_repeats_permutation = _safe_int(settings.get("n_repeats_permutation"), 10)
    if n_repeats_permutation not in {5, 10, 20}:
        n_repeats_permutation = 10

    random_state = 42

    try:
        started_at = _utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "target": target_col,
            "displayTarget": display_target,
            "comparison": comparison,
            "selected_groups_display": selected_groups_display,
            "model_type": "svm",
            "started_at": started_at,
        }
        update_project(project_id, rf_task=_build_task_payload(task_base, "running", "Running SVM analysis.", started_at=started_at))
        project_data = get_project_data(project_id)
        update_project(
            project_id,
            rf_history=[{
                "run_id": task_run_id,
                "task_id": task_id,
                "name": analysis_name,
                "date": project_data.get("rf_task", {}).get("started_at") or started_at,
                "target": target_col,
                "displayTarget": display_target,
                "comparison": comparison,
                "selected_groups_display": selected_groups_display,
                "model_type": "svm",
                "status": "running",
                "message": "Running SVM analysis.",
            }] + [item for item in (project_data.get("rf_history") or []) if item.get("run_id") != task_run_id]
        )

        selected_groups = settings.get("selected_groups") if isinstance(settings.get("selected_groups"), list) else None
        prepared = _load_data(uid, project_id, matrix_path, meta_path, target_col, selected_groups)
        X_scaled = prepared["X_scaled"]
        X_imputed = prepared["X_imputed"]
        y = prepared["y_encoded"]
        class_labels = [str(label) for label in prepared["label_encoder"].classes_.tolist()]
        n_classes = len(class_labels)
        class_encoding = {str(label): int(index) for index, label in enumerate(prepared["label_encoder"].classes_.tolist())}
        sample_class_labels = {
            str(prepared["sample_ids"][i]): class_labels[int(y[i])]
            for i in range(len(prepared["sample_ids"]))
        }

        n_samples = X_scaled.shape[0]
        cv_folds = min(cv_folds, max(2, n_samples))
        skf = StratifiedKFold(n_splits=cv_folds, shuffle=True, random_state=random_state)

        decision_shape = "ovo" if len(class_labels) == 2 else "ovr"

        y_pred_cv = np.full_like(y, fill_value=-1)
        prob_cv = np.zeros((n_samples, len(class_labels)), dtype=float)
        fold_acc: List[float] = []
        imp_accumulator = np.zeros(X_scaled.shape[1], dtype=float)
        rbf_perm_folds: List[Tuple[Any, np.ndarray]] = []

        for fold_idx, (train_idx, test_idx) in enumerate(skf.split(X_scaled, y), start=1):
            model = SVC(
                kernel=kernel,
                C=C,
                gamma="scale",
                class_weight=class_weight,
                probability=True,
                decision_function_shape=decision_shape,
                random_state=random_state,
            )
            model.fit(X_scaled[train_idx], y[train_idx])
            pred = model.predict(X_scaled[test_idx])
            prob = model.predict_proba(X_scaled[test_idx])
            y_pred_cv[test_idx] = pred
            prob_cv[test_idx] = prob
            fold_acc.append(float(np.mean(pred == y[test_idx])))

            if kernel == "rbf":
                rbf_perm_folds.append((model, test_idx))

            update_project(
                project_id,
                rf_task=_build_task_payload(
                    task_base,
                    "running",
                    f"Running SVM CV ({fold_idx}/{cv_folds} folds).",
                    started_at=started_at,
                    extra={"processed_folds": int(fold_idx), "total_folds": int(cv_folds)},
                )
            )

        rbf_importance_scoring = None
        if kernel == "rbf":
            # First pass: keep current default scorer. If importance is all zero, retry with neg_log_loss.
            for model, test_idx in rbf_perm_folds:
                p_imp = permutation_importance(
                    model,
                    X_scaled[test_idx],
                    y[test_idx],
                    n_repeats=n_repeats_permutation,
                    random_state=random_state,
                    scoring="f1_macro",
                    n_jobs=-1,
                )
                imp_accumulator += p_imp.importances_mean

            n_perm_folds = max(1, len(rbf_perm_folds))
            f1_imp_avg = imp_accumulator / n_perm_folds
            # Match frontend table precision (6 decimals): values smaller than 5e-7 render as 0.000000.
            all_zero_display_eps = 5e-7
            all_zero_f1_importance = bool(rbf_perm_folds) and bool(np.all(np.abs(f1_imp_avg) < all_zero_display_eps))
            rbf_importance_scoring = "f1_macro"
            if all_zero_f1_importance:
                try:
                    imp_accumulator = np.zeros(X_scaled.shape[1], dtype=float)
                    for model, test_idx in rbf_perm_folds:
                        p_imp = permutation_importance(
                            model,
                            X_scaled[test_idx],
                            y[test_idx],
                            n_repeats=n_repeats_permutation,
                            random_state=random_state,
                            scoring="neg_log_loss",
                            n_jobs=-1,
                        )
                        imp_accumulator += p_imp.importances_mean
                    rbf_importance_scoring = "neg_log_loss"
                except Exception:
                    imp_accumulator = f1_imp_avg * n_perm_folds
                    rbf_importance_scoring = "f1_macro"

        svm_importance_debug = (
            f"[SVM Importance DEBUG] "
            f"n_samples={X_scaled.shape[0]}, "
            f"n_features={X_scaled.shape[1]}, "
            f"cv_folds={cv_folds}, "
            f"perm_scoring={rbf_importance_scoring or 'n/a'}, "
            f"f1_all_zero_detected={bool(kernel == 'rbf' and all_zero_f1_importance)}, "
            f"f1_all_zero_switch={bool(kernel == 'rbf' and rbf_importance_scoring == 'neg_log_loss')}, "
            f"imp_max={float(imp_accumulator.max()):.8f}, "
            f"imp_nonzero={int((imp_accumulator > 1e-9).sum())}, "
            f"fold_acc={[round(a, 4) for a in fold_acc]}"
        )
        logger.info(svm_importance_debug)

        cm = confusion_matrix(y, y_pred_cv, labels=list(range(len(class_labels))))
        report_rows = _classification_report_rows(y, y_pred_cv, class_labels)

        classification = {
            "confusion_matrix": cm.tolist(),
            "classification_report": report_rows,
            "cv_accuracy_folds": [{"fold": int(i + 1), "accuracy": float(acc)} for i, acc in enumerate(fold_acc)],
            "cv_mean_accuracy": float(np.mean(fold_acc)) if fold_acc else None,
            "cv_std_accuracy": float(np.std(fold_acc)) if fold_acc else None,
            "oob_valid_count": int(n_samples),
            "total_count": int(n_samples),
            "oob_accuracy": float(np.mean(y == y_pred_cv)),
        }

        # ROC summary
        roc_curves = []
        for class_idx, class_name in enumerate(class_labels):
            y_bin = (y == class_idx).astype(int)
            score = prob_cv[:, class_idx]
            if np.unique(y_bin).shape[0] < 2:
                continue
            fpr, tpr, thr = roc_curve(y_bin, score)
            auc = float(roc_auc_score(y_bin, score))
            ci_low, ci_high = _compute_ci_bootstrap(y_bin, score, n_bootstrap=n_bootstrap, ci_level=ci_level, random_state=random_state + class_idx)
            cut_idx = _optimal_cutoff(fpr, tpr, thr, cutoff_method)
            roc_curves.append({
                "class_label": class_name,
                "fpr": [float(v) for v in fpr.tolist()],
                "tpr": [float(v) for v in tpr.tolist()],
                "thresholds": [float(v) if np.isfinite(v) else None for v in thr.tolist()],
                "auc": auc,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "optimal_threshold": float(thr[cut_idx]) if np.isfinite(thr[cut_idx]) else None,
                "optimal_fpr": float(fpr[cut_idx]),
                "optimal_tpr": float(tpr[cut_idx]),
            })

        roc_table = [{
            "class_label": row["class_label"],
            "auc": row["auc"],
            "ci_low": row["ci_low"],
            "ci_high": row["ci_high"],
            "optimal_threshold": row["optimal_threshold"],
            "optimal_fpr": row["optimal_fpr"],
            "optimal_tpr": row["optimal_tpr"],
        } for row in roc_curves]

        if kernel == "rbf":
            n_perm_folds = max(1, len(rbf_perm_folds))
            imp = imp_accumulator / n_perm_folds
            source = "svm_rbf_cv_permutation_neg_log_loss" if rbf_importance_scoring == "neg_log_loss" else "svm_rbf_cv_permutation_f1_macro"

        # Refit final model on all data
        final_model = SVC(
            kernel=kernel,
            C=C,
            gamma="scale",
            class_weight=class_weight,
            probability=True,
            decision_function_shape=decision_shape,
            random_state=random_state,
        )
        final_model.fit(X_scaled, y)

        # Importance
        importance_rows = []
        if kernel == "linear":
            coef = getattr(final_model, "coef_", None)
            if coef is None:
                imp = np.zeros(X_scaled.shape[1], dtype=float)
            else:
                coef_arr = np.asarray(coef, dtype=float)
                imp = np.abs(coef_arr) if coef_arr.ndim == 1 else np.mean(np.abs(coef_arr), axis=0)
            source = "svm_linear_coef"
        # For kernel == "rbf", imp/source were computed from CV test folds above.

        sort_idx = np.argsort(imp)[::-1]
        for rank, fidx in enumerate(sort_idx, start=1):
            fname = prepared["features"][int(fidx)]
            importance_rows.append({
                "rank": int(rank),
                "feature": fname,
                "importance": float(imp[int(fidx)]),
                "base_importance": float(imp[int(fidx)]),
                "importance_source": source,
                "mean_expression": float(prepared["matrix"].loc[fname].mean(skipna=True)) if fname in prepared["matrix"].index else None,
            })

        # Decision boundary data for RBF
        decision_boundary = None
        if kernel == "rbf":
            pca = PCA(n_components=2, random_state=random_state)
            pcs = pca.fit_transform(X_scaled)

            x_min, x_max = float(pcs[:, 0].min() - 1.0), float(pcs[:, 0].max() + 1.0)
            y_min, y_max = float(pcs[:, 1].min() - 1.0), float(pcs[:, 1].max() + 1.0)
            xx, yy = np.meshgrid(np.linspace(x_min, x_max, 300), np.linspace(y_min, y_max, 300))
            mesh_pca = np.column_stack([xx.ravel(), yy.ravel()])
            mesh_scaled = pca.inverse_transform(mesh_pca)
            zz = final_model.predict(mesh_scaled).reshape(xx.shape)
            decision_grid = None
            decision_grid_ovr = None
            decision_values = final_model.decision_function(mesh_scaled)
            decision_values_arr = np.asarray(decision_values, dtype=float)
            if n_classes == 2:
                decision_grid = decision_values_arr.reshape(xx.shape)
            elif decision_values_arr.ndim == 2 and decision_values_arr.shape[1] >= n_classes:
                decision_grid_ovr = {
                    class_labels[class_idx]: [[float(v) for v in row] for row in decision_values_arr[:, class_idx].reshape(xx.shape).tolist()]
                    for class_idx in range(n_classes)
                }

            support_idx = set(int(idx) for idx in getattr(final_model, "support_", np.array([], dtype=int)).tolist())
            sample_points = []
            for i in range(pcs.shape[0]):
                sample_points.append({
                    "sample_id": prepared["sample_ids"][i],
                    "pc1": float(pcs[i, 0]),
                    "pc2": float(pcs[i, 1]),
                    "class_label": class_labels[int(y[i])],
                    "is_support_vector": i in support_idx,
                })

            decision_boundary = {
                "grid_x": [float(v) for v in xx[0].tolist()],
                "grid_y": [float(v) for v in yy[:, 0].tolist()],
                "z": [[int(v) for v in row] for row in zz.tolist()],
                "decision_function": (
                    [[float(v) for v in row] for row in decision_grid.tolist()]
                    if decision_grid is not None else None
                ),
                "decision_function_ovr": decision_grid_ovr,
                "sample_points": sample_points,
                "pc1_variance_ratio": float(pca.explained_variance_ratio_[0]),
                "pc2_variance_ratio": float(pca.explained_variance_ratio_[1]),
            }

        payload = {
            "analysis_name": analysis_name,
            "model_type": "svm",
            "run_id": task_run_id,
            "task_id": task_id,
            "target": target_col,
            "mode": settings.get("mode") or "manual",
            "comparison": comparison,
            "class_labels": class_labels,
            "class_encoding": class_encoding,
            "sample_class_labels": sample_class_labels,
            "sample_ids": prepared["sample_ids"],
            "feature_names": prepared["features"],
            "kernel": kernel,
            "C": C,
            "cv_folds": cv_folds,
            "class_weight": class_weight_raw,
            "n_bootstrap": n_bootstrap,
            "ci_level": ci_level,
            "cutoff_method": cutoff_method,
            "max_importance_top": max_importance_top,
            "n_repeats_permutation": n_repeats_permutation,
            "classification": classification,
            "roc": {"curves": roc_curves, "table": roc_table},
            "feature_importance": {
                "table": importance_rows,
                "visible_feature_names": [row["feature"] for row in importance_rows[:15]],
                "eval_samples": int(n_samples),
                "eval_source": source,
            },
            "server_logs": [
                svm_importance_debug,
            ],
            "decision_boundary": decision_boundary,
            # keep key for current frontend compatibility paths
            "outlier_detection": {
                "table": [{
                    "sample_id": row["class_label"],
                    "class_label": row["class_label"],
                    "outlier_score": row["auc"],
                    "outlying_measure": row["optimal_tpr"],
                } for row in roc_table],
                "top_label_sample_ids": [],
            },
        }

        run_token = int(time.time() * 1000)
        results_path = f"projects/{uid}/{project_id}/random_forest/{task_run_id}/{run_token}.json"
        results_url = upload_public(uid, project_id, results_path, json.dumps(payload, ensure_ascii=False), "application/json")

        update_project(
            project_id,
            rf_results_url=results_url,
            rf_task=_build_task_payload(
                task_base,
                "done",
                "SVM analysis completed.",
                started_at=started_at,
                completed_at=_utc_now_iso(),
                extra={"results_url": results_url, "kernel": kernel, "C": C, "model_type": "svm"},
            ),
        )

        project_data = get_project_data(project_id)
        existing_history = [item for item in (project_data.get("rf_history") or []) if item.get("run_id") != task_run_id]
        update_project(
            project_id,
            rf_history=[{
                "run_id": task_run_id,
                "task_id": task_id,
                "name": analysis_name,
                "date": _utc_now_iso(),
                "target": target_col,
                "displayTarget": display_target,
                "comparison": comparison,
                "selected_groups_display": selected_groups_display,
                "model_type": "svm",
                "status": "done",
                "message": "SVM analysis completed.",
                "results_url": results_url,
                "kernel": kernel,
                "C": C,
            }] + existing_history
        )

        logger.info(f"SVM analysis completed")
    except Exception as exc:
        logger.exception("SVM analysis failed")
        failed_at = _utc_now_iso()
        update_project(
            project_id,
            rf_task=_build_task_payload(
                {
                    "run_id": task_run_id,
                    "task_id": task_id,
                    "name": analysis_name,
                    "target": target_col,
                    "model_type": "svm",
                    "started_at": failed_at,
                },
                "error",
                f"SVM analysis failed: {exc}",
                started_at=failed_at,
                completed_at=failed_at,
            )
        )
        project_data = get_project_data(project_id)
        existing_history = [item for item in (project_data.get("rf_history") or []) if item.get("run_id") != task_run_id]
        update_project(
            project_id,
            rf_history=[{
                "run_id": task_run_id,
                "task_id": task_id,
                "name": analysis_name,
                "date": failed_at,
                "target": target_col,
                "displayTarget": display_target,
                "comparison": comparison,
                "selected_groups_display": selected_groups_display,
                "model_type": "svm",
                "status": "error",
                "message": str(exc),
            }] + existing_history
        )
        raise
