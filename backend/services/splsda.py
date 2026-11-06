from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from services.common import *

logger = logging.getLogger("SPLSDA_PIPELINE")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _py_native(val):
    if isinstance(val, np.integer):
        return int(val)
    if isinstance(val, np.floating):
        return float(val)
    if isinstance(val, np.bool_):
        return bool(val)
    return val


def _load_from_storage(
    uid: str, project_id: str, matrix_path: str, meta_path: str
) -> Tuple[pd.DataFrame, pd.DataFrame, List[str], List[Dict[str, Any]], List[str]]:
    df_matrix = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)

    sample_ids = [str(s) for s in df_matrix.columns]
    x_df = df_matrix.T.copy()
    x_df.index = sample_ids

    metadata_columns = [
        c
        for c in df_meta.columns
        if c.lower() != "sample_id" and c != df_meta.index.name
    ]
    metadata = []
    for sid in sample_ids:
        row: Dict[str, Any] = {"sample_id": sid}
        if sid in df_meta.index:
            for col in metadata_columns:
                val = df_meta.at[sid, col]
                row[col] = None if pd.isna(val) else _py_native(val)
        metadata.append(row)

    return x_df, df_meta, sample_ids, metadata, metadata_columns


# ---------------------------------------------------------------------------
# rpy2 bridge
# ---------------------------------------------------------------------------

def _run_splsda_r(
    X: np.ndarray,
    Y: List[str],
    ncomp: int,
    keepX: List[int],
    scale: bool,
) -> Dict[str, Any]:
    """Call mixOmics::splsda() via rpy2 and return raw results as Python objects."""
    import rpy2.robjects as ro
    from rpy2.robjects import numpy2ri, pandas2ri
    from rpy2.robjects.packages import importr

    numpy2ri.activate()
    pandas2ri.activate()

    base = importr("base")
    mixOmics = importr("mixOmics")

    # Convert X to R matrix
    r_X = ro.r.matrix(
        ro.FloatVector(X.flatten("F")),
        nrow=X.shape[0],
        ncol=X.shape[1],
        byrow=False,
    )
    r_X.rownames = ro.StrVector([str(i) for i in range(X.shape[0])])

    # Y as factor
    r_Y = base.factor(ro.StrVector(Y))

    # keepX as integer vector
    r_keepX = ro.IntVector(keepX)

    # Run sPLS-DA
    result = mixOmics.splsda(
        X=r_X,
        Y=r_Y,
        ncomp=ncomp,
        keepX=r_keepX,
        scale=scale,
    )

    # Extract variates (scores) for each component
    variates = np.array(result.rx2("variates").rx2("X"))  # shape [n, ncomp]

    # Extract explained variance
    explained_variance = np.array(result.rx2("explained_variance").rx2("X")).flatten()

    # Extract loadings for comp 1 and comp 2
    loadings_X = np.array(result.rx2("loadings").rx2("X"))  # shape [p, ncomp]

    # VIP scores (comp 1)
    vip_scores_r = mixOmics.vip(result)
    vip_matrix = np.array(vip_scores_r)  # shape [p, ncomp]
    # Use max VIP across components (overall importance)
    vip_overall = np.max(vip_matrix, axis=1) if vip_matrix.ndim == 2 else vip_matrix.flatten()

    numpy2ri.deactivate()
    pandas2ri.deactivate()

    return {
        "variates": variates,
        "explained_variance": explained_variance.tolist(),
        "loadings_X": loadings_X,
        "vip_overall": vip_overall,
        "vip_per_comp": vip_matrix,
    }


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_splsda_from_paths(
    uid: str,
    project_id: str,
    matrix_path: str,
    meta_path: str,
    target_meta: str,
    ncomp: int = 2,
    keepX: Optional[List[int]] = None,
    scale: bool = True,
    cv_folds: int = 5,
    selected_groups: Optional[List[str]] = None,
) -> Dict[str, Any]:
    logger.info("===== [PROCESS] START sPLS-DA =====")

    x_df, df_meta, sample_ids, metadata, metadata_columns = _load_from_storage(
        uid, project_id, matrix_path, meta_path
    )

    if target_meta not in df_meta.columns and target_meta != df_meta.index.name:
        raise ValueError(f"Target metadata column '{target_meta}' not found.")

    feature_names: List[str] = list(x_df.columns)
    n_samples = len(sample_ids)
    n_features = len(feature_names)

    # Clamp params
    ncomp = max(2, min(10, int(ncomp)))
    if keepX is None or len(keepX) == 0:
        keepX = [min(50, n_features)] * ncomp
    else:
        while len(keepX) < ncomp:
            keepX.append(keepX[-1] if keepX else min(50, n_features))
        keepX = [max(1, min(n_features, int(k))) for k in keepX[:ncomp]]

    # Extract Y labels
    if target_meta in df_meta.columns:
        y_series = df_meta[target_meta]
    else:
        y_series = df_meta.index.to_series()

    # Align to sample_ids order
    y_aligned: List[str] = []
    for sid in sample_ids:
        val = y_series.get(sid) if hasattr(y_series, "get") else (
            y_series[sid] if sid in y_series.index else None
        )
        y_aligned.append(str(val) if val is not None else "Unknown")

    # Filter by selected_groups if provided
    if selected_groups and len(selected_groups) >= 2:
        allowed = set(str(g) for g in selected_groups)
        keep_idx = [i for i, g in enumerate(y_aligned) if g in allowed]
        if len(keep_idx) < 2:
            raise ValueError(f"Not enough samples after filtering to selected_groups={selected_groups}")
        sample_ids = [sample_ids[i] for i in keep_idx]
        y_aligned = [y_aligned[i] for i in keep_idx]
        metadata = [metadata[i] for i in keep_idx]
        x_df = x_df.iloc[keep_idx]
        logger.info(f"Filtered to {len(sample_ids)} samples in groups: {selected_groups}")

    # Drop samples with NaN or unknown labels if needed
    X = x_df.values.astype(float)
    Y = y_aligned

    # Replace NaN in X with column mean
    col_means = np.nanmean(X, axis=0)
    nan_mask = np.isnan(X)
    X[nan_mask] = np.take(col_means, np.where(nan_mask)[1])

    # Run R
    logger.info(f"Calling mixOmics::splsda ncomp={ncomp} keepX={keepX} scale={scale}")
    r_result = _run_splsda_r(X=X, Y=Y, ncomp=ncomp, keepX=keepX, scale=scale)

    variates = r_result["variates"]  # [n, ncomp]
    explained_variance: List[float] = [
        float(v) * 100.0 for v in r_result["explained_variance"][:ncomp]
    ]
    vip_overall: np.ndarray = np.asarray(r_result["vip_overall"], dtype=float)

    # Build plot points (Comp 1 vs Comp 2)
    points = []
    for i, sid in enumerate(sample_ids):
        comp1 = float(variates[i, 0]) if variates.shape[1] > 0 else 0.0
        comp2 = float(variates[i, 1]) if variates.shape[1] > 1 else 0.0
        points.append({
            "sample_id": str(sid),
            "x": comp1,
            "y": comp2,
            "group": str(Y[i]),
        })

    # Build VIP list
    vip_list = []
    for i, feat in enumerate(feature_names):
        v = float(vip_overall[i]) if i < len(vip_overall) and np.isfinite(vip_overall[i]) else None
        vip_list.append({"feature": feat, "vip": v})
    vip_sorted = sorted(
        vip_list,
        key=lambda d: (d["vip"] is None, -(d["vip"] if d["vip"] is not None else -np.inf)),
    )

    # Build axis labels with explained variance
    var1 = explained_variance[0] if len(explained_variance) > 0 else 0.0
    var2 = explained_variance[1] if len(explained_variance) > 1 else 0.0
    axis_x = f"Comp 1 ({var1:.1f}% var)"
    axis_y = f"Comp 2 ({var2:.1f}% var)"

    # Compute R2X (total variance explained by all components)
    r2x = float(sum(explained_variance)) / 100.0 if explained_variance else None

    return {
        "method": "sPLS-DA",
        "target_meta": target_meta,
        "ncomp": ncomp,
        "keepX": keepX,
        "scale": scale,
        "selected_groups": selected_groups or [],
        "plot_points": points,
        "sample_ids": sample_ids,
        "metadata": metadata,
        "metadata_columns": metadata_columns,
        "feature_names": feature_names,
        "vip_scores": vip_list,
        "vip_top": vip_sorted[:50],
        "metrics": {
            "r2x": r2x,
            "explained_variance_per_comp": explained_variance,
        },
        "axis_labels": {
            "x": axis_x,
            "y": axis_y,
        },
    }
