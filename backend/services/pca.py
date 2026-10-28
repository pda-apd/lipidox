from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from umap import UMAP
from pycombat import pycombat

from services.common import *


# ===================== LOGGER CONFIGURATION =====================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("PCA_PIPELINE")


# ===================== STORAGE INTERACTION =====================
def save_run_to_storage(uid: str, project_id: str, run_id: str, data: dict) -> str:
    start = time.time()
    logger.info("--- [STORAGE] Starting result upload ---")
    try:
        rel_path = f"pca_runs/{run_id}.json"
        save_json(uid, project_id, rel_path, data)
        full_path = f"projects/{uid}/{project_id}/{rel_path}"
        logger.info(f"[STORAGE] Upload completed in {time.time() - start:.2f}s")
        return full_path
    except Exception as e:
        logger.error(f"[STORAGE] Failed to save result: {str(e)}")
        raise


def load_run_from_storage(uid: str, project_id: str, data_path: str) -> dict:
    logger.info("--- [STORAGE] Loading run data ---")
    start = time.time()
    try:
        data = load_result_json(uid, project_id, data_path)
        logger.info(f"[STORAGE] Load completed in {time.time() - start:.2f}s")
        return data
    except Exception as e:
        logger.error(f"[STORAGE] Failed to load data: {str(e)}")
        raise


# ===================== DATA PREPROCESSING =====================
@dataclass
class RunPayload:
    matrix: List[List[float]]
    sample_ids: List[str]
    metadata: List[Dict[str, Any]]
    metadata_columns: List[str]


def _to_dataframe(payload: RunPayload) -> pd.DataFrame:
    logger.info("[DATA] Converting matrix to DataFrame...")
    x = np.asarray(payload.matrix, dtype=float)

    if x.ndim != 2:
        logger.error(f"[DATA] Matrix is not 2D! Actual shape: {x.shape}")
        raise ValueError("matrix must be 2D")

    if x.shape[0] != len(payload.sample_ids):
        logger.error(f"[DATA] Sample count mismatch! Matrix: {x.shape[0]}, SampleIDs: {len(payload.sample_ids)}")
        raise ValueError("sample_ids mismatch")

    logger.info(f"[DATA] Matrix shape: {x.shape[0]} samples × {x.shape[1]} features")
    return pd.DataFrame(x, index=payload.sample_ids)


def _safe_metadata(payload: RunPayload) -> List[Dict[str, Any]]:
    logger.info("[DATA] Processing metadata safely...")
    
    if not payload.metadata:
        logger.warning("[DATA] No metadata found, initializing default using sample IDs")
        return [{"sample_id": sid} for sid in payload.sample_ids]

    by_id = {}
    for row in payload.metadata:
        sid = row.get("sample_id")
        if sid:
            by_id[str(sid)] = row

    merged = []
    for sid in payload.sample_ids:
        row = dict(by_id.get(sid, {}))
        row["sample_id"] = sid
        merged.append(row)

    logger.info(f"[DATA] Metadata processed for {len(merged)} samples")
    return merged


def _load_from_storage(uid: str, project_id: str, matrix_path: str, meta_path: str):
    logger.info("--- [LOADER] Loading CSV data ---")
    start = time.time()

    try:
        logger.info("[LOADER] Reading matrix file")
        df = load_csv(uid, project_id, matrix_path, index_col=0)
        
        logger.info("[LOADER] Reading metadata file")
        df_meta = load_csv(uid, project_id, meta_path, index_col=0)

        sample_ids = list(df.columns)
        matrix = df.values.T.tolist()

        metadata_columns = [
            c for c in df_meta.columns
            if c.lower() != "sample_id" and c != df_meta.index.name
        ]
        
        logger.info(f"[LOADER] Metadata columns detected: {metadata_columns}")

        metadata = []
        for sid in sample_ids:
            row = {"sample_id": sid}
            if sid in df_meta.index:
                for col in metadata_columns:
                    val = df_meta.at[sid, col]
                    row[col] = None if pd.isna(val) else py_native(val)
            metadata.append(row)

        logger.info(f"[LOADER] Data loaded successfully in {time.time() - start:.2f}s | N={len(sample_ids)} samples")
        return matrix, sample_ids, metadata, metadata_columns

    except Exception as e:
        logger.error(f"[LOADER] Failed to load data: {str(e)}")
        raise


# ===================== CORE ANALYTICS: PCA =====================
def run_pca_from_paths(
    matrix_path: str,
    meta_path: str,
    uid: str,
    project_id: str,
    n_components: int,
    normalize_config: Optional[Dict[str, Any]] = None,
    batch_col: Optional[str] = None,
) -> Dict[str, Any]:
    
    logger.info("===== [PROCESS] STARTING PCA PIPELINE =====")
    
    matrix, sample_ids, metadata, metadata_columns = _load_from_storage(uid, project_id, matrix_path, meta_path)

    # --- BATCH CORRECTION (ComBat) before PCA ---
    if batch_col:
        logger.info(f"[PCA] Applying ComBat batch correction on column: {batch_col}")
        try:
            df_for_combat = pd.DataFrame(
                np.array(matrix).T,  # features × samples
                columns=sample_ids,
            )
            batch_labels = [row.get(batch_col) for row in metadata]
            if any(b is None for b in batch_labels):
                raise ValueError(f"Some samples have missing values in batch column '{batch_col}'")
            df_corrected = pycombat(df_for_combat, batch_labels)
            # Convert back to matrix (samples × features)
            matrix = df_corrected.values.T.tolist()
            logger.info("[PCA] ComBat correction applied successfully")
        except Exception as e:
            logger.error(f"[PCA] ComBat failed: {e}")
            raise

    payload = RunPayload(
        matrix=matrix,
        sample_ids=sample_ids,
        metadata=metadata,
        metadata_columns=metadata_columns,
    )

    return run_pca(payload, n_components, normalize_config)


def run_pca(
    payload: RunPayload,
    n_components: int,
    normalize_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:

    start = time.time()
    logger.info("--- [PCA] Initializing model ---")

    df = _to_dataframe(payload)

    # Impute NaN values with column median before PCA
    if df.isna().any().any():
        logger.info("[PCA] Imputing NaN values with column median")
        df = df.fillna(df.median())

    max_components = int(min(df.shape[0], df.shape[1]))
    if n_components <= 0 or n_components > max_components:
        logger.warning(f"[PCA] Invalid n_components={n_components}. Adjusted to {max_components}")
        n_components = max_components

    logger.info(f"[PCA] Running PCA (n_components={n_components})...")

    model = PCA(n_components=n_components, random_state=42)
    embedding = model.fit_transform(df.values)

    explained_variance = model.explained_variance_ratio_
    cumulative_variance = np.sum(explained_variance)
    
    logger.info(f"[PCA] Total explained variance: {cumulative_variance*100:.2f}%")
    for i, var in enumerate(explained_variance[:3]):
        logger.info(f"   > PC{i+1}: {var*100:.2f}%")

    points = [
        {
            "sample_id": sid,
            "x": float(embedding[i, 0]) if embedding.shape[1] > 0 else 0.0,
            "y": float(embedding[i, 1]) if embedding.shape[1] > 1 else 0.0,
        }
        for i, sid in enumerate(payload.sample_ids)
    ]

    logger.info(f"[PCA] Completed in {time.time() - start:.2f}s")

    return {
        "method": "PCA",
        "n_components": int(n_components),
        "explained_variance_ratio": [float(v) for v in explained_variance],
        "embedding": embedding.tolist(),
        "plot_points": points,
        "sample_ids": payload.sample_ids,
        "metadata": _safe_metadata(payload),
        "metadata_columns": payload.metadata_columns,
        "normalization": normalize_config or {},
    }


# ===================== ADVANCED ANALYTICS: UMAP =====================
def run_umap(pca_embedding, sample_ids, metadata, metadata_columns, params=None):
    start = time.time()
    logger.info("--- [UMAP] Starting dimensionality reduction ---")

    params = params or {}
    n_neighbors = int(params.get("n_neighbors", 15))
    min_dist = float(params.get("min_dist", 0.1))
    
    logger.info(f"[UMAP] Parameters: n_neighbors={n_neighbors}, min_dist={min_dist}, metric={params.get('metric', 'euclidean')}")

    x = np.asarray(pca_embedding, dtype=float)
    logger.info(f"[UMAP] Input shape: {x.shape}")

    reducer = UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        min_dist=min_dist,
        metric=str(params.get("metric", "euclidean")),
        # random_state=42,
    )

    embedding = reducer.fit_transform(x)

    logger.info(f"[UMAP] Completed in {time.time() - start:.2f}s")

    return {
        "method": "UMAP",
        "embedding": embedding.tolist(),
        "plot_points": [
            {"sample_id": sid, "x": float(embedding[i, 0]), "y": float(embedding[i, 1])}
            for i, sid in enumerate(sample_ids)
        ],
        "sample_ids": sample_ids,
        "metadata": metadata,
        "metadata_columns": metadata_columns,
    }


# ===================== ADVANCED ANALYTICS: t-SNE =====================
def run_tsne(pca_embedding, sample_ids, metadata, metadata_columns, params=None):
    start = time.time()
    logger.info("--- [t-SNE] Starting dimensionality reduction ---")

    params = params or {}
    perplexity = float(params.get("perplexity", 30))
    learning_rate = float(params.get("learning_rate", 200))
    
    logger.info(f"[t-SNE] Parameters: perplexity={perplexity}, learning_rate={learning_rate}, max_iter={params.get('max_iter', 1000)}")

    x = np.asarray(pca_embedding, dtype=float)
    logger.info(f"[t-SNE] Input shape: {x.shape}")

    if perplexity >= len(sample_ids):
        new_perp = max(len(sample_ids) - 1, 1)
        logger.warning(f"[t-SNE] Perplexity too large. Adjusted to {new_perp}")
        perplexity = new_perp

    model = TSNE(
        n_components=2,
        perplexity=perplexity,
        learning_rate=learning_rate,
        max_iter=int(params.get("max_iter", 1000)),
        random_state=42,
        init="pca",
    )

    embedding = model.fit_transform(x)

    logger.info(f"[t-SNE] Completed in {time.time() - start:.2f}s")

    return {
        "method": "tSNE",
        "embedding": embedding.tolist(),
        "plot_points": [
            {"sample_id": sid, "x": float(embedding[i, 0]), "y": float(embedding[i, 1])}
            for i, sid in enumerate(sample_ids)
        ],
        "sample_ids": sample_ids,
        "metadata": metadata,
        "metadata_columns": metadata_columns,
    }
