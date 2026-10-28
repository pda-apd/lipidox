import io
import logging
import time
from typing import Any, Dict, List

import numpy as np
import pandas as pd
import plotly.figure_factory as ff
import plotly.graph_objects as go
import plotly.io as pio
from plotly.colors import qualitative
from plotly.subplots import make_subplots
from scipy.spatial.distance import pdist

from services.common import *

logger = logging.getLogger("HEATMAP_HCA")


def _to_bool(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _as_list(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    return [str(v) for v in values]


def _normalize_numeric(df: pd.DataFrame) -> pd.DataFrame:
    out = df.apply(pd.to_numeric, errors="coerce")
    out = out.replace([np.inf, -np.inf], np.nan)
    return out


def _autoscale_features(df: pd.DataFrame) -> pd.DataFrame:
    mean = df.mean(axis=1)
    std = df.std(axis=1).replace(0, np.nan)
    return df.sub(mean, axis=0).div(std, axis=0).fillna(0.0)


def _autoscale_samples(df: pd.DataFrame) -> pd.DataFrame:
    mean = df.mean(axis=0)
    std = df.std(axis=0).replace(0, np.nan)
    return df.sub(mean, axis=1).div(std, axis=1).fillna(0.0)


def _build_blank_figure(title: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=title, x=0.5, y=0.5, xref="paper", yref="paper", showarrow=False, font={"size": 16, "color": "#556"})
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    fig.update_layout(template="plotly_white", margin={"l": 40, "r": 20, "t": 50, "b": 40}, paper_bgcolor="#fff", plot_bgcolor="#fff")
    return fig


def _upload_html(content: str, uid: str, project_id: str, mode: str) -> str:
    ts = int(time.time() * 1000)
    path = f"projects/{uid}/{project_id}/heatmap_hca/{mode}_{ts}.html"
    return upload_public(uid, project_id, path, content, "text/html")


def _metric_name(distance: str) -> str:
    mapping = {
        "euclidean": "euclidean",
        "pearson": "correlation",
        "minkowski": "minkowski",
    }
    return mapping.get(str(distance or "euclidean").strip().lower(), "euclidean")


def _distfun(metric: str):
    def _inner(values: np.ndarray) -> np.ndarray:
        arr = np.where(np.isnan(values), np.nanmean(values, axis=0, keepdims=True), values)
        if metric == "correlation":
            stds = arr.std(axis=1, keepdims=True)
            zero_mask = (stds == 0).flatten()
            if zero_mask.any():
                rng = np.random.default_rng(0)
                noise = rng.normal(0, 1e-9, arr[zero_mask].shape)
                arr = arr.copy()
                arr[zero_mask] += noise
        if metric == "minkowski":
            dist = pdist(arr, metric="minkowski", p=3)
        else:
            dist = pdist(arr, metric=metric)
        if not np.all(np.isfinite(dist)):
            dist = pdist(arr, metric="euclidean")
        return dist

    return _inner


def _linear_tickvals(size: int) -> List[float]:
    return [5.0 + (idx * 10.0) for idx in range(size)]


def _discrete_colorscale(labels: List[str], domain: List[str] = None, color_map_input: Dict[str, str] = None) -> Dict[str, Any]:
    unique_labels = [str(v) for v in (domain or []) if str(v)]
    if not unique_labels:
        unique_labels = list(dict.fromkeys(labels))

    for label in labels:
        if label not in unique_labels:
            unique_labels.append(label)

    palette = qualitative.Set2 + qualitative.Safe + qualitative.Plotly
    color_map = {label: palette[idx % len(palette)] for idx, label in enumerate(unique_labels)}
    if color_map_input:
        for label, color in color_map_input.items():
            if label in color_map:
                color_map[label] = color
    if not unique_labels:
        return {"codes": [], "colorscale": [[0, "#1f77b4"], [1, "#1f77b4"]], "color_map": color_map}

    denominator = max(1, len(unique_labels) - 1)
    colorscale: List[List[Any]] = []
    for idx, label in enumerate(unique_labels):
        position = idx / denominator
        color = color_map[label]
        colorscale.append([position, color])
        colorscale.append([position, color])

    return {
        "codes": [unique_labels.index(label) for label in labels],
        "colorscale": colorscale,
        "color_map": color_map,
    }


def _build_interactive_hca_figure(
    data: pd.DataFrame,
    meta_labels: List[str],
    label_domain: List[str],
    color_map_input: Dict[str, str],
    hca_layout: Dict[str, Any],
    meta_col: str,
    show_col_labels: bool,
    show_row_labels: bool,
    distance: str,
    cluster_by: str,
) -> go.Figure:
    metric = _metric_name(distance)
    row_cluster = cluster_by in {"features", "both"} and data.shape[0] > 1
    col_cluster = cluster_by in {"samples", "both"} and data.shape[1] > 1

    row_labels = [str(v) for v in data.index]
    col_labels = [str(v) for v in data.columns]
    row_tickvals = _linear_tickvals(len(row_labels))
    col_tickvals = _linear_tickvals(len(col_labels))

    row_dendro = None
    col_dendro = None

    if row_cluster:
        row_dendro = ff.create_dendrogram(
            data.values,
            orientation="right",
            labels=row_labels,
            distfun=_distfun(metric),
        )
        row_labels = [str(v) for v in row_dendro.layout.yaxis.ticktext]
        row_tickvals = [float(v) for v in row_dendro.layout.yaxis.tickvals]

    if col_cluster:
        col_dendro = ff.create_dendrogram(
            data.T.values,
            orientation="bottom",
            labels=col_labels,
            distfun=_distfun(metric),
        )
        col_labels = [str(v) for v in col_dendro.layout.xaxis.ticktext]
        col_tickvals = [float(v) for v in col_dendro.layout.xaxis.tickvals]

    ordered = data.loc[row_labels, col_labels]
    meta_lookup = {str(sample): str(label) for sample, label in zip(data.columns, meta_labels)}
    ordered_meta_labels = [meta_lookup[str(sample)] for sample in col_labels]
    meta_color_info = _discrete_colorscale(ordered_meta_labels, label_domain, color_map_input)

    def _as_float_list(values: Any, expected: int, fallback: List[float]) -> List[float]:
        if not isinstance(values, list) or len(values) != expected:
            return fallback
        out: List[float] = []
        for v in values:
            try:
                out.append(float(v))
            except Exception:
                return fallback
        return out

    layout_cfg = hca_layout or {}
    default_row_heights = [0.20, 0.70, 0.035]
    default_column_widths = [0.18, 0.82]
    default_margin = {"l": 40, "r": 220, "t": 5, "b": 55}
    row_heights = _as_float_list(layout_cfg.get("row_heights"), 3, default_row_heights)
    column_widths = _as_float_list(layout_cfg.get("column_widths"), 2, default_column_widths)
    margin_cfg = layout_cfg.get("margin") if isinstance(layout_cfg.get("margin"), dict) else {}
    margin = {
        "l": int(margin_cfg.get("l", default_margin["l"])),
        "r": int(margin_cfg.get("r", default_margin["r"])),
        "t": int(margin_cfg.get("t", default_margin["t"])),
        "b": int(margin_cfg.get("b", default_margin["b"])),
    }
    vertical_spacing = float(layout_cfg.get("vertical_spacing", 0))
    horizontal_spacing = float(layout_cfg.get("horizontal_spacing", 0))
    label_font_size = int(layout_cfg.get("label_font_size", 9))

    fig = make_subplots(
        rows=3,
        cols=2,
        row_heights=row_heights,
        column_widths=column_widths,
        specs=[
            [None, {"type": "xy"}],
            [{"type": "xy"}, {"type": "heatmap"}],
            [None, {"type": "heatmap"}],
        ],
        vertical_spacing=vertical_spacing,
        horizontal_spacing=horizontal_spacing,
    )

    if col_dendro is not None:
        for trace in col_dendro.data:
            trace.update(line={"color": "#365b96", "width": 1.4}, hoverinfo="skip", showlegend=False)
            fig.add_trace(trace, row=1, col=2)

    if row_dendro is not None:
        for trace in row_dendro.data:
            trace.update(line={"color": "#365b96", "width": 1.4}, hoverinfo="skip", showlegend=False)
            fig.add_trace(trace, row=2, col=1)

    fig.add_trace(
        go.Heatmap(
            x=col_tickvals,
            y=row_tickvals,
            z=ordered.values,
            colorscale="RdBu_r",
            colorbar={"title": "Expression", "len": 0.65, "x": 1.20, "xanchor": "left"},
            hovertemplate="Feature: %{text}<br>Sample: %{customdata}<br>Value: %{z:.4f}<extra></extra>",
            text=np.array([[row_label for _ in col_labels] for row_label in row_labels]),
            customdata=np.array([[col_label for col_label in col_labels] for _ in row_labels]),
        ),
        row=2,
        col=2,
    )

    fig.add_trace(
        go.Heatmap(
            x=col_tickvals,
            y=[0],
            z=[meta_color_info["codes"]],
            colorscale=meta_color_info["colorscale"],
            showscale=False,
            hovertemplate=f"{meta_col}: %{{text}}<br>Sample: %{{customdata}}<extra></extra>",
            text=[ordered_meta_labels],
            customdata=[col_labels],
        ),
        row=3,
        col=2,
    )

    separator_shapes = []
    for idx in range(1, len(ordered_meta_labels)):
        if ordered_meta_labels[idx] != ordered_meta_labels[idx - 1]:
            midpoint = (col_tickvals[idx - 1] + col_tickvals[idx]) / 2.0
            separator_shapes.append(
                {
                    "type": "line",
                    "xref": "x4",
                    "yref": "y4",
                    "x0": midpoint,
                    "x1": midpoint,
                    "y0": -0.5,
                    "y1": 0.5,
                    "line": {"color": "#ffffff", "width": 2},
                }
            )
            separator_shapes.append(
                {
                    "type": "line",
                    "xref": "x3",
                    "yref": "y3",
                    "x0": midpoint,
                    "x1": midpoint,
                    "y0": min(row_tickvals) - 5 if row_tickvals else -5,
                    "y1": max(row_tickvals) + 5 if row_tickvals else 5,
                    "line": {"color": "#ffffff", "width": 2},
                }
            )

    group_annotations = []
    g_idx = 0
    while g_idx < len(ordered_meta_labels):
        g_label = ordered_meta_labels[g_idx]
        g_end = g_idx
        while g_end < len(ordered_meta_labels) and ordered_meta_labels[g_end] == g_label:
            g_end += 1
        center_x = (col_tickvals[g_idx] + col_tickvals[g_end - 1]) / 2.0
        group_annotations.append(
            dict(
                x=center_x,
                y=0,
                xref="x4",
                yref="y4",
                text=g_label,
                showarrow=False,
                captureevents=True,
                font={"size": label_font_size, "color": "#333333"},
                yshift=-20,
            )
        )
        g_idx = g_end

    fig.update_layout(
        template="plotly_white",
        margin=margin,
        autosize=True,
        showlegend=False,
        shapes=separator_shapes,
        annotations=group_annotations,
    )

    fig.update_xaxes(showticklabels=False, row=1, col=2, matches="x3", fixedrange=False)
    fig.update_yaxes(showticklabels=False, row=1, col=2, fixedrange=True)

    fig.update_xaxes(showticklabels=False, row=2, col=1, fixedrange=True)
    fig.update_yaxes(showticklabels=False, row=2, col=1, matches="y3", fixedrange=False)

    fig.update_xaxes(showticklabels=False, row=2, col=2, fixedrange=False)
    y_tickvals_for_display = row_tickvals
    y_ticktext_for_display = row_labels
    if len(row_labels) > 35:
        step = max(1, int(np.ceil(len(row_labels) / 20)))
        keep_idx = list(range(0, len(row_labels), step))
        if keep_idx[-1] != len(row_labels) - 1:
            keep_idx.append(len(row_labels) - 1)
        y_tickvals_for_display = [row_tickvals[i] for i in keep_idx]
        y_ticktext_for_display = [row_labels[i] for i in keep_idx]

    fig.update_yaxes(
        row=2,
        col=2,
        tickmode="array",
        tickvals=y_tickvals_for_display,
        ticktext=y_ticktext_for_display,
        showticklabels=show_row_labels,
        autorange="reversed",
        side="right",
        fixedrange=False,
        tickfont={"size": label_font_size},
    )

    fig.update_xaxes(
        row=3,
        col=2,
        tickmode="array",
        tickvals=col_tickvals,
        ticktext=col_labels,
        showticklabels=show_col_labels,
        tickangle=-45,
        fixedrange=False,
        matches="x3",
        tickfont={"size": label_font_size},
    )
    fig.update_yaxes(showticklabels=False, row=3, col=2, fixedrange=True)

    return fig


def render_heatmap_html(project_id: str, uid: str, matrix_path: str, meta_path: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    logger.info("[Heatmap/HCA] render start | project=%s", project_id)

    mode = str(settings.get("mode") or "heatmap").strip().lower()
    if mode not in {"heatmap", "hca"}:
        mode = "heatmap"

    view_type = str(settings.get("view_type") or "per_sample").strip().lower()
    if view_type not in {"per_sample", "mean_expression"}:
        view_type = "per_sample"

    show_col_labels = _to_bool(settings.get("show_col_labels"), default=True)
    show_row_labels = _to_bool(settings.get("show_row_labels"), default=True)

    meta_col = str(settings.get("meta_col") or "").strip()
    selected_labels = set(_as_list(settings.get("selected_labels")))
    label_domain = _as_list(settings.get("label_domain"))
    color_map_input = {str(k): str(v) for k, v in (settings.get("color_map") or {}).items()}
    hca_layout = settings.get("hca_layout") if isinstance(settings.get("hca_layout"), dict) else {}
    selected_features = _as_list(settings.get("selected_features"))

    standardization = str(settings.get("standardization") or "none").strip().lower()
    distance = str(settings.get("distance") or "euclidean").strip().lower()
    cluster_by = str(settings.get("cluster_by") or "both").strip().lower()
    if cluster_by not in {"none", "samples", "features", "both"}:
        cluster_by = "both"

    matrix = load_csv(uid, project_id, matrix_path, index_col=0)
    meta = load_csv(uid, project_id, meta_path, index_col=0)
    matrix = _normalize_numeric(matrix)

    common_samples = matrix.columns.intersection(meta.index)
    if common_samples.empty:
        raise ValueError("No overlap between matrix samples and metadata rows.")

    matrix = matrix[common_samples]
    meta = meta.loc[common_samples].copy()

    if not meta_col or meta_col not in meta.columns:
        meta_col = meta.columns[0] if len(meta.columns) else ""

    if meta_col:
        meta_values = meta[meta_col].astype(str)
        meta_values = meta_values.replace({"nan": "NaN", "None": "NaN", "": "NaN"})
        meta[meta_col] = meta_values
    else:
        meta["__group__"] = "All"
        meta_col = "__group__"

    if selected_labels:
        keep = meta.index[meta[meta_col].isin(selected_labels)]
        matrix = matrix.loc[:, matrix.columns.intersection(keep)]
        meta = meta.loc[matrix.columns]

    if selected_features:
        selected_set = set(selected_features)
        keep_rows = [idx for idx in matrix.index if str(idx) in selected_set]
        matrix = matrix.loc[keep_rows]

    if mode == "heatmap" and len(selected_features) == 0:
        fig = _build_blank_figure("Select features to display heatmap.")
        html = pio.to_html(fig, full_html=True, include_plotlyjs="cdn", config={"responsive": True, "displaylogo": False, "scrollZoom": True})
        url = _upload_html(html, uid, project_id, mode)
        return {"html_url": url, "mode": mode, "meta_col": meta_col, "n_features": 0, "n_samples": int(matrix.shape[1])}

    if matrix.empty:
        fig = _build_blank_figure("No data available after current filters.")
        html = pio.to_html(fig, full_html=True, include_plotlyjs="cdn", config={"responsive": True, "displaylogo": False, "scrollZoom": True})
        url = _upload_html(html, uid, project_id, mode)
        return {"html_url": url, "mode": mode, "meta_col": meta_col, "n_features": 0, "n_samples": 0}

    if mode == "heatmap":
        if view_type == "mean_expression":
            grouped = matrix.T.join(meta[[meta_col]]).groupby(meta_col).mean(numeric_only=True)
            data = grouped.T
            x_labels = [str(v) for v in data.columns]
            x_groups = x_labels
        else:
            ordered_meta = meta.sort_values(by=meta_col)
            ordered_samples = ordered_meta.index.tolist()
            data = matrix[ordered_samples]
            x_labels = [str(v) for v in ordered_samples]
            x_groups = [str(ordered_meta.loc[s, meta_col]) for s in ordered_samples]

        if standardization == "autoscale_features":
            data = _autoscale_features(data)
        elif standardization == "autoscale_samples":
            data = _autoscale_samples(data)

        separators = []
        for i in range(1, len(x_groups)):
            if x_groups[i] != x_groups[i - 1]:
                separators.append(i - 0.5)

        fig = go.Figure(data=go.Heatmap(
            z=data.values,
            x=x_labels,
            y=[str(v) for v in data.index],
            colorscale="RdBu_r",
            colorbar={"title": "Expression"},
            hovertemplate="Feature: %{y}<br>Sample/Group: %{x}<br>Value: %{z:.4f}<extra></extra>",
        ))

        fig.update_layout(
            title={"text": f"Heatmap | {meta_col}", "x": 0.01},
            template="plotly_white",
            margin={"l": 80, "r": 20, "t": 60, "b": 80},
            autosize=True,
            shapes=[
                {"type": "line", "x0": x, "x1": x, "y0": -0.5, "y1": float(max(0, data.shape[0] - 0.5)), "line": {"color": "#ffffff", "width": 2}}
                for x in separators
            ],
        )
        fig.update_xaxes(showticklabels=show_col_labels, tickangle=-45)
        fig.update_yaxes(showticklabels=show_row_labels)

        html = pio.to_html(fig, full_html=True, include_plotlyjs="cdn", config={"responsive": True, "displaylogo": False, "scrollZoom": True})
        url = _upload_html(html, uid, project_id, mode)
        return {
            "html_url": url,
            "mode": mode,
            "meta_col": meta_col,
            "n_features": int(data.shape[0]),
            "n_samples": int(data.shape[1]),
            "view_type": view_type,
            "cluster_by": cluster_by,
            "distance": distance,
            "standardization": standardization,
        }

    ordered_meta = meta.sort_values(by=meta_col)
    ordered_samples = ordered_meta.index.tolist()
    data = matrix[ordered_samples]

    if view_type == "mean_expression":
        grouped = data.T.join(meta[[meta_col]]).groupby(meta_col).mean(numeric_only=True)
        data = grouped.T
        meta_labels = [str(v) for v in data.columns]
    else:
        meta_labels = [str(v) for v in ordered_meta[meta_col].tolist()]

    if standardization == "autoscale_features":
        data = _autoscale_features(data)
    elif standardization == "autoscale_samples":
        data = _autoscale_samples(data)

    fig = _build_interactive_hca_figure(
        data=data,
        meta_labels=meta_labels,
        label_domain=label_domain,
        color_map_input=color_map_input,
        hca_layout=hca_layout,
        meta_col=meta_col,
        show_col_labels=show_col_labels,
        show_row_labels=show_row_labels,
        distance=distance,
        cluster_by=cluster_by,
    )
    html = pio.to_html(fig, full_html=True, include_plotlyjs="cdn", div_id="hca-plot",
                       config={"responsive": True, "displaylogo": False, "scrollZoom": True, "edits": {"annotationPosition": True}})
    html = html.replace(
        "</body>",
        """<style>g.annotation text{font-weight:bold!important;}</style>
<script>
function boldAnnotations() {
    document.querySelectorAll('g.annotation text').forEach(function(el) {
        el.style.fontWeight = 'bold';
    });
}
var _origSerialize = XMLSerializer.prototype.serializeToString;
XMLSerializer.prototype.serializeToString = function(node) {
    if (node && node.querySelectorAll) {
        node.querySelectorAll('g.annotation text').forEach(function(el) {
            el.setAttribute('font-weight', 'bold');
        });
    }
    return _origSerialize.call(this, node);
};
setTimeout(boldAnnotations, 800);
window.addEventListener('message', function(evt) {
    var d = evt.data || {};
    if (d.type === 'hca_relayout') {
        Plotly.relayout('hca-plot', d.updates);
        setTimeout(boldAnnotations, 50);
    } else if (d.type === 'hca_restyle') {
        Plotly.restyle('hca-plot', d.style);
        setTimeout(boldAnnotations, 50);
    } else if (d.type === 'hca_annotation_font') {
        var plot = document.getElementById('hca-plot');
        var fullLayout = plot._fullLayout || {};
        var n = (fullLayout.annotations || []).length;
        var updates = {};
        for (var i = 0; i < n; i++) {
            updates['annotations[' + i + '].font.size'] = d.size;
        }
        if (Object.keys(updates).length) {
            Plotly.relayout('hca-plot', updates).then(function() { setTimeout(boldAnnotations, 50); });
        }
    } else if (d.type === 'hca_download') {
        Plotly.downloadImage('hca-plot', d.options);
    } else if (d.type === 'hca_preview') {
        Plotly.toImage('hca-plot', d.options || {}).then(function(url) {
            evt.source.postMessage({ type: 'hca_preview_result', dataURL: url }, '*');
        }).catch(function(err) {
            evt.source.postMessage({ type: 'hca_preview_result', error: String(err) }, '*');
        });
    }
});
</script></body>""",
    )
    url = _upload_html(html, uid, project_id, mode)

    return {
        "html_url": url,
        "mode": mode,
        "meta_col": meta_col,
        "n_features": int(data.shape[0]),
        "n_samples": int(data.shape[1]),
        "view_type": view_type,
        "cluster_by": cluster_by,
        "distance": distance,
        "standardization": standardization,
    }
