from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

from services.common import *

logger = logging.getLogger("KMEANS_PIPELINE")


# ===================== JSON ENCODER =====================
class _NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


# ===================== STORAGE =====================
def save_kmeans_run_to_storage(uid: str, project_id: str, run_id: str, data: dict) -> str:
    path = f"projects/{uid}/{project_id}/kmeans_runs/{run_id}.json"
    save_json(uid, project_id, path, data)
    logger.info(f"[STORAGE] Saved KMeans run")
    return path


def load_kmeans_run_from_storage(uid: str, project_id: str, data_path: str) -> dict:
    return load_json_file(uid, project_id, data_path)


# ===================== HELPERS =====================
def _py_native(val):
    if isinstance(val, np.integer): return int(val)
    if isinstance(val, np.floating): return float(val)
    if isinstance(val, np.bool_): return bool(val)
    return val


def _load_matrix_meta(uid: str, project_id: str, matrix_path: str, meta_path: str):
    df = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)
    return df, df_meta


def _load_pca_run(uid: str, project_id: str, data_path: str) -> dict:
    """Load a previously saved PCA run JSON from storage."""
    return load_json_file(uid, project_id, data_path)


def _extract_run_embedding(run_data: dict) -> np.ndarray:
    raw_embedding = run_data.get("embedding")
    if raw_embedding is None:
        raw_embedding = run_data.get("clustering_embedding")
    if raw_embedding is None:
        raise ValueError("PCA run data missing 'embedding' field")

    emb_array = np.array(raw_embedding, dtype=float)
    if emb_array.ndim != 2 or emb_array.shape[0] == 0 or emb_array.shape[1] == 0:
        raise ValueError("PCA run embedding is empty or invalid")
    return emb_array


def _norm_str(v) -> str:
    """Normalize a value to string; collapses whole-number floats ('1.0' → '1').
    Keeps the same representation that JavaScript's String() produces for numbers."""
    s = str(v).strip()
    try:
        f = float(s)
        if f == int(f):
            return str(int(f))
        return s
    except (ValueError, OverflowError):
        return s


def _verify_csv_upload(uid: str, project_id: str, meta_path: str, expected_columns: list, upload_size: int):
    """Immediately re-read the CSV after upload and verify columns match."""
    try:
        verify_df = load_csv(uid, project_id, meta_path, index_col=0)
        actual = sorted(verify_df.columns.tolist())
        expected = sorted(expected_columns)
        if actual != expected:
            logger.error(f"[Verify] COLUMN MISMATCH after upload! expected={expected} actual={actual}")
        else:
            logger.info(f"[Verify] Column verification passed: {len(actual)} columns")
    except Exception as exc:
        logger.error(f"[Verify] Verification failed: {exc}")


def _align_sample_ids(sample_ids: List[str], candidate_ids: List[str]) -> List[str]:
    """Return sample_ids ordered as in sample_ids, matched against candidate_ids via normalized keys."""
    normalized_lookup: Dict[str, str] = {}
    for candidate in candidate_ids:
        key = _norm_str(candidate)
        if key not in normalized_lookup:
            normalized_lookup[key] = candidate

    ordered_ids: List[str] = []
    seen = set()
    for sample_id in sample_ids:
        matched = normalized_lookup.get(_norm_str(sample_id))
        if matched is None or matched in seen:
            continue
        ordered_ids.append(matched)
        seen.add(matched)
    return ordered_ids


def _to_visualization_embedding(embedding: np.ndarray, axes: Optional[List[int]] = None) -> np.ndarray:
    if embedding.ndim != 2:
        raise ValueError("embedding must be 2D")
    if embedding.shape[0] == 0:
        return np.zeros((0, 2), dtype=float)

    selected_axes = list(axes or [])
    if not selected_axes:
        selected_axes = [0, 1] if embedding.shape[1] >= 2 else [0]
    valid_axes = [axis for axis in selected_axes if 0 <= axis < embedding.shape[1]]
    if not valid_axes:
        valid_axes = [0]

    if len(valid_axes) >= 2:
        return np.asarray(embedding[:, valid_axes[:2]], dtype=float)
    return np.column_stack([
        embedding[:, valid_axes[0]],
        np.zeros(embedding.shape[0], dtype=float),
    ])


def _choose_visualization_axes(
    embedding: np.ndarray,
    cluster_idx: List[int],
    cluster_labels: np.ndarray,
) -> List[int]:
    if embedding.ndim != 2 or embedding.shape[1] <= 1:
        return [0, 0]

    if len(cluster_idx) < 2 or len(np.unique(cluster_labels)) < 2:
        return [0, 1]

    clustered = np.asarray(embedding[cluster_idx], dtype=float)
    label_arr = np.asarray(cluster_labels)
    unique_labels = np.unique(label_arr)
    n_search = min(10, clustered.shape[1])

    axis_scores: List[float] = []
    for axis in range(n_search):
        col = clustered[:, axis]
        overall_mean = float(col.mean())
        between = 0.0
        within = 1e-9
        for label in unique_labels:
            members = col[label_arr == label]
            if len(members) == 0:
                continue
            center = float(members.mean())
            between += len(members) * float((center - overall_mean) ** 2)
            within += float(np.sum((members - center) ** 2))
        axis_scores.append(between / within)

    ranked_axes = sorted(range(n_search), key=lambda axis: axis_scores[axis], reverse=True)
    best_axes = sorted(ranked_axes[:2])
    while len(best_axes) < 2:
        best_axes.append(best_axes[-1] if best_axes else 0)
    return best_axes[:2]


# ===================== CORE =====================
def run_kmeans(
    project_id: str,
    uid: str,
    name: str,
    input_type: str,           # "normalize" | "pca"
    matrix_path: str,
    meta_path: str,
    n_clusters: int,
    selected_labels: List[str],
    meta_col: str,
    pca_run_data_path: Optional[str] = None,
    run_new_pca: bool = False,
) -> Dict[str, Any]:
    logger.info(f"[KMeans] START | project={project_id} | name={name} | input={input_type} | k={n_clusters} | run_new_pca={run_new_pca}")

    # ── 1. Load data ─────────────────────────────────────────────
    df_matrix, df_meta = _load_matrix_meta(uid, project_id, matrix_path, meta_path)

    metadata_columns = [c for c in df_meta.columns if c.lower() != "sample_id"]

    common = df_matrix.columns.intersection(df_meta.index)
    df_matrix = df_matrix[common]
    df_meta = df_meta.loc[common].copy()

    # Ensure meta col exists
    if not meta_col or meta_col not in df_meta.columns:
        meta_col = metadata_columns[0] if metadata_columns else ""

    all_sample_ids = list(df_meta.index)

    # --- RUN_NEW_PCA LOGIC ---
    if run_new_pca:
        clustering_method = "pca"
        # Only keep selected samples
        if selected_labels and meta_col:
            normalized_col = df_meta[meta_col].map(_norm_str)
            normalized_sel = {_norm_str(l) for l in selected_labels}
            selected_idx = df_meta.index[normalized_col.isin(normalized_sel)].tolist()
        else:
            selected_idx = all_sample_ids
        if not selected_idx:
            raise ValueError(
                f"No samples matched the selected labels for column '{meta_col}'. "
                "Check that numeric values display the same way (e.g. '1' vs '1.0')."
            )
        df_matrix = df_matrix[selected_idx]
        df_meta = df_meta.loc[selected_idx].copy()
        all_sample_ids = list(df_meta.index)
        # Recompute PCA on selected samples
        X_all = df_matrix.T.values.astype(float)
        X_all = np.nan_to_num(X_all)
        n_samples, n_features = X_all.shape
        n_components = min(30, n_samples - 1, n_features)
        if n_components < 1:
            raise ValueError("Not enough samples/features for PCA.")
        pca_model = PCA(n_components=n_components, random_state=42)
        clustering_embedding_all = pca_model.fit_transform(X_all)
        pca_ev = pca_model.explained_variance_ratio_.tolist()
        cluster_samples = all_sample_ids
        cluster_idx = list(range(len(all_sample_ids)))
    else:
        clustering_embedding_all: Optional[np.ndarray] = None
        pca_ev: List[float] = []
        clustering_method = "pca" if input_type == "pca" and pca_run_data_path else "auto_pca"

        if input_type == "pca" and pca_run_data_path:
            pca_data = _load_pca_run(uid, project_id, pca_run_data_path)
            # Build lookup {sample_id → [x, y, ...]}
            emb_array = _extract_run_embedding(pca_data)
            emb_ids = pca_data.get("sample_ids", [])
            if not emb_ids:
                raise ValueError("PCA run data missing sample_ids")
            id_to_emb = {}
            for i, sid in enumerate(emb_ids):
                key = _norm_str(sid)
                if key not in id_to_emb:
                    id_to_emb[key] = emb_array[i]

            # Only keep samples in our matrix intersection
            ordered_ids = _align_sample_ids(all_sample_ids, emb_ids)
            if not ordered_ids:
                raise ValueError("Selected PCA run has no overlapping samples with current matrix/meta data")

            clustering_embedding_all = np.array([id_to_emb[_norm_str(s)] for s in ordered_ids], dtype=float)
            df_meta = df_meta.loc[ordered_ids]
            df_matrix = df_matrix[ordered_ids]
            all_sample_ids = ordered_ids
            pca_ev = pca_data.get("explained_variance_ratio", [])
        else:
            # Normalize mode: transpose matrix (rows=samples), do quick PCA for vis
            X_all = df_matrix.T.values.astype(float)
            X_all = np.nan_to_num(X_all)

            n_vis_components = min(X_all.shape[0], X_all.shape[1], 50)
            pca_model = PCA(n_components=n_vis_components, random_state=42)
            clustering_embedding_all = pca_model.fit_transform(X_all)
            pca_ev = pca_model.explained_variance_ratio_.tolist()

        # Apply label filter after any PCA-based sample alignment.
        if selected_labels and meta_col:
            normalized_col = df_meta[meta_col].map(_norm_str)
            normalized_sel = {_norm_str(l) for l in selected_labels}
            cluster_samples = df_meta.index[normalized_col.isin(normalized_sel)].tolist()
        else:
            cluster_samples = all_sample_ids

        cluster_idx = [i for i, s in enumerate(all_sample_ids) if s in set(cluster_samples)]
        if not cluster_idx:
            raise ValueError(
                f"No samples matched the selected labels for column '{meta_col}'. "
                "Check that numeric values display the same way (e.g. '1' vs '1.0')."
            )
    X_cluster = clustering_embedding_all[cluster_idx]

    # ── 3. Run KMeans ─────────────────────────────────────────────
    n_clusters = min(n_clusters, len(cluster_idx))
    km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    cluster_labels_raw = km.fit_predict(X_cluster)
    visualization_axes = _choose_visualization_axes(clustering_embedding_all, cluster_idx, cluster_labels_raw)
    visualization_embedding = _to_visualization_embedding(clustering_embedding_all, visualization_axes)

    primary_axis = visualization_axes[0] if visualization_axes else 0
    centroid_order = np.argsort(km.cluster_centers_[:, primary_axis])
    label_remap = {int(old): new for new, old in enumerate(centroid_order.tolist())}
    cluster_label_map = {
        idx: f"Cluster {label_remap[int(cluster_id)] + 1}"
        for idx, cluster_id in zip(cluster_idx, cluster_labels_raw)
    }

    # Assign labels for all samples; non-clustered samples remain null.
    assignments: Dict[str, Optional[str]] = {}
    if run_new_pca:
        # Only output selected samples
        for i, sid in enumerate(all_sample_ids):
            assignments[sid] = cluster_label_map.get(i)
    else:
        # Output all samples, non-selected = NaN
        for i, sid in enumerate(all_sample_ids):
            assignments[sid] = cluster_label_map.get(i) if i in cluster_idx else None

    # ── 4. Build plot points ──────────────────────────────────────
    plot_points = []
    for i, sid in enumerate(all_sample_ids):
        x = float(visualization_embedding[i, 0])
        y = float(visualization_embedding[i, 1])
        plot_points.append({"sample_id": sid, "x": x, "y": y, "cluster": assignments[sid]})

    # ── 5. Build metadata list ────────────────────────────────────
    metadata_out = []
    for sid in all_sample_ids:
        row = {"sample_id": sid}
        if sid in df_meta.index:
            for col in metadata_columns:
                val = df_meta.at[sid, col]
                row[col] = None if pd.isna(val) else _py_native(val)
        row["__kmeans_cluster__"] = assignments[sid]
        metadata_out.append(row)
    if run_new_pca:
        # Only output selected samples
        metadata_out = [row for row in metadata_out if assignments[row["sample_id"]] is not None]
        all_sample_ids = [row["sample_id"] for row in metadata_out]

    result = {
        "method": "KMeans",
        "n_clusters": n_clusters,
        "input_type": input_type,
        "pca_run_data_path": pca_run_data_path or "",
        "meta_col": meta_col,
        "selected_labels": selected_labels,
        "cluster_assignments": assignments,
        "cluster_labels": [f"Cluster {i + 1}" for i in range(n_clusters)],
        "cluster_name_map": {f"Cluster {i + 1}": f"Cluster {i + 1}" for i in range(n_clusters)},
        "plot_points": [p for p in plot_points if assignments.get(p["sample_id"]) is not None] if run_new_pca else plot_points,
        "clustering_embedding": clustering_embedding_all.tolist(),
        "visualization_embedding": visualization_embedding.tolist(),
        "plot_embedding": visualization_embedding.tolist(),
        "visualization_axes": visualization_axes,
        "visualization_axis_labels": [f"PC{axis + 1}" for axis in visualization_axes[:2]],
        "visualization_explained_variance_ratio": [
            float(pca_ev[axis]) for axis in visualization_axes[:2] if axis < len(pca_ev)
        ],
        "sample_ids": all_sample_ids,
        "metadata": metadata_out,
        "metadata_columns": metadata_columns,
        "explained_variance_ratio": pca_ev,
        "clustering_space": {
            "method": clustering_method,
            "dimensions": int(clustering_embedding_all.shape[1]),
        },
        "visualization": {
            "method": "pca_overlay",
            "dimensions": 2,
        },
    }

    logger.info(f"[KMeans] DONE | k={n_clusters} | n_samples={len(all_sample_ids)}")
    return result


# ===================== SAVE CLUSTERS TO META FILE =====================
def save_clusters_to_meta(
    uid: str,
    project_id: str,
    meta_path: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Any],
    rename_map: Optional[Dict[str, str]] = None,
    source_col_name: Optional[str] = None,
    remove_source_when_renamed: bool = False,
) -> str:
    """
    Append/overwrite a cluster column to the metadata CSV and upload back.
    Returns the storage path of the updated metadata file.
    """
    logger.info(f"[KMeans] Saving cluster column '{cluster_col_name}' to meta | project={project_id}")

    # Normalize all assignment values to strings (handles numeric metadata columns)
    if cluster_assignments:
        cluster_assignments = {
            str(k): (str(v) if v is not None and str(v).lower() != "nan" else None)
            for k, v in cluster_assignments.items()
        }

    raw_bytes = read_bytes(uid, project_id, meta_path)
    df_meta = pd.read_csv(__import__("io").BytesIO(raw_bytes), index_col=0)
    logger.info(f"[KMeans] CSV downloaded: {len(raw_bytes)} bytes, columns={list(df_meta.columns)}")

    # Global rename mode: rename labels by mapping across the full source column.
    if rename_map and source_col_name and source_col_name in df_meta.columns:
        norm_rename = {_safe_meta_label(k): _safe_meta_label(v) for k, v in (rename_map or {}).items()}
        remapped = df_meta[source_col_name].map(lambda v: norm_rename.get(_safe_meta_label(v), _safe_meta_label(v)))
        df_meta[cluster_col_name] = remapped
    else:
        # Assignment mode: patch by sample_id map; fallback to existing values to avoid partial overwrite.
        normalized_assignments = {_norm_str(k): v for k, v in (cluster_assignments or {}).items()}

        def _lookup_assignment(sample_id):
            direct = cluster_assignments.get(str(sample_id)) if cluster_assignments else None
            if direct is not None:
                return direct
            return normalized_assignments.get(_norm_str(sample_id), None)

        if cluster_col_name in df_meta.columns:
            df_meta[cluster_col_name] = [
                _lookup_assignment(idx) if _lookup_assignment(idx) is not None else df_meta.loc[idx, cluster_col_name]
                for idx in df_meta.index
            ]
        elif source_col_name and source_col_name in df_meta.columns:
            df_meta[cluster_col_name] = [
                _lookup_assignment(idx) if _lookup_assignment(idx) is not None else df_meta.loc[idx, source_col_name]
                for idx in df_meta.index
            ]
        else:
            df_meta[cluster_col_name] = [
                _lookup_assignment(idx) if _lookup_assignment(idx) is not None else float("nan")
                for idx in df_meta.index
            ]
    if (
        remove_source_when_renamed
        and source_col_name
        and source_col_name != cluster_col_name
        and source_col_name in df_meta.columns
    ):
        df_meta = df_meta.drop(columns=[source_col_name])

    csv_bytes = csv_safe_frame(df_meta).to_csv().encode("utf-8")
    save_bytes(uid, project_id, meta_path, csv_bytes)
    logger.info(f"[KMeans] CSV uploaded: {len(csv_bytes)} bytes, columns={list(df_meta.columns)}")

    # Verify upload persisted
    _verify_csv_upload(uid, project_id, meta_path, list(df_meta.columns), len(csv_bytes))

    # Sync run JSONs FIRST — must complete before project update
    _sync_all_run_metadata_from_df(uid=uid, project_id=project_id, df_meta=df_meta)

    # Update project document so other tools see the new metadata column
    data = get_project_data(project_id)
    if data:
        meta_cols = data.get("meta_metadata", [])
        groups = sorted({
            str(v) for v in df_meta[cluster_col_name].dropna().astype(str).tolist()
            if str(v).strip() and str(v).lower() != "nan"
        })
        updated = False
        for col in meta_cols:
            if col.get("name") == cluster_col_name:
                col["type"] = "Categorical"
                col["groups"] = groups
                updated = True
                break
        if not updated:
            meta_cols.append({"name": cluster_col_name, "type": "Categorical", "groups": groups})

        if (
            remove_source_when_renamed
            and source_col_name
            and source_col_name != cluster_col_name
        ):
            meta_cols = [col for col in meta_cols if col.get("name") != source_col_name]

        update_project(project_id, meta_metadata=meta_cols)

    logger.info(f"[KMeans] Cluster column saved")
    return meta_path


def delete_meta_columns(
    uid: str,
    project_id: str,
    meta_path: str,
    column_names: List[str],
) -> Dict[str, Any]:
    """Delete one or multiple metadata columns from CSV and project descriptor."""
    raw_bytes = read_bytes(uid, project_id, meta_path)
    df_meta = pd.read_csv(__import__("io").BytesIO(raw_bytes), index_col=0)
    logger.info(f"[Delete] CSV downloaded, columns={list(df_meta.columns)}")

    requested = [str(name).strip() for name in (column_names or []) if str(name).strip()]
    existing = [name for name in requested if name in df_meta.columns]
    missing = [name for name in requested if name not in df_meta.columns]

    if existing:
        df_meta = df_meta.drop(columns=existing)
        csv_bytes = csv_safe_frame(df_meta).to_csv().encode("utf-8")
        save_bytes(uid, project_id, meta_path, csv_bytes)
        _verify_csv_upload(uid, project_id, meta_path, list(df_meta.columns), len(csv_bytes))

    # Sync run JSONs FIRST — must complete before project update
    if existing:
        _sync_all_run_metadata_from_df(uid=uid, project_id=project_id, df_meta=df_meta)

    data = get_project_data(project_id)
    if data and existing:
        meta_cols = data.get("meta_metadata", [])
        existing_set = set(existing)
        meta_cols = [col for col in meta_cols if col.get("name") not in existing_set]
        update_project(project_id, meta_metadata=meta_cols)

    return {
        "meta_path": meta_path,
        "deleted": existing,
        "missing": missing,
        "remaining_columns": [str(col) for col in df_meta.columns],
    }


def create_meta_column(
    uid: str,
    project_id: str,
    meta_path: str,
    new_column_name: str,
    mode: str,  # 'duplicate' or 'merge'
    source_columns: List[str],
) -> Dict[str, Any]:
    """
    Create a new metadata column by duplicating or merging existing columns.
    - duplicate: copy all labels from one source column
    - merge: combine labels from 2-3 source columns with ' - ' separator
    """
    if mode not in ("duplicate", "merge"):
        raise ValueError(f"Invalid mode: {mode}")

    if mode == "duplicate" and len(source_columns) != 1:
        raise ValueError("Duplicate mode requires exactly 1 source column")

    if mode == "merge" and (len(source_columns) < 2 or len(source_columns) > 3):
        raise ValueError("Merge mode requires 2-3 source columns")

    raw_bytes = read_bytes(uid, project_id, meta_path)
    logger.info(f"[CreateMeta] Downloaded CSV: {len(raw_bytes)} bytes")
    df_meta = pd.read_csv(__import__("io").BytesIO(raw_bytes), index_col=0)
    logger.info(f"[CreateMeta] CSV columns after read: {list(df_meta.columns)}")

    if new_column_name in df_meta.columns:
        raise ValueError(f"Column '{new_column_name}' already exists")

    for col in source_columns:
        if col not in df_meta.columns:
            raise ValueError(f"Source column '{col}' not found")

    if mode == "duplicate":
        source_col = source_columns[0]
        df_meta[new_column_name] = df_meta[source_col]
    else:
        parts = df_meta[source_columns].apply(
            lambda row: " - ".join([_safe_meta_label(row[col]) for col in source_columns]),
            axis=1,
        )
        df_meta[new_column_name] = parts

    csv_bytes = csv_safe_frame(df_meta).to_csv().encode("utf-8")
    save_bytes(uid, project_id, meta_path, csv_bytes)

    # Verify upload persisted
    _verify_csv_upload(uid, project_id, meta_path, list(df_meta.columns), len(csv_bytes))

    # Sync run JSONs FIRST — must complete before project update
    _sync_all_run_metadata_from_df(uid=uid, project_id=project_id, df_meta=df_meta)

    data = get_project_data(project_id)
    if data:
        meta_cols = data.get("meta_metadata", [])

        color = None
        if mode == "duplicate":
            for col_info in meta_cols:
                if col_info.get("name") == source_columns[0]:
                    color = col_info.get("color")
                    break

        groups = sorted({
            _safe_meta_label(v)
            for v in df_meta[new_column_name].tolist()
            if _safe_meta_label(v).lower() != "nan"
        })

        new_col_info = {
            "name": new_column_name,
            "type": "Categorical",
            "groups": groups,
        }
        if color:
            new_col_info["color"] = color
        meta_cols.append(new_col_info)
        update_project(project_id, meta_metadata=meta_cols)

    return {
        "meta_path": meta_path,
        "new_column": new_column_name,
        "mode": mode,
        "source_columns": source_columns,
        "all_columns": [str(col) for col in df_meta.columns],
    }


def reorder_meta_groups(
    uid: str,
    project_id: str,
    column_name: str,
    ordered_groups: List[str],
) -> Dict[str, Any]:
    """Persist a user-defined ordering of a metadata column's groups.

    Only reorders the `groups` array on the project's meta_metadata entry; the
    underlying CSV is unchanged (group values stay the same, only their display
    order changes). Downstream tools that read `meta_metadata[].groups` will
    honor this order.
    """
    data = get_project_data(project_id)
    if not data:
        raise ValueError("Project not found")

    meta_cols = data.get("meta_metadata", []) or []
    target = None
    for col in meta_cols:
        if col.get("name") == column_name:
            target = col
            break
    if target is None:
        raise ValueError(f"Metadata column '{column_name}' not found")

    # Normalize: keep only non-empty, de-duplicated, in the supplied order.
    seen = set()
    clean: List[str] = []
    for g in ordered_groups or []:
        label = _safe_meta_label(g)
        key = label.lower()
        if not label or label.lower() == "nan" or key in seen:
            continue
        seen.add(key)
        clean.append(label)

    # Append any existing groups not mentioned by the user (so none are lost).
    for g in target.get("groups", []) or []:
        if g.lower() not in seen:
            clean.append(g)
            seen.add(g.lower())

    target["groups"] = clean
    update_project(project_id, meta_metadata=meta_cols)
    logger.info(f"[ReorderGroups] '{column_name}' -> {clean}")
    return {"column": column_name, "groups": clean}


def rename_meta_column(
    uid: str,
    project_id: str,
    meta_path: str,
    old_name: str,
    new_name: str,
) -> Dict[str, Any]:
    """Rename a metadata column: CSV header, run JSON metadata rows, and the
    project's meta_metadata descriptor. Rejects names with characters outside
    [A-Za-z0-9_-]."""
    import io as _io

    new_name = str(new_name or "").strip()
    if not re.match(r"^[A-Za-z0-9_-]+$", new_name):
        raise ValueError("New name may only contain letters, digits, '_' or '-'.")

    raw_bytes = read_bytes(uid, project_id, meta_path)
    df_meta = pd.read_csv(_io.BytesIO(raw_bytes), index_col=0)
    if old_name not in df_meta.columns:
        raise ValueError(f"Column '{old_name}' not found")
    if new_name in df_meta.columns and new_name != old_name:
        raise ValueError(f"Column '{new_name}' already exists")

    df_meta = df_meta.rename(columns={old_name: new_name})
    csv_bytes = csv_safe_frame(df_meta).to_csv().encode("utf-8")
    save_bytes(uid, project_id, meta_path, csv_bytes)
    _verify_csv_upload(uid, project_id, meta_path, list(df_meta.columns), len(csv_bytes))

    # Sync run JSONs (rename the key inside each run's metadata rows).
    _sync_all_run_metadata_from_df(uid=uid, project_id=project_id, df_meta=df_meta)

    data = get_project_data(project_id)
    if data:
        meta_cols = data.get("meta_metadata", []) or []
        for col in meta_cols:
            if col.get("name") == old_name:
                col["name"] = new_name
                break
        update_project(project_id, meta_metadata=meta_cols)

    logger.info(f"[RenameMeta] '{old_name}' -> '{new_name}'")
    return {
        "meta_path": meta_path,
        "old_name": old_name,
        "new_name": new_name,
        "all_columns": [str(col) for col in df_meta.columns],
    }


def _safe_meta_label(value: Any) -> str:
    if value is None:
        return "NaN"
    try:
        if pd.isna(value):
            return "NaN"
    except Exception:
        pass
    text = str(value).strip()
    return text if text else "NaN"


def _json_safe_value(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        if pd.isna(value) or np.isinf(value):
            return None
        return float(value)
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    return value


def _sanitize_json_value(obj):
    """Recursively replace NaN/Infinity float values with None for JSON-safe serialization."""
    if isinstance(obj, float):
        if obj != obj or obj == float("inf") or obj == float("-inf"):  # NaN or Inf
            return None
        return obj
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        if v != v or v == float("inf") or v == float("-inf"):
            return None
        return v
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return _sanitize_json_value(obj.tolist())
    if isinstance(obj, dict):
        return {k: _sanitize_json_value(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_json_value(item) for item in obj]
    return obj


def _sync_all_run_metadata_from_df(uid: str, project_id: str, df_meta: pd.DataFrame) -> int:
    """Overwrite run metadata blocks from the authoritative metadata DataFrame for global consistency."""
    data = get_project_data(project_id)
    if not data:
        logger.warning(f"[Sync] Project {project_id} not found")
        return 0

    history_keys = ("pca_history", "plsda_history", "oplsda_history", "kmeans_history", "som_history")
    entries = []
    for key in history_keys:
        for entry in (data.get(key) or []):
            if isinstance(entry, dict) and entry.get("data_path"):
                entries.append((key, entry))

    if not entries:
        logger.info(f"[Sync] No run entries with data_path for project={project_id}")
        return 0

    df_meta_copy = df_meta.copy()
    df_meta_copy.index = [_norm_str(idx) for idx in df_meta_copy.index]
    meta_columns = [str(col) for col in df_meta_copy.columns]

    logger.info(f"[Sync] Syncing {len(entries)} run(s) | meta_columns={meta_columns}")

    updated_count = 0
    for history_key, entry in entries:
        data_path = entry.get("data_path")
        try:
            if not file_exists(uid, project_id, data_path):
                logger.warning("[Sync] File not found")
                continue

            raw_bytes = read_bytes(uid, project_id, data_path)

            # Robust JSON parse: handle NaN/Infinity tokens that may exist in older run JSONs
            raw_text = raw_bytes.decode("utf-8")
            # Replace bare NaN/Infinity tokens before parsing
            raw_text = re.sub(r'\bNaN\b', 'null', raw_text)
            raw_text = re.sub(r'\bInfinity\b', 'null', raw_text)
            raw_text = re.sub(r'\b-Infinity\b', 'null', raw_text)
            run_data = json.loads(raw_text)
            metadata = run_data.get("metadata") or []
            if not isinstance(metadata, list) or not metadata:
                continue

            metadata_out = []
            # Run-only columns (e.g. __kmeans_cluster__, __som_cluster__) are
            # NOT in df_meta but must be preserved. Stale columns from a rename
            # or delete must be dropped so the run no longer references them.
            existing_meta_columns = run_data.get("metadata_columns") or []
            cluster_cols = [
                c for c in existing_meta_columns
                if c not in meta_columns and str(c).startswith("__")
            ]
            keep_keys = set(meta_columns) | set(cluster_cols) | {"sample_id"}

            for row in metadata:
                next_row = {k: v for k, v in dict(row).items() if k in keep_keys}
                sid_norm = _norm_str(next_row.get("sample_id"))
                if sid_norm in df_meta_copy.index:
                    src_series = df_meta_copy.loc[sid_norm]
                    if isinstance(src_series, pd.DataFrame):
                        src_series = src_series.iloc[0]
                    for col in meta_columns:
                        next_row[col] = _json_safe_value(src_series[col])

                metadata_out.append(next_row)

            run_data["metadata"] = metadata_out
            # Replace (not merge) metadata_columns so renamed/deleted columns
            # disappear; cluster columns are kept.
            run_data["metadata_columns"] = list(dict.fromkeys(meta_columns + cluster_cols))

            # Sanitize entire run_data to ensure no NaN/Infinity before strict JSON serialization
            sanitized = _sanitize_json_value(run_data)
            out_json = json.dumps(sanitized, cls=_NumpyEncoder, allow_nan=False)
            save_text(uid, project_id, data_path, out_json)
            updated_count += 1
            logger.debug(f"[Sync] OK ({history_key})")
        except Exception as exc:
            logger.exception(f"[Sync] FAILED ({history_key}): {exc}")

    logger.info(f"[Sync] Synced metadata CSV to {updated_count}/{len(entries)} run file(s)")
    return updated_count

def sync_cluster_column_to_existing_pca_runs(
    uid: str,
    project_id: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Any],
) -> int:
    """Patch every existing PCA run JSON so the new cluster column is available on all PCA embeddings."""
    data = get_project_data(project_id)
    if not data:
        return 0

    pca_history = [r for r in (data.get("pca_history") or []) if r.get("type") == "PCA" and r.get("data_path")]
    if not pca_history:
        return 0

    normalized_assignments = {_norm_str(k): v for k, v in (cluster_assignments or {}).items()}

    def _lookup_assignment(sample_id):
        direct = cluster_assignments.get(str(sample_id)) if cluster_assignments else None
        if direct is not None:
            return direct
        return normalized_assignments.get(_norm_str(sample_id), None)

    updated_count = 0
    for entry in pca_history:
        data_path = entry.get("data_path")
        try:
            run_data = load_json_file(uid, project_id, data_path)

            metadata = run_data.get("metadata") or []
            run_data["metadata"] = [
                {
                    **row,
                    cluster_col_name: _lookup_assignment(row.get("sample_id")),
                }
                for row in metadata
            ]

            metadata_columns = list(run_data.get("metadata_columns") or [])
            if cluster_col_name not in metadata_columns:
                metadata_columns.append(cluster_col_name)
            run_data["metadata_columns"] = metadata_columns

            save_json(uid, project_id, data_path, run_data)
            updated_count += 1
        except Exception:
            logger.exception("[KMeans] Failed to patch PCA run metadata")

    logger.info(f"[KMeans] Patched {updated_count} PCA run(s) with metadata column '{cluster_col_name}'")
    return updated_count


def sync_kmeans_to_pca_history(
    uid: str,
    project_id: str,
    run_id: str,
    run_name: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Optional[str]],
    run_data: Dict[str, Any],
) -> Optional[str]:
    """Save a PCA-style run derived from a KMeans save action and append/update pca_history."""
    if not run_data:
        return None

    sync_run_id = f"{run_id}_pca_sync"
    metadata = run_data.get("metadata", []) or []
    metadata_columns = list(run_data.get("metadata_columns", []) or [])
    if cluster_col_name not in metadata_columns:
        metadata_columns.append(cluster_col_name)

    normalized_assignments = {_norm_str(k): v for k, v in (cluster_assignments or {}).items()}

    def _lookup_assignment(sample_id):
        direct = cluster_assignments.get(str(sample_id)) if cluster_assignments else None
        if direct is not None:
            return direct
        return normalized_assignments.get(_norm_str(sample_id), None)

    metadata_out = []
    for row in metadata:
        sid = row.get("sample_id")
        metadata_out.append({
            **row,
            cluster_col_name: _lookup_assignment(sid),
        })

    sample_ids = run_data.get("sample_ids")
    clustering_embedding = run_data.get("clustering_embedding")
    visualization_embedding = run_data.get("visualization_embedding")
    plot_embedding = run_data.get("plot_embedding")

    if clustering_embedding is not None:
        if sample_ids is None:
            raise ValueError("KMeans run is missing sample_ids for PCA sync")
        if len(sample_ids) != len(clustering_embedding):
            raise ValueError("KMeans run has inconsistent clustering embedding data for PCA sync")

    if visualization_embedding is not None:
        if sample_ids is None:
            raise ValueError("KMeans run is missing sample_ids for visualization sync")
        if len(sample_ids) != len(visualization_embedding):
            raise ValueError("KMeans run has inconsistent visualization embedding data for PCA sync")
    if plot_embedding is not None:
        if sample_ids is None:
            raise ValueError("KMeans run is missing sample_ids for plot sync")
        if len(sample_ids) != len(plot_embedding):
            raise ValueError("KMeans run has inconsistent plot embedding data for PCA sync")

    if sample_ids is not None and visualization_embedding is not None:
        plot_points = []
        for sid, coords in zip(sample_ids, visualization_embedding):
            x = float(coords[0]) if len(coords) > 0 else 0.0
            y = float(coords[1]) if len(coords) > 1 else 0.0
            plot_points.append({
                "sample_id": sid,
                "x": x,
                "y": y,
                "cluster": _lookup_assignment(sid),
            })
    else:
        plot_points = run_data.get("plot_points", []) or []
        if not plot_points:
            raise ValueError("KMeans run has no visualization data available for PCA sync")
        reconstructed_sample_ids = [p.get("sample_id") for p in plot_points]
        if any(sid is None for sid in reconstructed_sample_ids):
            raise ValueError("KMeans run plot_points contain missing sample_id values")
        if sample_ids is None:
            sample_ids = reconstructed_sample_ids
        elif len(sample_ids) != len(reconstructed_sample_ids):
            logger.warning("[KMeans] sample_ids length mismatch with plot_points during sync, using plot_points")
            sample_ids = reconstructed_sample_ids
        visualization_embedding = [[p.get("x", 0.0), p.get("y", 0.0)] for p in plot_points]

    if clustering_embedding is None:
        clustering_embedding = visualization_embedding
    if plot_embedding is None:
        plot_embedding = visualization_embedding

    sync_data = {
        "plot_points": plot_points,
        "sample_ids": sample_ids,
        "embedding": clustering_embedding,
        "visualization_embedding": visualization_embedding,
        "plot_embedding": plot_embedding,
        "visualization_axes": run_data.get("visualization_axes", [0, 1]),
        "visualization_axis_labels": run_data.get("visualization_axis_labels", ["PC1", "PC2"]),
        "visualization_explained_variance_ratio": run_data.get("visualization_explained_variance_ratio", []),
        "metadata": metadata_out,
        "metadata_columns": metadata_columns,
        "explained_variance_ratio": run_data.get("explained_variance_ratio", []),
        "source": "kmeans_sync",
        "visualization": {"method": "pca_overlay", "dimensions": 2},
    }

    data_path = f"projects/{uid}/{project_id}/pca_runs/{sync_run_id}.json"
    save_json(uid, project_id, data_path, sync_data)

    data = get_project_data(project_id)
    if data:
        pca_history = data.get("pca_history", [])
        pca_history = [r for r in pca_history if r.get("run_id") != sync_run_id]
        pca_history.append({
            "run_id": sync_run_id,
            "name": f"KMeans -> {cluster_col_name}",
            "type": "PCA",
            "date": pd.Timestamp.utcnow().isoformat(),
            "data_path": data_path,
        })
        update_project(project_id, pca_history=pca_history)

    return data_path
