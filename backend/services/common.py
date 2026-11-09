"""
Shared helpers for all analysis services.

Provides local filesystem + SQLAlchemy replacements for cloud storage.
Every service imports from here for storage I/O and project state management.
"""
from __future__ import annotations

import io
import json
import logging
import time
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from scipy import stats as _scipy_stats
from sqlalchemy.orm import Session

from db import SessionLocal
from storage import (
    STORAGE_ROOT,
    csv_safe_frame,
    file_exists,
    file_url,
    read_bytes,
    read_csv,
    save_bytes,
    save_json,
    save_text,
)
from task_utils import (
    create_task,
    get_history,
    get_latest_task,
    project_to_dict,
    reserve_task_identity,
    task_to_dict,
    update_project_status,
    update_task_status,
    utc_now_iso,
)

logger = logging.getLogger("SERVICE_COMMON")


class NumpyEncoder(json.JSONEncoder):
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


def py_native(val):
    if isinstance(val, np.integer):
        return int(val)
    if isinstance(val, np.floating):
        return float(val)
    if isinstance(val, np.bool_):
        return bool(val)
    return val


def _db_session():
    return SessionLocal()


# ─── LOAD FROM STORAGE ────────────────────────────────────────────

def load_csv(uid: str, project_id: str, rel_path: str, **kwargs) -> pd.DataFrame:
    return read_csv(uid, project_id, rel_path, **kwargs)


def load_matrix_meta(uid: str, project_id: str, matrix_rel: str, meta_rel: str):
    df = load_csv(uid, project_id, matrix_rel, index_col=0)
    df_meta = load_csv(uid, project_id, meta_rel, index_col=0)
    return df, df_meta


def load_json_file(uid: str, project_id: str, rel_path: str) -> dict:
    raw = read_bytes(uid, project_id, rel_path)
    return json.loads(raw)


# ─── SAVE TO STORAGE ──────────────────────────────────────────────

def save_result_json(uid: str, project_id: str, subdir: str, run_id: str, data: dict) -> str:
    rel_path = f"{subdir}/{run_id}.json"
    save_json(uid, project_id, rel_path, data)
    return rel_path


def save_result_csv(uid: str, project_id: str, subdir: str, run_id: str, df: pd.DataFrame) -> str:
    rel_path = f"{subdir}/{run_id}.csv"
    buf = io.StringIO()
    csv_safe_frame(df).to_csv(buf)
    save_text(uid, project_id, rel_path, buf.getvalue())
    return rel_path


def save_result_text(uid: str, project_id: str, rel_path: str, text: str) -> str:
    save_text(uid, project_id, rel_path, text)
    return rel_path


def save_result_html(uid: str, project_id: str, subdir: str, run_id: str, html: str) -> str:
    rel_path = f"{subdir}/{run_id}.html"
    save_text(uid, project_id, rel_path, html)
    return rel_path


def load_result_json(uid: str, project_id: str, rel_path: str) -> dict:
    return load_json_file(uid, project_id, rel_path)


def upload_public(uid: str, project_id: str, rel_path: str, content, content_type: str = "text/plain") -> str:
    """Save content to storage and return the file URL.

    Replaces:
        blob = bucket.blob(path)
        blob.upload_from_string(content, content_type=content_type)
        blob.make_public()
        url = blob.public_url
    """
    if isinstance(content, str):
        save_text(uid, project_id, rel_path, content)
    elif isinstance(content, bytes):
        save_bytes(uid, project_id, rel_path, content)
    else:
        save_json(uid, project_id, rel_path, content)
    return file_url(uid, project_id, rel_path)


# ─── PROJECT / TASK DB HELPERS ────────────────────────────────────

# Fields that look like file paths/urls → stored in project.paths
# Note: Field names use "Path" (capital P, no underscore) e.g. matrixPath
_PATH_SUFFIXES = ("_url", "_path", "Path", "_url")

# Fields that should always go to project.extra (not paths)
_EXTRA_ONLY_KEYS = frozenset({
    "details", "integrity_report", "filtering_report", "final_feature_count",
    "meta_metadata", "normality_stat", "norm_settings", "preprocessingReport",
    "preprocessingDiagnostics", "biomarker_history", "ttest_history",
    "anova_history", "rf_history", "ttest_enrichment_history",
    "vip_combined_history", "heatmap_history",
    "ols_sample_info", "vif_warnings", "residual_normality_check",
    "ols_results", "corr_results", "roc_results",
    "uploadMode",
})


def _classify_field(key: str) -> str:
    """Decide whether a field goes to 'paths' or 'extra'."""
    if key in _EXTRA_ONLY_KEYS:
        return "extra"
    if key.endswith(_PATH_SUFFIXES):
        return "paths"
    return "extra"


def get_project(db: Session, project_id: str, user_id: Optional[str] = None):
    """Look a project up inside the current tenant.

    The authenticated user is carried in `log_uid_var` for the request and for
    any background worker started from it, so services cannot read another
    tenant's project even when a route forgets to check ownership.
    """
    from auth import log_uid_var
    from models import Project

    uid = user_id or log_uid_var.get()
    query = db.query(Project).filter(Project.id == project_id)
    if uid:
        query = query.filter(Project.user_id == uid)
    return query.first()


def get_project_data(project_id: str) -> dict:
    """Load project as a flat dict (like project data).

    Merges paths + extra into a single flat dict so that services
    can access fields like project_data["matrixNormPath"] directly.
    """
    with _db_session() as db:
        project = get_project(db, project_id)
        if project is None:
            return {}
        d = project_to_dict(project)
    # Merge paths and extra into the top level for flat access
    merged = dict(d.get("extra") or {})
    merged.update(d.get("paths") or {})
    merged["id"] = d.get("id")
    merged["name"] = d.get("name")
    merged["status"] = d.get("status")
    merged["message"] = d.get("message")
    merged["uid"] = d.get("uid")
    merged["created_at"] = d.get("created_at")
    return merged


def get_project_paths(project_id: str) -> dict:
    with _db_session() as db:
        project = get_project(db, project_id)
        if project is None:
            return {}
        return project.paths or {}


def update_project(project_id: str, **fields) -> None:
    """Update project fields (like project update).

    Automatically routes fields to paths/extra/status/message based on
    field name heuristics.
    """
    paths_update: dict = {}
    extra_update: dict = {}
    status = None
    message = None

    for key, value in fields.items():
        if key == "status":
            status = value
        elif key == "message":
            message = value
        elif _classify_field(key) == "paths":
            paths_update[key] = value
        else:
            extra_update[key] = value

    with _db_session() as db:
        update_project_status(
            db, project_id,
            status=status,
            message=message,
            paths=paths_update if paths_update else None,
            extra=extra_update if extra_update else None,
        )
        db.commit()


def set_project_status(
    project_id: str,
    status: Optional[str] = None,
    message: Optional[str] = None,
    paths: Optional[dict] = None,
    extra: Optional[dict] = None,
):
    update_project(
        project_id,
        status=status,
        message=message,
        **(paths or {}),
        **(extra or {}),
    )


# ─── TASK LIFECYCLE ───────────────────────────────────────────────

def set_task_running(
    project_id: str,
    analysis_type: str,
    run_id: str,
    task_id: Optional[int] = None,
    name: Optional[str] = None,
    config: Optional[dict] = None,
    message: str = "Running analysis.",
):
    with _db_session() as db:
        task = create_task(db, project_id, analysis_type, run_id, task_id, name, config)
        task.status = "running"
        task.message = message
        db.flush()
        from task_events import publish_task_update
        publish_task_update(
            str(project_id), str(task_id) if task_id else None,
            run_id, analysis_type, "running", message,
        )
        db.commit()
        return task_to_dict(task)


def set_task_done(
    project_id: str,
    run_id: str,
    results: Optional[dict] = None,
    message: str = "Completed successfully.",
):
    with _db_session() as db:
        update_task_status(db, project_id, run_id, "done", message, results, completed=True)
        db.commit()


def set_task_error(
    project_id: str,
    run_id: str,
    error: str,
    message: Optional[str] = None,
):
    with _db_session() as db:
        update_task_status(
            db, project_id, run_id, "error", message or error,
            completed=True,
        )
        db.commit()


def get_task_history(project_id: str, analysis_type: str, limit: int = 50) -> list[dict]:
    with _db_session() as db:
        return get_history(db, project_id, analysis_type, limit)


def get_latest_task_for(project_id: str, analysis_type: str) -> Optional[dict]:
    with _db_session() as db:
        task = get_latest_task(db, project_id, analysis_type)
        return task_to_dict(task) if task else None


def reserve_identity(project_id: str) -> dict[str, Any]:
    with _db_session() as db:
        identity = reserve_task_identity(db, project_id)
        db.commit()
        return identity


# ─── HISTORY HELPERS ──────────────────────────────────────────────

def merge_history(existing_history, entry):
    """Prepend entry, deduplicating by run_id. Prepend and dedup by run_id."""
    return [entry] + [
        item for item in (existing_history or [])
        if isinstance(item, dict) and item.get("run_id") != entry.get("run_id")
    ]


def update_project_history(project_id: str, history_key: str, entry: dict, **extra_fields):
    """Update a history array in project.extra and optionally other fields."""
    data = get_project_data(project_id)
    existing = data.get(history_key) or []
    new_history = merge_history(existing, entry)
    update_project(project_id, **{history_key: new_history, **extra_fields})


def make_json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: make_json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [make_json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [make_json_safe(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        return value if np.isfinite(value) else None
    return value


# ─── BUILD TASK PAYLOAD (compat with original services) ───────────

def build_task_payload(base_payload, status, message, *, started_at=None, completed_at=None, extra=None):
    """Build a task status dict matching the expected structure."""
    now_iso = utc_now_iso()
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


def heartbeat_task(project_id: str, task_field: str, task_payload: dict):
    """Update a task status field in project.extra (for SSE polling fallback)."""
    update_project(project_id, **{task_field: task_payload})


# ?? S-plot helpers (shared by PLS-DA / OPLS-DA) ?????????????????????????
def splot_scaled_x(x, method: str = "pareto"):
    """Scale X for the S-plot covariance axis.

    method:
      "pareto" -> (x - mean) / sqrt(std)   (default)
      "auto"   -> (x - mean) / std          (Z-score)
      "none"   -> x (no scaling; np.cov centers internally)
    NOTE: this scales the matrix ALREADY produced by the normalize step.
    If normalize already applied a scaling, choose "none" here to avoid
    double-scaling.
    """
    x = np.asarray(x, dtype=float)
    mean = np.mean(x, axis=0)
    std = np.std(x, axis=0, ddof=0)
    std_safe = np.where(std > 0, std, 1.0)
    m = str(method).lower()
    if m == "auto":
        return (x - mean) / std_safe
    if m == "pareto":
        return (x - mean) / np.sqrt(std_safe)
    return x  # none


def splot_correlation(col, t, method: str = "spearman"):
    """Correlation for the S-plot y-axis. method: 'spearman' (default) | 'pearson'."""
    m = str(method).lower()
    if m == "pearson":
        return float(_scipy_stats.pearsonr(col, t)[0])
    rho = _scipy_stats.spearmanr(col, t)
    return float(rho[0] if isinstance(rho, (tuple, list)) else rho.correlation)
