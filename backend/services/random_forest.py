import io
import json
import logging
import time
import warnings
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from plotly import graph_objects as go
from plotly.subplots import make_subplots
from plotly.utils import PlotlyJSONEncoder
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.preprocessing import LabelEncoder

from services.common import *

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TOP_OOB_POINTS = [1, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
MAX_IMPORTANCE_TOP_DEFAULT = 15


@dataclass
class RFPreparedData:
    matrix: pd.DataFrame
    meta: pd.DataFrame
    features: List[str]
    sample_ids: List[str]
    X: np.ndarray
    y_raw: pd.Series
    y_encoded: np.ndarray
    label_encoder: LabelEncoder
    valid_mask: np.ndarray


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _safe_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _safe_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [_safe_json_value(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float):
        return value if np.isfinite(value) else None
    if isinstance(value, (pd.Timestamp, pd.Timedelta)):
        return str(value)
    return value


def _build_task_payload(base_payload: Dict[str, Any], status: str, message: str, *, started_at: Optional[str] = None, completed_at: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    now_iso = _utc_now_iso()
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


def _json_dumps(value: Any) -> str:
    return json.dumps(_safe_json_value(value), ensure_ascii=False, cls=PlotlyJSONEncoder)


def _normalize_text_value(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    if text.lower() in {"nan", "none", "null"}:
        return ""
    return text


def _normalize_max_features(value: Any) -> Any:
    if value is None:
        return "sqrt"
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"", "sqrt"}:
            return "sqrt"
        if text in {"log2", "auto"}:
            return text
        if text in {"all", "none"}:
            return None
        try:
            parsed = float(text)
        except ValueError:
            return "sqrt"
        return int(parsed) if parsed.is_integer() and parsed > 1 else float(parsed)
    if isinstance(value, (int, float, np.integer, np.floating)):
        numeric = float(value)
        return int(numeric) if numeric.is_integer() and numeric > 1 else numeric
    return "sqrt"


def _derive_selected_groups_display(settings: Dict[str, Any]) -> str:
    selected_groups = settings.get("selected_groups") if isinstance(settings.get("selected_groups"), list) else []
    clean_selected = [str(item).strip() for item in selected_groups if str(item).strip()]
    if clean_selected:
        return " | ".join(clean_selected)

    comparison = str(settings.get("comparison") or "").strip()
    if " | " in comparison:
        return comparison
    if "|||" in comparison:
        parsed = [part.strip() for part in comparison.split("|||") if part.strip()]
        return " | ".join(parsed)
    if " vs " in comparison:
        parsed = [part.strip() for part in comparison.split(" vs ") if part.strip()]
        return " | ".join(parsed)
    return ""


def _normalize_n_estimators(value: Any) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        parsed = 500
    return max(1, min(10000, parsed))


def _resolve_analysis_labels(df_meta: pd.DataFrame, target_col: str) -> pd.Series:
    if target_col not in df_meta.columns:
        raise ValueError(f"Target metadata '{target_col}' not found in metadata file.")
    labels = df_meta[target_col].apply(_normalize_text_value)
    labels = labels.replace("", np.nan)
    return labels


def _load_prepared_data(uid: str, project_id: str, matrix_path: str, meta_path: str, target_col: str, allowed_labels: Optional[List[str]] = None) -> RFPreparedData:
    df_matrix = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    common_samples = [sample_id for sample_id in df_matrix.columns if sample_id in df_meta.index]
    if len(common_samples) < 3:
        raise ValueError("At least 3 matched samples are required for Random Forest.")

    df_matrix = df_matrix.loc[:, common_samples].apply(pd.to_numeric, errors="coerce")
    y_raw = _resolve_analysis_labels(df_meta.loc[common_samples], target_col)

    if allowed_labels:
        allowed = {str(item).strip() for item in allowed_labels if str(item).strip()}
        if allowed:
            y_raw = y_raw.where(y_raw.astype(str).isin(allowed), np.nan)

    valid_mask = y_raw.notna()
    df_matrix = df_matrix.loc[:, valid_mask.values]
    y_raw = y_raw.loc[valid_mask]

    if y_raw.nunique(dropna=True) < 2:
        raise ValueError("Random Forest requires at least 2 classes.")

    # Drop features that are entirely missing; the imputer will take care of partial missingness.
    feature_mask = df_matrix.notna().any(axis=1)
    df_matrix = df_matrix.loc[feature_mask]
    if df_matrix.empty:
        raise ValueError("No usable features remain after filtering missing values.")

    features = [str(feature) for feature in df_matrix.index.tolist()]
    sample_ids = [str(sample_id) for sample_id in df_matrix.columns.tolist()]

    imputer = SimpleImputer(strategy="median")
    X = imputer.fit_transform(df_matrix.T.values)

    encoder = LabelEncoder()
    y_encoded = encoder.fit_transform(y_raw.astype(str).values)

    return RFPreparedData(
        matrix=df_matrix,
        meta=df_meta,
        features=features,
        sample_ids=sample_ids,
        X=X,
        y_raw=y_raw,
        y_encoded=y_encoded,
        label_encoder=encoder,
        valid_mask=np.asarray(valid_mask.values, dtype=bool),
    )


def _build_oob_curve(model: RandomForestClassifier, X: np.ndarray, y: np.ndarray, n_estimators: int, project_id: str, task_base: Dict[str, Any], started_at: str, heartbeat_state: Dict[str, float]) -> List[Dict[str, Any]]:
    curve_counts = [count for count in TOP_OOB_POINTS if count <= n_estimators]
    if not curve_counts or curve_counts[-1] != n_estimators:
        curve_counts.append(n_estimators)

    model.set_params(warm_start=True, oob_score=True, bootstrap=True)
    oob_curve = []
    for index, count in enumerate(curve_counts, start=1):
        model.set_params(n_estimators=count)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X, y)
        oob_score = float(getattr(model, "oob_score_", np.nan))
        oob_error = float(1.0 - oob_score) if np.isfinite(oob_score) else None
        # Per-class OOB error from oob_decision_function_
        per_class = {}
        sample_oob_probabilities = []
        oob_df = getattr(model, "oob_decision_function_", None)
        if oob_df is not None:
            oob_mask = oob_df.sum(axis=1) > 0
            if oob_mask.sum() > 0:
                oob_preds = np.argmax(oob_df[oob_mask], axis=1)
                y_oob = y[oob_mask]
                valid_indices = np.where(oob_mask)[0]
                for sample_index in valid_indices:
                    probs = []
                    for value in oob_df[sample_index].tolist():
                        numeric = float(value)
                        probs.append(numeric if np.isfinite(numeric) else None)
                    sample_oob_probabilities.append({
                        "sample_index": int(sample_index),
                        "true_class": int(y[sample_index]),
                        "probs": probs,
                    })
                for ci in range(oob_df.shape[1]):
                    cls_mask = y_oob == ci
                    if cls_mask.sum() > 0:
                        err = float(1.0 - np.mean(oob_preds[cls_mask] == y_oob[cls_mask]))
                        per_class[f"error_class_{ci}"] = err if np.isfinite(err) else None
                        prob = float(np.mean(oob_df[oob_mask][cls_mask, ci]))
                        per_class[f"oob_prob_class_{ci}"] = prob if np.isfinite(prob) else None
                    else:
                        per_class[f"error_class_{ci}"] = None
                        per_class[f"oob_prob_class_{ci}"] = None
        oob_curve.append({
            "n_trees": int(count),
            "oob_error": oob_error,
            "sample_oob_probabilities": sample_oob_probabilities,
            **per_class,
        })
        _maybe_heartbeat(
            project_id,
            task_base,
            started_at,
            heartbeat_state,
            f"Training Random Forest ({count}/{n_estimators} trees for OOB curve).",
            extra={"processed_trees": int(count), "total_trees": int(n_estimators)},
        )
    return oob_curve


def _maybe_heartbeat(project_id: str, task_base: Dict[str, Any], started_at: str, heartbeat_state: Dict[str, float], message: str, extra: Optional[Dict[str, Any]] = None, field_name: str = "rf_task") -> None:
    now = time.monotonic()
    last_heartbeat = heartbeat_state.get("last", 0.0)
    if now - last_heartbeat < 12:
        return
    heartbeat_state["last"] = now
    update_project(project_id, **{field_name: _build_task_payload(task_base, "running", message, started_at=started_at, extra=extra)})


def _compute_confusion_matrix(model: RandomForestClassifier, X: np.ndarray, y: np.ndarray, labels: List[str]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    oob_pred = np.full(shape=(len(y),), fill_value=-1, dtype=int)
    oob_scores = getattr(model, "oob_decision_function_", None)
    if oob_scores is None:
        return np.zeros((len(labels), len(labels))), np.array([], dtype=bool), oob_pred

    valid_mask = np.isfinite(oob_scores).any(axis=1) & (oob_scores.sum(axis=1) > 0)
    if valid_mask.any():
        oob_pred[valid_mask] = np.argmax(oob_scores[valid_mask], axis=1)
    cm = confusion_matrix(y[valid_mask], oob_pred[valid_mask], labels=list(range(len(labels)))) if valid_mask.any() else np.zeros((len(labels), len(labels)))
    return cm, valid_mask, oob_pred


def _build_classification_metrics_table(y_true: np.ndarray, y_pred: np.ndarray, class_labels: List[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if y_true.size == 0 or y_pred.size == 0:
        return rows

    per_precision, per_recall, per_f1, per_support = precision_recall_fscore_support(
        y_true,
        y_pred,
        labels=list(range(len(class_labels))),
        zero_division=0,
    )
    for class_index, class_label in enumerate(class_labels):
        rows.append({
            "label": class_label,
            "precision": float(per_precision[class_index]),
            "recall": float(per_recall[class_index]),
            "f1_score": float(per_f1[class_index]),
            "support": int(per_support[class_index]),
        })

    accuracy = float(np.mean(y_true == y_pred))
    total_support = int(y_true.size)
    rows.append({
        "label": "accuracy",
        "precision": None,
        "recall": None,
        "f1_score": accuracy,
        "support": total_support,
    })

    macro_precision, macro_recall, macro_f1, macro_support = precision_recall_fscore_support(
        y_true,
        y_pred,
        average="macro",
        zero_division=0,
    )
    rows.append({
        "label": "macro avg",
        "precision": float(macro_precision),
        "recall": float(macro_recall),
        "f1_score": float(macro_f1),
        "support": total_support,
    })

    weighted_precision, weighted_recall, weighted_f1, weighted_support = precision_recall_fscore_support(
        y_true,
        y_pred,
        average="weighted",
        zero_division=0,
    )
    rows.append({
        "label": "weighted avg",
        "precision": float(weighted_precision),
        "recall": float(weighted_recall),
        "f1_score": float(weighted_f1),
        "support": total_support,
    })

    return rows


def _build_classification_figure(oob_curve: List[Dict[str, Any]], cm: np.ndarray, class_labels: List[str], oob_valid_count: int, total_count: int, oob_accuracy: Optional[float]) -> go.Figure:
    fig = make_subplots(
        rows=1,
        cols=2,
        subplot_titles=("OOB Error vs Number of Trees", "OOB Confusion Matrix"),
        horizontal_spacing=0.12,
        column_widths=[0.52, 0.48],
    )

    fig.add_trace(
        go.Scatter(
            x=[row["n_trees"] for row in oob_curve],
            y=[row["oob_error"] for row in oob_curve],
            mode="lines+markers",
            line={"color": "#2563eb", "width": 2.5},
            marker={"size": 7, "color": "#2563eb"},
            hovertemplate="Trees=%{x}<br>OOB error=%{y:.4f}<extra></extra>",
            name="OOB error",
            showlegend=False,
        ),
        row=1,
        col=1,
    )

    # Add per-class OOB probability curves (mean OOB probability on each class's own samples).
    for class_index, class_label in enumerate(class_labels):
        key = f"oob_prob_class_{class_index}"
        if not any((row.get(key) is not None) for row in oob_curve):
            continue
        fig.add_trace(
            go.Scatter(
                x=[row["n_trees"] for row in oob_curve],
                y=[row.get(key) for row in oob_curve],
                mode="lines+markers",
                line={"width": 2, "dash": "dot"},
                marker={"size": 6},
                hovertemplate=f"Trees=%{{x}}<br>Class={class_label}<br>Mean OOB p=%{{y:.4f}}<extra></extra>",
                name=f"OOB p({class_label})",
                showlegend=True,
            ),
            row=1,
            col=1,
        )

    # Optional dense traces: per-sample OOB probability curve for each class.
    sample_series: Dict[Tuple[int, int], Dict[str, List[float]]] = {}
    for row in oob_curve:
        n_trees = int(row["n_trees"])
        for sample_item in (row.get("sample_oob_probabilities") or []):
            sample_index = int(sample_item.get("sample_index", -1))
            probs = sample_item.get("probs") or []
            if sample_index < 0:
                continue
            for class_index in range(min(len(class_labels), len(probs))):
                value = probs[class_index]
                if value is None:
                    continue
                key = (sample_index, class_index)
                if key not in sample_series:
                    sample_series[key] = {"x": [], "y": []}
                sample_series[key]["x"].append(n_trees)
                sample_series[key]["y"].append(float(value))

    for (sample_index, class_index), series in sample_series.items():
        if not series["x"]:
            continue
        class_label = class_labels[class_index]
        fig.add_trace(
            go.Scatter(
                x=series["x"],
                y=series["y"],
                mode="lines",
                line={"width": 1},
                opacity=0.2,
                hovertemplate=(
                    f"Sample={sample_index}<br>"
                    f"Class={class_label}<br>"
                    "Trees=%{x}<br>OOB p=%{y:.4f}<extra></extra>"
                ),
                name=f"Sample {sample_index} - {class_label}",
                showlegend=False,
            ),
            row=1,
            col=1,
        )

    fig.add_trace(
        go.Heatmap(
            z=cm,
            x=class_labels,
            y=class_labels,
            colorscale="Blues",
            text=[[int(value) for value in row] for row in cm.tolist()],
            texttemplate="%{text}",
            textfont={"size": 12, "color": "#0f172a"},
            colorbar={"title": "Count"},
            hovertemplate="Predicted=%{x}<br>Actual=%{y}<br>Count=%{z}<extra></extra>",
        ),
        row=1,
        col=2,
    )

    fig.update_xaxes(title_text="Number of trees", row=1, col=1)
    fig.update_yaxes(title_text="OOB error", row=1, col=1, rangemode="tozero")
    fig.update_xaxes(title_text="Predicted class", row=1, col=2)
    fig.update_yaxes(title_text="Actual class", row=1, col=2, autorange="reversed")
    fig.update_layout(
        template="plotly_white",
        height=540,
        margin={"l": 60, "r": 30, "t": 70, "b": 55},
        paper_bgcolor="#ffffff",
        plot_bgcolor="#ffffff",
        title={
            "text": f"OOB accuracy: {oob_accuracy:.3f}" if oob_accuracy is not None else f"OOB matrix ({oob_valid_count}/{total_count} samples with OOB predictions)",
            "x": 0.01,
            "xanchor": "left",
        },
    )
    return fig


def _build_feature_importance_figure(feature_rows: List[Dict[str, Any]]) -> Tuple[go.Figure, Dict[str, int], List[str]]:
    x_key = "base_importance"
    x_label = "Importance"
    hover_label = "Importance"
    plot_title = "Feature importance dot plot"

    top_rows = sorted(feature_rows, key=lambda row: (row.get(x_key) or 0), reverse=True)
    visible_feature_names = [row["feature"] for row in top_rows[:MAX_IMPORTANCE_TOP_DEFAULT]]
    trace_index_by_feature = {}

    fig = go.Figure()
    for index, row in enumerate(top_rows):
        feature_name = row["feature"]
        trace_index_by_feature[feature_name] = index
        fig.add_trace(
            go.Scatter(
                x=[row.get(x_key) or 0.0],
                y=[feature_name],
                mode="markers",
                marker={
                    "size": 11,
                    "color": "#2563eb" if index < MAX_IMPORTANCE_TOP_DEFAULT else "#94a3b8",
                    "line": {"width": 0.75, "color": "#0f172a"},
                },
                visible=True if index < MAX_IMPORTANCE_TOP_DEFAULT else False,
                hovertemplate=(
                    f"Feature=%{{y}}<br>{hover_label}=%{{x:.6f}}"
                    "<extra></extra>"
                ),
                name=feature_name,
                showlegend=False,
            )
        )

    fig.update_layout(
        template="plotly_white",
        height=max(520, 26 * max(10, len(top_rows) // 2)),
        margin={"l": 160, "r": 30, "t": 55, "b": 55},
        paper_bgcolor="#ffffff",
        plot_bgcolor="#ffffff",
        title={"text": plot_title, "x": 0.01, "xanchor": "left"},
    )
    fig.update_xaxes(title_text=x_label, zeroline=True, zerolinecolor="#cbd5e1")
    fig.update_yaxes(title_text="Feature", autorange="reversed")
    return fig, trace_index_by_feature, visible_feature_names


def _build_outlier_figure(sample_rows: List[Dict[str, Any]], top_label_sample_ids: List[str]) -> Tuple[go.Figure, Dict[str, int]]:
    sample_ids = [row["sample_id"] for row in sample_rows]
    trace_index_by_sample = {sample_id: index for index, sample_id in enumerate(sample_ids)}
    labels = [row.get("sample_id") if row.get("sample_id") in top_label_sample_ids else "" for row in sample_rows]

    fig = go.Figure()
    fig.add_trace(
        go.Bar(
            x=sample_ids,
            y=[row.get("outlier_score") or 0.0 for row in sample_rows],
            customdata=sample_ids,
            marker={
                "color": ["#2563eb" if row.get("sample_id") in top_label_sample_ids else "#93c5fd" for row in sample_rows],
            },
            hovertemplate="Sample=%{x}<br>Outlying Measure=%{y:.4f}<extra></extra>",
            name="Outlying Measure",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=sample_ids,
            y=[row.get("outlier_score") or 0.0 for row in sample_rows],
            text=labels,
            customdata=sample_ids,
            mode="text",
            textposition="top center",
            textfont={"size": 10, "color": "#0f172a"},
            hoverinfo="skip",
            showlegend=False,
            name="Labels",
        )
    )

    fig.update_layout(
        template="plotly_white",
        height=max(520, 300 + 18 * len(sample_rows)),
        margin={"l": 70, "r": 20, "t": 55, "b": 120},
        paper_bgcolor="#ffffff",
        plot_bgcolor="#ffffff",
        title={"text": "Outlier detection from RF proximity", "x": 0.01, "xanchor": "left"},
    )
    fig.update_xaxes(title_text="Sample", tickangle=-45)
    fig.update_yaxes(title_text="Outlying Measure", rangemode="tozero")
    return fig, trace_index_by_sample


def _build_html_document(title: str, figure: go.Figure, element_id: str, *, state: Optional[Dict[str, Any]] = None, on_ready_script: str = "") -> str:
    fig_json = _json_dumps(figure.to_plotly_json())
    state_json = _json_dumps(state or {})
    return f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
    <meta charset=\"UTF-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
    <title>{title}</title>
    <script src=\"https://cdn.plot.ly/plotly-2.35.2.min.js\"></script>
    <style>
        html, body {{ margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; font-family: Arial, sans-serif; }}
        body {{ overflow: hidden; }}
        #plot-root {{ width: 100%; height: 100%; min-height: 480px; }}
    </style>
</head>
<body>
    <div id=\"plot-root\"></div>
    <script>
        const figure = {fig_json};
        window.RF_STATE = {state_json};
        const config = {{ responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: [\"lasso2d\", \"select2d\"] }};
        Plotly.newPlot({json.dumps(element_id)}, figure.data, figure.layout, config).then((gd) => {{
            window.RF_GD = gd;
            window.RF_FIGURE = figure;
            {on_ready_script}
        }});
    </script>
</body>
</html>"""


def _compute_proximity_matrix(model: RandomForestClassifier, X: np.ndarray) -> np.ndarray:
    leaf_ids = model.apply(X)
    n_samples, n_trees = leaf_ids.shape
    proximity = np.zeros((n_samples, n_samples), dtype=float)
    for tree_index in range(n_trees):
        leaves = leaf_ids[:, tree_index]
        proximity += (leaves[:, None] == leaves[None, :]).astype(float)
    proximity /= max(1, n_trees)
    return proximity


def _compute_outlier_scores(model: RandomForestClassifier, X: np.ndarray, y_encoded: np.ndarray, class_labels: List[str]) -> List[Dict[str, Any]]:
    proximity = _compute_proximity_matrix(model, X)
    np.fill_diagonal(proximity, 0.0)

    class_matrix = y_encoded[:, None] == y_encoded[None, :]
    np.fill_diagonal(class_matrix, False)

    # Canonical RF outlier raw measure per sample within class:
    raw_scores = np.full(shape=(len(y_encoded),), fill_value=np.nan, dtype=float)
    mean_proximities = np.full(shape=(len(y_encoded),), fill_value=np.nan, dtype=float)

    for index in range(len(y_encoded)):
        mask = np.asarray(class_matrix[index], dtype=bool)
        comparison_count = int(mask.sum())
        if comparison_count <= 0:
            continue

        prox_values = proximity[index, mask]
        mean_prox = float(np.mean(prox_values)) if prox_values.size else np.nan
        raw_value = float(np.sum(np.square(prox_values)) / comparison_count) if prox_values.size else np.nan

        mean_proximities[index] = mean_prox if np.isfinite(mean_prox) else np.nan
        raw_scores[index] = raw_value if np.isfinite(raw_value) else np.nan

    robust_scores = np.full(shape=(len(y_encoded),), fill_value=np.nan, dtype=float)
    unique_classes = np.unique(y_encoded)
    for class_index in unique_classes:
        class_mask = y_encoded == class_index
        class_values = raw_scores[class_mask]
        finite_values = class_values[np.isfinite(class_values)]
        if finite_values.size == 0:
            continue

        median = float(np.median(finite_values))
        mad = float(np.median(np.abs(finite_values - median)))
        robust_scale = max(1.4826 * mad, 1e-12)

        # Lower raw similarity indicates more outlier-like behavior.
        robust_scores[class_mask] = (median - class_values) / robust_scale

    rows = []
    for index in range(len(y_encoded)):
        raw_value = raw_scores[index]
        score_value = robust_scores[index]
        mean_prox = mean_proximities[index]
        rows.append({
            "sample_index": int(index),
            "sample_id": None,
            "class_label": class_labels[int(y_encoded[index])],
            "mean_proximity": float(mean_prox) if np.isfinite(mean_prox) else None,
            "outlying_measure": float(raw_value) if np.isfinite(raw_value) else None,
            "outlier_score": float(score_value) if np.isfinite(score_value) else None,
        })
    return rows


def _build_importance_rows(model: RandomForestClassifier, prepared: RFPreparedData, oob_valid_mask: Optional[np.ndarray] = None) -> List[Dict[str, Any]]:
    logger.info("[Importance] Using RandomForest ")
    rows = []
    sort_order = np.argsort(model.feature_importances_)[::-1]
    for rank, feature_index in enumerate(sort_order, start=1):
        feature_name = prepared.features[int(feature_index)]
        mean_expr = float(prepared.matrix.loc[feature_name].mean(skipna=True)) if feature_name in prepared.matrix.index else None
        importance_value = float(model.feature_importances_[int(feature_index)])
        rows.append({
            "rank": int(rank),
            "feature": feature_name,
            "importance": importance_value,
            "mean_decrease_accuracy": None,
            "std_decrease_accuracy": None,
            "base_importance": importance_value,
            "importance_source": "rf_feature_importances",
            "importances_per_repeat": None,
            "mean_expression": mean_expr,
        })
    return rows


def _build_classification_rows(oob_curve: List[Dict[str, Any]], cm: np.ndarray, class_labels: List[str], oob_valid_count: int, total_count: int, oob_accuracy: Optional[float]) -> Dict[str, Any]:
    oob_probability_curve_by_class = {}
    for class_index, class_label in enumerate(class_labels):
        key = f"oob_prob_class_{class_index}"
        series = []
        for row in oob_curve:
            value = row.get(key)
            if value is None:
                continue
            series.append({"n_trees": int(row["n_trees"]), "oob_probability": float(value)})
        if series:
            oob_probability_curve_by_class[class_label] = series

    # Detailed OOB probability curves for each sample and each class.
    oob_probability_curve_by_sample = {}
    for row in oob_curve:
        n_trees = int(row["n_trees"])
        for item in (row.get("sample_oob_probabilities") or []):
            sample_index = int(item.get("sample_index", -1))
            if sample_index < 0:
                continue
            sample_key = str(sample_index)
            holder = oob_probability_curve_by_sample.setdefault(sample_key, {
                "sample_index": sample_index,
                "true_class": class_labels[int(item.get("true_class", 0))] if class_labels else None,
                "curves": {label: [] for label in class_labels},
            })
            probs = item.get("probs") or []
            for class_index, class_label in enumerate(class_labels):
                if class_index >= len(probs):
                    continue
                value = probs[class_index]
                if value is None:
                    continue
                holder["curves"][class_label].append({"n_trees": n_trees, "oob_probability": float(value)})

    return {
        "oob_curve": oob_curve,
        "oob_probability_curve_by_class": oob_probability_curve_by_class,
        "oob_probability_curve_by_sample": list(oob_probability_curve_by_sample.values()),
        "confusion_matrix": cm.tolist(),
        "class_labels": class_labels,
        "oob_valid_count": int(oob_valid_count),
        "total_count": int(total_count),
        "oob_accuracy": float(oob_accuracy) if oob_accuracy is not None else None,
    }


def run_random_forest_analysis(project_id, uid, matrix_path, meta_path, settings, run_id=None, task_id=None):
    task_run_id = run_id or f"rf_{int(time.time() * 1000)}"
    analysis_name = settings.get("analysis_name") or f"Random Forest {task_run_id}"
    target_col = settings.get("target_meta") or settings.get("target")
    comparison = settings.get("comparison")
    display_target = settings.get("displayTarget") or target_col
    selected_groups_display = _derive_selected_groups_display(settings)
    try:
        logger.info(f"===== START RANDOM FOREST ANALYSIS: {project_id} =====")
        started_at = _utc_now_iso()
        task_base = {
            "run_id": task_run_id,
            "task_id": task_id,
            "name": analysis_name,
            "model_type": "rf",
            "target": target_col,
            "displayTarget": display_target,
            "comparison": comparison,
            "selected_groups_display": selected_groups_display,
            "started_at": started_at,
        }
        update_project(
            project_id,
            rf_task=_build_task_payload(task_base, "running", "Running Random Forest analysis.", started_at=started_at)
        )
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
                "model_type": "rf",
                "status": "running",
                "message": "Running Random Forest analysis.",
            }] + [
                item for item in (project_data.get("rf_history") or [])
                if item.get("run_id") != task_run_id
            ]
        )

        bucket_path_prefix = f"projects/{uid}/{project_id}/random_forest/{task_run_id}"

        if not meta_path:
            raise ValueError("Missing metadata path.")
        if not matrix_path:
            raise ValueError("Missing matrix path.")
        if not target_col:
            raise ValueError("Missing target metadata.")

        selected_groups = settings.get("selected_groups") if isinstance(settings.get("selected_groups"), list) else None
        prepared = _load_prepared_data(uid, project_id, matrix_path, meta_path, target_col, selected_groups)
        X = prepared.X
        y = prepared.y_encoded
        class_labels = [str(label) for label in prepared.label_encoder.classes_.tolist()]
        class_encoding = {str(label): int(index) for index, label in enumerate(prepared.label_encoder.classes_.tolist())}

        n_estimators = _normalize_n_estimators(settings.get("ntree") or settings.get("n_estimators") or 500)
        max_features = _normalize_max_features(settings.get("max_features", "sqrt"))
        model = RandomForestClassifier(
            n_estimators=1,
            max_features=max_features,
            bootstrap=True,
            oob_score=True,
            random_state=42,
            n_jobs=-1,
            warm_start=True,
        )
        heartbeat_state = {"last": 0.0}
        oob_curve = _build_oob_curve(model, X, y, n_estimators, project_id, task_base, started_at, heartbeat_state)
        final_model = model

        cm, oob_valid_mask, oob_pred = _compute_confusion_matrix(final_model, X, y, class_labels)
        oob_accuracy = float(final_model.oob_score_) if hasattr(final_model, "oob_score_") and np.isfinite(final_model.oob_score_) else None
        classification_rows = _build_classification_rows(oob_curve, cm, class_labels, int(oob_valid_mask.sum()), len(y), oob_accuracy)
        if oob_valid_mask.any():
            report_rows = _build_classification_metrics_table(y[oob_valid_mask], oob_pred[oob_valid_mask], class_labels)
        else:
            report_rows = []
        classification_rows["classification_report"] = report_rows

        importance_rows = _build_importance_rows(final_model, prepared, oob_valid_mask)
        importance_eval_samples = int(len(y))
        importance_eval_source = "rf_feature_importances"
        visible_feature_names = [row["feature"] for row in importance_rows[:MAX_IMPORTANCE_TOP_DEFAULT]]
        trace_index_by_feature = {row["feature"]: idx for idx, row in enumerate(importance_rows)}

        outlier_rows_raw = _compute_outlier_scores(final_model, X, y, class_labels)
        sample_ids = prepared.sample_ids
        outlier_rows = []
        for index, row in enumerate(outlier_rows_raw):
            outlier_rows.append({
                "sample_index": int(index),
                "sample_id": sample_ids[index],
                "class_label": row["class_label"],
                "mean_proximity": row["mean_proximity"],
                "outlying_measure": row["outlying_measure"],
                "outlier_score": row["outlier_score"],
            })
        top_label_sample_ids = [row["sample_id"] for row in sorted(outlier_rows, key=lambda item: item["outlier_score"], reverse=True)[:5]]
        trace_index_by_sample = {row["sample_id"]: idx for idx, row in enumerate(outlier_rows)}

        run_token = int(time.time() * 1000)
        results_json_path = f"{bucket_path_prefix}/{run_token}.json"

        payload = {
            "analysis_name": analysis_name,
            "model_type": "rf",
            "run_id": task_run_id,
            "task_id": task_id,
            "target": target_col,
            "mode": settings.get("mode") or "manual",
            "comparison": settings.get("comparison"),
            "n_estimators": n_estimators,
            "max_features": max_features if max_features is not None else "all",
            "class_labels": class_labels,
            "class_encoding": class_encoding,
            "sample_ids": sample_ids,
            "feature_names": prepared.features,
            "classification": classification_rows,
            "feature_importance": {
                "table": importance_rows,
                "trace_index_by_feature": trace_index_by_feature,
                "visible_feature_names": visible_feature_names,
                "eval_samples": importance_eval_samples,
                "eval_source": importance_eval_source,
            },
            "outlier_detection": {
                "table": outlier_rows,
                "trace_index_by_sample": trace_index_by_sample,
                "top_label_sample_ids": top_label_sample_ids,
            },
        }

        results_url = upload_public(uid, project_id, results_json_path, _json_dumps(payload), "application/json")
        update_project(
            project_id,
            rf_results_url=results_url,
            rf_task=_build_task_payload(task_base, "done", "Random Forest analysis completed.", started_at=started_at, completed_at=_utc_now_iso(), extra={
                "results_url": results_url,
                "n_estimators": n_estimators,
                "max_features": max_features if max_features is not None else "all",
            }),
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
                "model_type": "rf",
                "status": "done",
                "message": "Random Forest analysis completed.",
                "results_url": results_url,
                "n_estimators": n_estimators,
                "max_features": max_features if max_features is not None else "all",
            }] + existing_history
        )
        logger.info(f"Random Forest analysis completed")
    except Exception as exc:
        logger.exception("Random Forest analysis failed")
        failed_at = _utc_now_iso()
        update_project(
            project_id,
            rf_task=_build_task_payload(task_base if 'task_base' in locals() else {"run_id": task_run_id, "task_id": task_id, "name": analysis_name, "target": target_col, "started_at": failed_at}, "error", f"Random Forest analysis failed: {exc}", started_at=failed_at, completed_at=failed_at),
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
                "model_type": "rf",
                "status": "error",
                "message": str(exc),
            }] + existing_history
        )
        raise
