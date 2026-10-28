from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from minisom import MiniSom
from sklearn.decomposition import PCA

from services.common import *
from services.kmeans import (
    _NumpyEncoder,
    _align_sample_ids,
    _extract_run_embedding,
    _py_native,
    _norm_str,
    _to_visualization_embedding,
    save_clusters_to_meta,
    sync_cluster_column_to_existing_pca_runs,
)

logger = logging.getLogger("SOM_PIPELINE")


def save_som_run_to_storage(uid: str, project_id: str, run_id: str, data: dict) -> str:
    path = f"projects/{uid}/{project_id}/som_runs/{run_id}.json"
    save_json(uid, project_id, path, data)
    logger.info("[STORAGE] Saved SOM run")
    return path


def _load_matrix_meta(uid: str, project_id: str, matrix_path: str, meta_path: str):
    df = load_csv(uid, project_id, matrix_path, index_col=0)
    df_meta = load_csv(uid, project_id, meta_path, index_col=0)
    return df, df_meta


def _load_pca_run(uid: str, project_id: str, data_path: str) -> dict:
    return load_json_file(uid, project_id, data_path)


def _build_embedding(
    uid: str,
    project_id: str,
    input_type: str,
    pca_run_data_path: Optional[str],
    all_sample_ids: List[str],
    df_matrix: pd.DataFrame,
    df_meta: pd.DataFrame,
) -> Tuple[np.ndarray, List[float], List[str], pd.DataFrame, pd.DataFrame]:
    pca_ev: List[float] = []

    if input_type == "pca" and pca_run_data_path:
        pca_data = _load_pca_run(uid, project_id, pca_run_data_path)
        emb_array = _extract_run_embedding(pca_data)
        emb_ids = pca_data.get("sample_ids", [])
        if not emb_ids:
            raise ValueError("PCA run data missing sample_ids")
        id_to_emb = {}
        for i, sid in enumerate(emb_ids):
            key = _norm_str(sid)
            if key not in id_to_emb:
                id_to_emb[key] = emb_array[i]

        ordered_ids = _align_sample_ids(all_sample_ids, emb_ids)
        if not ordered_ids:
            raise ValueError("Selected PCA run has no overlapping samples with current matrix/meta data")

        embedding_all = np.array([id_to_emb[_norm_str(s)] for s in ordered_ids], dtype=float)
        df_meta = df_meta.loc[ordered_ids]
        df_matrix = df_matrix[ordered_ids]
        all_sample_ids = ordered_ids
        pca_ev = pca_data.get("explained_variance_ratio", [])
        return embedding_all, pca_ev, all_sample_ids, df_matrix, df_meta

    x_all = df_matrix.T.values.astype(float)
    x_all = np.nan_to_num(x_all)
    n_vis_components = min(x_all.shape[0], x_all.shape[1], 50)
    pca_model = PCA(n_components=n_vis_components, random_state=42)
    embedding_all = pca_model.fit_transform(x_all)
    pca_ev = pca_model.explained_variance_ratio_.tolist()
    return embedding_all, pca_ev, all_sample_ids, df_matrix, df_meta


def _sample_beeswarm_offsets(count: int, rng: np.random.Generator) -> List[Tuple[float, float]]:
    if count <= 0:
        return []
    if count == 1:
        return [(0.0, 0.0)]

    max_radius = 0.42
    min_distance = max(0.055, min(0.16, 0.6 * max_radius / np.sqrt(count)))
    offsets: List[Tuple[float, float]] = []
    fallback_count = 0

    for point_idx in range(count):
        placed = False
        for _ in range(120):
            angle = float(rng.uniform(0.0, 2.0 * np.pi))
            radius = max_radius * np.sqrt(float(rng.uniform(0.0, 1.0)))
            candidate = (radius * np.cos(angle), radius * np.sin(angle))
            if all(np.hypot(candidate[0] - ox, candidate[1] - oy) >= min_distance for ox, oy in offsets):
                offsets.append(candidate)
                placed = True
                break

        if placed:
            continue

        # Dense nodes fall back to a softer radial spread instead of a rigid square lattice.
        angle = float(rng.uniform(0.0, 2.0 * np.pi))
        radius = min(max_radius, 0.08 + 0.03 * fallback_count)
        fallback_count += 1
        offsets.append((radius * np.cos(angle), radius * np.sin(angle)))

    return offsets


def _compute_umatrix(som: MiniSom, x_dim: int, y_dim: int) -> List[List[float]]:
    weights = som.get_weights()
    umatrix = np.zeros((x_dim, y_dim))
    for i in range(x_dim):
        for j in range(y_dim):
            neighbors = []
            for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                ni, nj = i + di, j + dj
                if 0 <= ni < x_dim and 0 <= nj < y_dim:
                    dist = float(np.linalg.norm(weights[i, j] - weights[ni, nj]))
                    neighbors.append(dist)
            umatrix[i, j] = float(np.mean(neighbors)) if neighbors else 0.0
    return umatrix.tolist()


def run_som(
    project_id: str,
    uid: str,
    name: str,
    input_type: str,
    matrix_path: str,
    meta_path: str,
    selected_labels: List[str],
    meta_col: str,
    x_dim: int,
    y_dim: int,
    initialization: str,
    neighborhood: str,
    layout: str,
    pca_run_data_path: Optional[str] = None,
    run_new_pcas: bool = False,
) -> Dict[str, Any]:
    logger.info(f"[SOM] START | project={project_id} | name={name} | input={input_type} | grid={x_dim}x{y_dim} | run_new_pcas={run_new_pcas}")

    df_matrix, df_meta = _load_matrix_meta(uid, project_id, matrix_path, meta_path)
    metadata_columns = [c for c in df_meta.columns if c.lower() != "sample_id"]

    common = df_matrix.columns.intersection(df_meta.index)
    df_matrix = df_matrix[common]
    df_meta = df_meta.loc[common].copy()

    if not meta_col or meta_col not in df_meta.columns:
        meta_col = metadata_columns[0] if metadata_columns else ""

    all_sample_ids = list(df_meta.index)

    # --- RUN_NEW_PCAS LOGIC ---
    if run_new_pcas:
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
        x_all = df_matrix.T.values.astype(float)
        x_all = np.nan_to_num(x_all)
        n_samples, n_features = x_all.shape
        n_components = min(30, n_samples - 1, n_features)
        if n_components < 1:
            raise ValueError("Not enough samples/features for PCA.")
        pca_model = PCA(n_components=n_components, random_state=42)
        embedding_all = pca_model.fit_transform(x_all)
        pca_ev = pca_model.explained_variance_ratio_.tolist()
        # Only use selected samples for all outputs
        cluster_samples = all_sample_ids
        cluster_idx = list(range(len(all_sample_ids)))
    else:
        embedding_all, pca_ev, all_sample_ids, df_matrix, df_meta = _build_embedding(
            uid=uid,
            project_id=project_id,
            input_type=input_type,
            pca_run_data_path=pca_run_data_path,
            all_sample_ids=all_sample_ids,
            df_matrix=df_matrix,
            df_meta=df_meta,
        )
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
    x_cluster = embedding_all[cluster_idx]
    sigma = max(0.5, min(float(max(x_dim, y_dim)) / 2.0, 5.0))
    sigma = min(sigma, max(0.5, float(min(x_dim, y_dim)) - 0.5))
    som = MiniSom(
        x=max(1, int(x_dim)),
        y=max(1, int(y_dim)),
        input_len=x_cluster.shape[1],
        sigma=sigma,
        learning_rate=0.5,
        neighborhood_function=neighborhood if neighborhood in {"gaussian", "bubble"} else "gaussian",
        random_seed=42,
    )

    init_mode = (initialization or "sample").lower()
    if init_mode == "sample":
        som.random_weights_init(x_cluster)
    elif init_mode == "linear":
        try:
            som.pca_weights_init(x_cluster)
        except Exception as exc:
            logger.warning(f"[SOM] PCA weight init failed ({exc}), falling back to random")
            som.random_weights_init(x_cluster)

    n_neurons = max(1, int(x_dim) * int(y_dim))
    n_iter = max(500, min(10_000, n_neurons * 500))
    som.train_random(x_cluster, n_iter)
    umatrix = _compute_umatrix(som, max(1, int(x_dim)), max(1, int(y_dim)))

    winners = [som.winner(x_cluster[i]) for i in range(x_cluster.shape[0])]
    unique_nodes = sorted(set(winners), key=lambda n: (n[1], n[0]))
    visualization_axes = [0, 1]

    node_to_label = {node: f"Cluster {i+1}" for i, node in enumerate(unique_nodes)}
    cluster_label_map = {idx: node_to_label[winners[j]] for j, idx in enumerate(cluster_idx)}

    assignments: Dict[str, Optional[str]] = {}
    if run_new_pcas:
        # Only output selected samples
        for i, sid in enumerate(all_sample_ids):
            assignments[sid] = cluster_label_map.get(i)
    else:
        # Output all samples, non-selected = NaN
        for i, sid in enumerate(all_sample_ids):
            assignments[sid] = cluster_label_map.get(i) if i in cluster_idx else None

    clustering_embedding = embedding_all.tolist()
    visualization_embedding = _to_visualization_embedding(embedding_all, visualization_axes)

    # Build plot_points based on layout
    layout_mode = str(layout or "overlay").strip().lower()
    if layout_mode == "separate":
        # Only samples used to train the SOM are placed on the grid.
        cluster_winners_grid = winners
        node_members: Dict[Tuple[int, int], List[int]] = defaultdict(list)
        for sample_idx, node in zip(cluster_idx, cluster_winners_grid):
            node_members[node].append(sample_idx)

        rng = np.random.default_rng(42)
        point_offsets: Dict[int, Tuple[float, float]] = {}
        for node in sorted(node_members):
            indices = node_members[node]
            offsets = _sample_beeswarm_offsets(len(indices), rng)
            for sample_idx, offset in zip(indices, offsets):
                point_offsets[sample_idx] = offset

        winner_by_index = {
            sample_idx: node for sample_idx, node in zip(cluster_idx, cluster_winners_grid)
        }
        plot_points = []
        for i, sid in enumerate(all_sample_ids):
            if i in winner_by_index:
                node = winner_by_index[i]
                dx, dy = point_offsets.get(i, (0.0, 0.0))
                x = float(node[0]) + dx
                y = float(node[1]) + dy
                plot_role = "som_grid"
                plot_points.append({
                    "sample_id": sid,
                    "x": x,
                    "y": y,
                    "cluster": assignments[sid],
                    "plot_role": plot_role,
                })
        # Only include selected samples in plot_points for run_new_pcas
        if run_new_pcas:
            plot_points = [p for p in plot_points if p["sample_id"] in all_sample_ids]
    else:
        plot_points = []
        for i, sid in enumerate(all_sample_ids):
            x = float(visualization_embedding[i, 0])
            y = float(visualization_embedding[i, 1])
            plot_points.append({"sample_id": sid, "x": x, "y": y, "cluster": assignments[sid]})
        # Only include selected samples in plot_points for run_new_pcas
        if run_new_pcas:
            plot_points = [p for p in plot_points if p["sample_id"] in all_sample_ids]

    metadata_out = []
    for sid in all_sample_ids:
        row = {"sample_id": sid}
        if sid in df_meta.index:
            for col in metadata_columns:
                val = df_meta.at[sid, col]
                row[col] = None if pd.isna(val) else _py_native(val)
        row["__som_cluster__"] = assignments[sid]
        metadata_out.append(row)
    # For run_new_pcas, all_sample_ids is already filtered, so no need to filter metadata_out again

    n_clusters_found = len(unique_nodes)
    plot_embedding = [[p.get("x"), p.get("y")] for p in plot_points]
    node_counts = {
        f"{node[0]}_{node[1]}": int(sum(1 for winner in winners if winner == node))
        for node in unique_nodes
    }
    result = {
        "method": "SOM",
        "grid": {"x": int(x_dim), "y": int(y_dim)},
        "n_clusters": n_clusters_found,
        "umatrix": umatrix,
        "node_counts": node_counts,
        "input_type": input_type,
        "pca_run_data_path": pca_run_data_path or "",
        "meta_col": meta_col,
        "selected_labels": selected_labels,
        "som_params": {
            "initialization": initialization,
            "neighborhood": neighborhood,
            "layout": layout_mode,
            "iterations": n_iter,
        },
        "cluster_assignments": assignments,
        "cluster_labels": [f"Cluster {i+1}" for i in range(n_clusters_found)],
        "cluster_name_map": {f"Cluster {i+1}": f"Cluster {i+1}" for i in range(n_clusters_found)},
        "plot_points": [p for p in plot_points if assignments.get(p["sample_id"]) is not None] if run_new_pcas else plot_points,
        "original_embedding": clustering_embedding,
        "clustering_embedding": clustering_embedding,
        "visualization_embedding": visualization_embedding.tolist(),
        "plot_embedding": plot_embedding,
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
            "method": "pca" if input_type == "pca" and pca_run_data_path else "auto_pca",
            "dimensions": int(embedding_all.shape[1]),
        },
        "visualization": {
            "method": "som_grid" if layout_mode == "separate" else "pca_overlay",
            "dimensions": 2,
        },
    }

    logger.info(f"[SOM] DONE | clusters={n_clusters_found} | n_samples={len(all_sample_ids)}")
    return result


def sync_som_to_pca_history(
    uid: str,
    project_id: str,
    run_id: str,
    run_name: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Optional[str]],
    run_data: Dict[str, Any],
) -> Optional[str]:
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
    original_embedding = run_data.get("clustering_embedding")
    if original_embedding is None:
        original_embedding = run_data.get("original_embedding")
    visualization_embedding = run_data.get("visualization_embedding")
    plot_embedding = run_data.get("plot_embedding")
    layout_mode = str(((run_data.get("som_params") or {}).get("layout")) or "").strip().lower()
    if original_embedding is not None:
        if sample_ids is None:
            raise ValueError("SOM run is missing sample_ids for PCA sync")
        if len(sample_ids) != len(original_embedding):
            raise ValueError("SOM run has inconsistent original embedding data for PCA sync")
    if visualization_embedding is not None:
        if sample_ids is None:
            raise ValueError("SOM run is missing visualization sample_ids for PCA sync")
        if len(sample_ids) != len(visualization_embedding):
            raise ValueError("SOM run has inconsistent visualization embedding data for PCA sync")
    if plot_embedding is not None:
        if sample_ids is None:
            raise ValueError("SOM run is missing plot sample_ids for PCA sync")
        if len(sample_ids) != len(plot_embedding):
            raise ValueError("SOM run has inconsistent plot embedding data for PCA sync")

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
        if layout_mode == "separate":
            raise ValueError("Cannot sync a legacy separate-layout SOM run because visualization embedding is missing")
        plot_points = run_data.get("plot_points", []) or []
        if not plot_points:
            raise ValueError("SOM run has no visualization data available for PCA sync")
        reconstructed_sample_ids = [p.get("sample_id") for p in plot_points]
        if any(sid is None for sid in reconstructed_sample_ids):
            raise ValueError("SOM run plot_points contain missing sample_id values")
        visualization_embedding = [[p.get("x", 0.0), p.get("y", 0.0)] for p in plot_points]
        if sample_ids is None:
            sample_ids = reconstructed_sample_ids
        elif len(sample_ids) != len(reconstructed_sample_ids):
            logger.warning("[SOM] sample_ids length mismatch with plot_points during sync, using plot_points")
            sample_ids = reconstructed_sample_ids

    if original_embedding is None:
        original_embedding = visualization_embedding
    if plot_embedding is None:
        plot_embedding = visualization_embedding

    sync_data = {
        "plot_points": plot_points,
        "sample_ids": sample_ids,
        "embedding": original_embedding,
        "visualization_embedding": visualization_embedding,
        "plot_embedding": plot_embedding,
        "visualization_axes": run_data.get("visualization_axes", [0, 1]),
        "visualization_axis_labels": run_data.get("visualization_axis_labels", ["PC1", "PC2"]),
        "visualization_explained_variance_ratio": run_data.get("visualization_explained_variance_ratio", []),
        "metadata": metadata_out,
        "metadata_columns": metadata_columns,
        "explained_variance_ratio": run_data.get("explained_variance_ratio", []),
        "source": "som_sync",
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
            "name": f"SOM -> {cluster_col_name}",
            "type": "PCA",
            "date": pd.Timestamp.utcnow().isoformat(),
            "data_path": data_path,
        })
        update_project(project_id, pca_history=pca_history)

    return data_path


def save_som_clusters_to_meta(
    uid: str,
    project_id: str,
    meta_path: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Any],
    rename_map: Optional[Dict[str, str]] = None,
    source_col_name: Optional[str] = None,
    remove_source_when_renamed: bool = False,
) -> str:
    return save_clusters_to_meta(
        uid=uid,
        project_id=project_id,
        meta_path=meta_path,
        cluster_col_name=cluster_col_name,
        source_col_name=source_col_name,
        remove_source_when_renamed=remove_source_when_renamed,
        cluster_assignments=cluster_assignments,
        rename_map=rename_map,
    )


def patch_all_pca_runs_with_som_column(
    uid: str,
    project_id: str,
    cluster_col_name: str,
    cluster_assignments: Dict[str, Any],
) -> int:
    return sync_cluster_column_to_existing_pca_runs(
        uid=uid,
        project_id=project_id,
        cluster_col_name=cluster_col_name,
        cluster_assignments=cluster_assignments,
    )
