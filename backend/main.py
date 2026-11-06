from __future__ import annotations

import asyncio
import collections
import contextvars
import json
import logging
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Any, Dict, List, Optional

from auth import (
    create_access_token,
    get_current_user,
    hash_password,
    log_uid_var,
    verify_password,
)
from config import get_settings
from db import Base, engine, get_db_dep
from models import Project, User
from storage import (
    delete_file,
    delete_project_files,
    file_exists,
    project_root,
    read_bytes,
    save_bytes,
    save_text,
)
from task_events import publish_task_update, subscribe, unsubscribe
from task_utils import (
    get_history,
    project_to_dict,
    reserve_task_identity,
    task_to_dict,
    utc_now_iso,
)


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


def numpy_response(data: dict) -> JSONResponse:
    return JSONResponse(content=json.loads(json.dumps(data, cls=NumpyEncoder)))


settings = get_settings()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("API")

for stream_name in ("stdout", "stderr"):
    stream = getattr(sys, stream_name, None)
    if hasattr(stream, "reconfigure"):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

# Per-account log ring buffer + subscribers. Each entry is (uid, message) so the
# /log-stream SSE endpoint can replay/forward only the records that belong to
# the requesting user's account.
log_buffer = collections.deque(maxlen=200)
log_subscribers: list[tuple[str, asyncio.Queue]] = []


class _UidLogFilter(logging.Filter):
    """Tag every log record with the current request's user id (from contextvar)
    so the SSE handler can route it to the right account's stream."""

    def filter(self, record):
        record.uid = log_uid_var.get()
        return True


class SSELogHandler(logging.Handler):
    def emit(self, record):
        uid = getattr(record, "uid", None)
        msg = self.format(record)
        log_buffer.append((uid, msg))
        for sub_uid, q in list(log_subscribers):
            if sub_uid == uid:
                try:
                    q.put_nowait(msg)
                except Exception:
                    pass


sse_handler = SSELogHandler()
sse_handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s"))
sse_handler.addFilter(_UidLogFilter())
logging.getLogger().addHandler(sse_handler)

executor = ThreadPoolExecutor(max_workers=settings.max_workers)

# ─── IMPORT SERVICES ──────────────────────────────────────────────
from services.validator import process_integrity_check, process_meta_check, save_checked_meta
from services.preprocessing import PREPROCESS_MODE, process_preprocessing_portal
from services.matrixcheck import process_matrix_filtering
from services.normalize import process_normalization
from services.heatmapEpress import generate_heatmap_epress
from services.heatmap import render_heatmap_html
from services.biomarker import (
    run_ols_discovery,
    run_correlation_analysis,
    run_roc_analysis,
    get_lipid_progression_data,
)
from services.t_test import run_univariate_analysis
from services.enrichment import get_available_enrichment_databases, run_ttest_enrichment, run_ttest_enrichment_ora
from services.anova import run_anova_analysis
from services.random_forest import run_random_forest_analysis
from services.svm import run_svm_analysis
from services.pca import run_pca, run_pca_from_paths, run_tsne, run_umap, save_run_to_storage, load_run_from_storage
from services.kmeans import (
    run_kmeans,
    save_clusters_to_meta,
    save_kmeans_run_to_storage,
    sync_kmeans_to_pca_history,
    delete_meta_columns,
    create_meta_column,
    reorder_meta_groups,
    rename_meta_column,
)
from services.som import (
    run_som,
    save_som_run_to_storage,
    save_som_clusters_to_meta,
    sync_som_to_pca_history,
)
from services.plsda import (
    run_plsda_from_paths,
    run_plsda_permutation_checking_from_paths,
    run_plsda_cvanova_checking_from_paths,
)
from services.oplsda import (
    run_oplsda_from_paths,
    run_oplsda_permutation_checking_from_paths,
    run_oplsda_cvanova_checking_from_paths,
)
from services.splsda import run_splsda_from_paths
from services.vip_combined import run_vip_combined
from services.idconvert import convert_ids, RESULT_COLUMNS as IDCONVERT_COLUMNS, CSV_FIELDS as IDCONVERT_CSV_FIELDS
from services.lipid_enrichment import (
    get_lipid_characteristics,
    run_ttest_enrichment_lipid,
    _extract_feature_stats,
    _annotate,
    MAPPING_FRACTION_THRESHOLD,
)
from services.enrichment import _load_source_ttest_run
from services.network_run import run_network, r_available

app = FastAPI(title="LipidPortal API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _no_cache_static_assets(request, call_next):
    """Portal UI changes ship immediately: HTML pages and /src assets are
    always revalidated against the server (ETag/Last-Modified ⇒ cheap 304
    when unchanged, fresh copy after every deploy)."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith(".html") or p.startswith("/src/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


EXAMPLE_PROJECT_TTL_HOURS = 24


def _seed_example_data():
    """Copy bundled example CSVs (backend/example_seed/Example) into the
    storage volume on first boot so a fresh zip/deploy has working examples."""
    import shutil
    from pathlib import Path

    src = Path(__file__).parent / "example_seed" / "Example"
    dst = settings.storage_root_path / "Example"
    if not src.is_dir():
        return
    copied = 0
    for f in src.rglob("*.csv"):
        target = dst / f.relative_to(src)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
            copied += 1
    if copied:
        logger.info("Seeded %d example file(s) into %s", copied, dst)


def _cleanup_example_projects(db: Session, user: Optional[User] = None) -> int:
    """Auto-delete example projects older than EXAMPLE_PROJECT_TTL_HOURS
    (they carry extra.is_example = true) to keep the DB/storage tidy."""
    from storage import delete_project_files

    cutoff = datetime.now(timezone.utc) - timedelta(hours=EXAMPLE_PROJECT_TTL_HOURS)
    q = db.query(Project)
    if user is not None:
        q = q.filter(Project.user_id == user.id)
    stale = []
    for p in q.all():
        extra = p.extra or {}
        created = p.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if extra.get("is_example") and created and created < cutoff:
            stale.append(p)
    for p in stale:
        try:
            delete_project_files(str(p.user_id), str(p.id))
            db.delete(p)
        except Exception:
            logger.exception("Failed to auto-delete stale example project %s", p.id)
    if stale:
        db.commit()
        logger.info("Auto-deleted %d example project(s) older than %sh", len(stale), EXAMPLE_PROJECT_TTL_HOURS)
    return len(stale)


@app.on_event("startup")
async def startup():
    Base.metadata.create_all(bind=engine)
    from backup_service import start_backup_scheduler
    _seed_example_data()
    start_backup_scheduler()
    try:
        with Session(engine) as db:
            _cleanup_example_projects(db)
    except Exception:
        logger.exception("Example-project cleanup on startup failed")


@app.on_event("shutdown")
async def shutdown():
    from backup_service import stop_backup_scheduler
    stop_backup_scheduler()
    executor.shutdown(wait=False)


# ─── DB INIT HELPER ───────────────────────────────────────────────
def init_db():
    Base.metadata.create_all(bind=engine)


def _run_in_background(func, *args, **kwargs):
    import functools
    # Copy the current context so per-request contextvars (e.g. log_uid_var,
    # used to route /log-stream output per account) propagate into the worker
    # thread. asyncio.run_in_executor does NOT copy context automatically.
    ctx = contextvars.copy_context()
    loop = asyncio.get_event_loop()
    if kwargs:
        func = functools.partial(func, *args, **kwargs)
        args = ()
    loop.run_in_executor(executor, lambda: ctx.run(func, *args))


def _resolve_run_id(prefix: str, project_id: str, user_id: str, name: str, requested: Optional[str] = None) -> str:
    import hashlib
    if requested:
        return requested
    h = hashlib.md5(f"{prefix}_{project_id}_{user_id}_{name}".encode()).hexdigest()[:8]
    return f"{prefix}_{h}"


# ═══════════════════════════════════════════════════════════════
# AUTH ENDPOINTS
# ═══════════════════════════════════════════════════════════════

class RegisterRequest(BaseModel):
    email: str
    password: str


@app.post("/auth/register")
async def register(req: RegisterRequest, db: Session = Depends(get_db_dep)):
    existing = db.query(User).filter(User.email == req.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=req.email.lower(),
        password_hash=hash_password(req.password),
        role_id=2,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token(user.id, user.email)
    return {
        "status": "ok",
        "token": token,
        "user": {"id": str(user.id), "email": user.email, "role_id": user.role_id},
    }


@app.post("/auth/login")
async def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db_dep)):
    user = db.query(User).filter(User.email == form.username.lower()).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user.id, user.email)
    return {
        "status": "ok",
        "token": token,
        "user": {"id": str(user.id), "email": user.email, "role_id": user.role_id},
    }


class LoginJsonRequest(BaseModel):
    email: str
    password: str


@app.post("/auth/login-json")
async def login_json(req: LoginJsonRequest, db: Session = Depends(get_db_dep)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user.id, user.email)
    return {
        "status": "ok",
        "token": token,
        "user": {"id": str(user.id), "email": user.email, "role_id": user.role_id},
    }


@app.get("/auth/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "id": str(user.id),
        "email": user.email,
        "role_id": user.role_id,
    }


# ═══════════════════════════════════════════════════════════════
# PROJECT ENDPOINTS
# ═══════════════════════════════════════════════════════════════

class ProjectCreateRequest(BaseModel):
    name: str


@app.post("/projects")
async def create_project(req: ProjectCreateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = Project(user_id=user.id, name=req.name, paths={}, extra={})
    db.add(project)
    db.commit()
    db.refresh(project)
    project_root(str(user.id), str(project.id))
    return project_to_dict(project, user_id=str(user.id))


@app.get("/projects")
async def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    _cleanup_example_projects(db, user=user)
    projects = db.query(Project).filter(Project.user_id == user.id).order_by(Project.created_at.desc()).all()
    return [project_to_dict(p, user_id=str(user.id)) for p in projects]


@app.get("/projects/{project_id}")
async def get_project_endpoint(project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    d = project_to_dict(project, user_id=str(user.id), include_tasks=True)
    return d


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    count = delete_project_files(str(user.id), str(project.id))
    db.delete(project)
    db.commit()
    return {"status": "ok", "deleted_files": count}


@app.patch("/projects/{project_id}")
async def update_project(
    project_id: str,
    updates: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_dep),
):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if "name" in updates:
        project.name = updates["name"]
    if "paths" in updates:
        merged = dict(project.paths or {})
        merged.update(updates["paths"])
        project.paths = merged
    if "extra" in updates:
        merged = dict(project.extra or {})
        merged.update(updates["extra"])
        project.extra = merged
    if "status" in updates:
        project.status = updates["status"]
    db.commit()
    db.refresh(project)
    return project_to_dict(project, user_id=str(user.id))


# ═══════════════════════════════════════════════════════════════
# FILE UPLOAD / DOWNLOAD
# ═══════════════════════════════════════════════════════════════

@app.post("/upload/{project_id}")
async def upload_file(
    project_id: str,
    kind: str = Form(...),
    file: UploadFile = File(...),
    path: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_dep),
):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    content = await file.read()
    # If the client supplied a relative path (subdirectory + filename), honour it
    # so auxiliary files (e.g. mutilgroup/anova_manual_meta_*.csv) land where the
    # analysis service will later read them. Otherwise fall back to the bare
    # uploaded filename at the project root.
    rel_path = (path or file.filename or f"{kind}.csv").strip().lstrip("/")
    save_bytes(str(user.id), str(project.id), rel_path, content)

    # Only register root-level files (no subdirectory) as project path fields.
    # Files saved into a subdirectory are auxiliary results / manual inputs and
    # must NOT overwrite the main matrixPath/metaPath/etc.
    is_root_file = "/" not in rel_path
    if is_root_file:
        path_key_map = {
            "matrix": "matrixPath",
            "matrix_raw": "matrixRawPath",
            "metadata": "metaPath",
            "nist": "nistPath",
            "is": "isPath",
        }
        path_key = path_key_map.get(kind, f"{kind}Path")
        merged = dict(project.paths or {})
        merged[path_key] = rel_path
        project.paths = merged
        db.commit()
        return {"status": "ok", "path": rel_path, "path_key": path_key}

    return {"status": "ok", "path": rel_path, "path_key": None}


@app.get("/files/{file_path:path}")
async def serve_file(file_path: str, user: User = Depends(get_current_user)):
    from pathlib import Path
    from config import get_settings
    s = get_settings()
    full = (s.storage_root_path / file_path).resolve()
    root = s.storage_root_path.resolve()
    try:
        full.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    if not full.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    parts = file_path.split("/")
    # Allow shared Example/ files (read-only, accessible to all authenticated users)
    if parts[0] == "Example":
        return FileResponse(str(full))
    # Project files must belong to the authenticated user
    if len(parts) < 3 or parts[0] != "projects" or parts[1] != str(user.id):
        raise HTTPException(status_code=403, detail="Access denied")
    return FileResponse(str(full))


# ═══════════════════════════════════════════════════════════════
# ID CONVERSION (offline LipidSigR annotations + pygoslin)
# ═══════════════════════════════════════════════════════════════

class IdConvertRequest(BaseModel):
    names: Optional[List[str]] = None            # pasted lipid names
    project_id: Optional[str] = None             # or pull features from a project matrix
    matrix_path: Optional[str] = None


_IDCONVERT_EXPORTS = "exports/idconvert"


@app.post("/idconvert")
async def idconvert_endpoint(req: IdConvertRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    names: List[str] = []
    if req.names:
        names = [n for n in req.names if str(n).strip()]
    elif req.project_id and req.matrix_path:
        from services.common import load_csv
        df = load_csv(uid, req.project_id, req.matrix_path, index_col=0)
        names = [str(n) for n in df.index.tolist()]
    if not names:
        raise HTTPException(status_code=400, detail="Provide 'names' or project_id + matrix_path.")

    result = convert_ids(names)

    # Persist full result CSV for download (shared exports dir, auth-gated).
    export_dir = (settings.storage_root_path / _IDCONVERT_EXPORTS)
    export_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    pd.DataFrame(
        [r.get("_csv", {}) for r in result["rows"]],
        columns=list(IDCONVERT_CSV_FIELDS),
    ).to_csv(export_dir / f"{token}.csv", index=False)

    return {
        "status": "ok",
        "stats": result["stats"],
        "warnings": result["warnings"],
        "rows": [
            {k: v for k, v in r.items() if not k.startswith("_")}
            for r in result["rows"][:500]        # preview cap; download has all rows
        ],
        "total_rows": len(result["rows"]),
        "download_token": token,
    }


@app.get("/idconvert/download/{token}")
async def idconvert_download(token: str, user: User = Depends(get_current_user)):
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise HTTPException(status_code=400, detail="Invalid token")
    path = (settings.storage_root_path / _IDCONVERT_EXPORTS / f"{token}.csv").resolve()
    exports_root = (settings.storage_root_path / _IDCONVERT_EXPORTS).resolve()
    try:
        path.relative_to(exports_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Export expired or not found")
    return FileResponse(str(path), filename="id_conversion.csv", media_type="text/csv")


# ═══════════════════════════════════════════════════════════════
# SSE ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.get("/log-stream")
async def log_stream(user: User = Depends(get_current_user)):
    uid = str(user.id)
    q: asyncio.Queue = asyncio.Queue()
    log_subscribers.append((uid, q))

    async def event_generator():
        try:
            for entry_uid, msg in list(log_buffer):
                if entry_uid == uid:
                    yield f"data: {msg}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield "data: [keepalive]\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if (uid, q) in log_subscribers:
                log_subscribers.remove((uid, q))

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/tasks/{project_id}/events")
async def task_events(project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    q = subscribe()

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'connected', 'project_id': project_id})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            unsubscribe(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ═══════════════════════════════════════════════════════════════
# ANALYSIS TASK PREPARE
# ═══════════════════════════════════════════════════════════════

class AnalysisTaskPrepareRequest(BaseModel):
    project_id: str
    analysis_key: Optional[str] = None


@app.post("/analysis-task/prepare")
async def analysis_task_prepare(req: AnalysisTaskPrepareRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    db.commit()
    return {
        "status": "ok",
        "run_id": identity["run_id"],
        "task_id": identity["task_id"],
        "started_at": utc_now_iso(),
        "analysis_key": req.analysis_key,
    }


# ═══════════════════════════════════════════════════════════════
# VALIDATION / PREPROCESSING
# ═══════════════════════════════════════════════════════════════

class ValidationRequest(BaseModel):
    project_id: str
    upload_mode: Optional[str] = None
    matrix_path: Optional[str] = None
    matrix_raw_path: Optional[str] = None
    nist_path: Optional[str] = None
    is_path: Optional[str] = None
    meta_path: str


@app.post("/validate")
async def validate_data(req: ValidationRequest, background_tasks: BackgroundTasks, user: User = Depends(get_current_user)):
    uid = str(user.id)
    if req.upload_mode == PREPROCESS_MODE:
        if not req.matrix_raw_path or not req.nist_path or not req.is_path:
            raise HTTPException(status_code=400, detail="Preprocessing mode requires matrix_raw_path, nist_path, and is_path.")
        _run_in_background(
            process_preprocessing_portal,
            req.project_id, req.matrix_raw_path, req.meta_path, req.nist_path, req.is_path, uid,
        )
        return {"status": "processing_preprocessing"}

    if not req.matrix_path:
        raise HTTPException(status_code=400, detail="matrix_path is required for the standard upload mode.")

    _run_in_background(process_integrity_check, req.project_id, uid, req.matrix_path, req.meta_path)
    return {"status": "processing_integrity"}


class MetaCheckRequest(BaseModel):
    project_id: str
    meta_path: str


@app.post("/meta-check")
async def meta_check(req: MetaCheckRequest, background_tasks: BackgroundTasks, user: User = Depends(get_current_user)):
    uid = str(user.id)
    _run_in_background(process_meta_check, req.project_id, uid, req.meta_path)
    return {"status": "processing_meta_scan"}


class MetaSaveRequest(BaseModel):
    project_id: str
    meta_path: str
    changes: Dict[str, Any]


@app.post("/save-checked-meta")
async def apply_meta_changes(req: MetaSaveRequest, background_tasks: BackgroundTasks, user: User = Depends(get_current_user)):
    uid = str(user.id)
    _run_in_background(save_checked_meta, req.project_id, uid, req.meta_path, req.changes)
    return {"status": "saving_meta_changes"}


# ═══════════════════════════════════════════════════════════════
# MATRIX FILTER / NORMALIZE
# ═══════════════════════════════════════════════════════════════

class FilterRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    settings: Dict[str, Any]


@app.post("/matrix-filter")
async def filter_matrix(req: FilterRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    _run_in_background(process_matrix_filtering, req.project_id, uid, req.matrix_path, req.meta_path, req.settings)
    return {"status": "processing_matrix_filtering"}


class NormalizeRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    settings: dict


@app.post("/normalize")
async def normalize_endpoint(req: NormalizeRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    _run_in_background(process_normalization, req.project_id, uid, req.matrix_path, req.meta_path, req.settings)
    return {"status": "processing", "message": "Normalization task started."}


# ═══════════════════════════════════════════════════════════════
# HEATMAP
# ═══════════════════════════════════════════════════════════════

class HeatmapRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    settings: Dict[str, Any]
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/generate-heatmap")
async def heatmap_endpoint(req: HeatmapRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    _run_in_background(
        generate_heatmap_epress, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, req.run_id, req.task_id
    )
    return {"status": "processing_heatmap", "run_id": req.run_id, "task_id": req.task_id}


class HeatmapRenderRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    settings: Dict[str, Any]
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/heatmap/render")
async def heatmap_render_endpoint(req: HeatmapRenderRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        payload = render_heatmap_html(
            project_id=req.project_id, uid=uid,
            matrix_path=req.matrix_path, meta_path=req.meta_path, settings=req.settings,
        )
        return {"status": "success", "run_id": req.run_id, "task_id": req.task_id, **payload}
    except Exception as exc:
        logger.exception("Heatmap render failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ═══════════════════════════════════════════════════════════════
# BIOMARKER
# ═══════════════════════════════════════════════════════════════

class StandardRequest(BaseModel):
    project_id: str
    run_id: Optional[str] = None
    matrix_path: Optional[str] = None
    meta_path: Optional[str] = None
    settings: Dict[str, Any]


class BiomarkerRequest(StandardRequest):
    pass


class LipidProgressionRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    settings: Dict[str, Any]


@app.post("/biomarker-ols")
async def biomarker_ols(req: BiomarkerRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_ols_discovery, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_ols", "run_id": run_id, "task_id": task_id}


@app.post("/biomarker-corr")
async def biomarker_correlation(req: BiomarkerRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_correlation_analysis, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_correlation", "run_id": run_id, "task_id": task_id}


@app.post("/biomarker-roc")
async def biomarker_roc(req: BiomarkerRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_roc_analysis, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_roc", "run_id": run_id, "task_id": task_id}


@app.post("/biomarker-lipid-progression")
async def biomarker_lipid_progression(req: LipidProgressionRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = get_lipid_progression_data(uid, req.project_id, req.matrix_path, req.meta_path, req.settings)
        return numpy_response({"status": "ok", "data": result})
    except Exception as e:
        logger.exception("Lipid progression failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/biomarker-univariate")
async def univariate_analysis(req: StandardRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_univariate_analysis, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_univariate_analysis", "run_id": run_id, "task_id": task_id}


@app.post("/biomarker-anova")
async def anova_analysis(req: StandardRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_anova_analysis, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_anova_analysis", "run_id": run_id, "task_id": task_id}


# ═══════════════════════════════════════════════════════════════
# ENRICHMENT
# ═══════════════════════════════════════════════════════════════

class EnrichmentRequest(BaseModel):
    project_id: str
    settings: Dict[str, Any]


@app.get("/ttest/enrichment/databases")
async def enrichment_databases(user: User = Depends(get_current_user)):
    return {"status": "ok", "databases": get_available_enrichment_databases()}


@app.post("/ttest/enrichment/run")
async def ttest_enrichment_run(req: EnrichmentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_ttest_enrichment, project_id=req.project_id, uid=uid, settings=req.settings, run_id=run_id, task_id=task_id
    )
    return {"status": "processing_ttest_enrichment", "run_id": run_id, "task_id": task_id}


@app.post("/ttest/enrichment/run-ora")
async def ttest_enrichment_run_ora(req: EnrichmentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_ttest_enrichment_ora, project_id=req.project_id, uid=uid, settings=req.settings, run_id=run_id, task_id=task_id
    )
    return {"status": "processing_ttest_enrichment_ora", "run_id": run_id, "task_id": task_id}


@app.get("/lipidref/characteristics")
async def lipidref_characteristics(user: User = Depends(get_current_user)):
    return {"status": "ok", "characteristics": get_lipid_characteristics()}


class LipidMappingCheckRequest(BaseModel):
    project_id: str
    source_run_id: Optional[str] = None


@app.post("/lipidref/check-mapping")
async def lipidref_check_mapping(req: LipidMappingCheckRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    """Synchronous pre-flight: how many DAL features map to lipid IDs.

    Used by the UI to warn before running lipid enrichment / network.
    Hard rule: below 50% mappable -> `ok: false` and callers must block.
    """
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = str(user.id)
    try:
        _, source_entry = _load_source_ttest_run(uid, req.project_id, source_run_id=req.source_run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    stats_rows = _extract_feature_stats(source_entry.get("results") or [])
    features = [r["Feature"] for r in stats_rows]
    if not features:
        raise HTTPException(status_code=400, detail="Selected DAL run has no features.")
    anno = _annotate(features)
    mapped_mask = (anno["Matched.Name"] != "") | (anno["LION_ID"] != "")
    mapped = int(mapped_mask.sum())
    total = len(anno)
    fraction = mapped / total if total else 0.0
    return {
        "status": "ok",
        "total": total,
        "mapped": mapped,
        "fraction": round(fraction, 4),
        "threshold": MAPPING_FRACTION_THRESHOLD,
        "ok": fraction >= MAPPING_FRACTION_THRESHOLD,
        "unmapped_examples": anno.loc[~mapped_mask, "Input.Name"].head(20).tolist(),
    }


@app.post("/ttest/enrichment/run-lipid")
async def ttest_enrichment_run_lipid(req: EnrichmentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    _run_in_background(
        run_ttest_enrichment_lipid, project_id=req.project_id, uid=uid, settings=req.settings, run_id=run_id, task_id=task_id
    )
    return {"status": "processing_ttest_enrichment_lipid", "run_id": run_id, "task_id": task_id}


# ═══════════════════════════════════════════════════════════════
# NETWORKS (LipidSigR: pathway activity / GATOM; needs Rscript)
# ═══════════════════════════════════════════════════════════════

class NetworkRunRequest(BaseModel):
    project_id: str
    settings: Dict[str, Any]


@app.get("/network/availability")
async def network_availability(user: User = Depends(get_current_user)):
    return {"status": "ok", **r_available()}


@app.post("/network/run")
async def network_run_endpoint(req: NetworkRunRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    availability = r_available()
    if not availability["available"]:
        raise HTTPException(
            status_code=501,
            detail="R/LipidSigR is not available on this server, so the network module is disabled. "
                   "Set RSCRIPT_PATH or install R + LipidSigR.",
        )
    identity = reserve_task_identity(db, str(project.id))
    db.commit()

    _run_in_background(
        run_network, project_id=req.project_id, uid=str(user.id), settings=req.settings,
        run_id=identity["run_id"], task_id=identity["task_id"],
    )
    return {"status": "processing_network", "run_id": identity["run_id"], "task_id": identity["task_id"]}


# ═══════════════════════════════════════════════════════════════
# RANDOM FOREST / SVM
# ═══════════════════════════════════════════════════════════════

@app.post("/random-forest/run")
async def random_forest_run(req: StandardRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    model_type = str(req.settings.get("model_type") or "rf").strip().lower()
    runner = run_svm_analysis if model_type == "svm" else run_random_forest_analysis
    _run_in_background(
        runner, req.project_id, uid, req.matrix_path, req.meta_path, req.settings, run_id, task_id
    )
    return {"status": "processing_random_forest_analysis", "run_id": run_id, "task_id": task_id}


# ═══════════════════════════════════════════════════════════════
# PCA / UMAP / TSNE
# ═══════════════════════════════════════════════════════════════

class PCARunRequest(BaseModel):
    project_id: str
    name: str
    n_components: int
    matrix_path: str
    meta_path: str
    normalization: Dict[str, Any] = {}
    batch_col: Optional[str] = None
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/pca/run")
async def pca_run(req: PCARunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_pca_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            n_components=req.n_components, normalize_config=req.normalization, batch_col=req.batch_col,
        )
        run_id = _resolve_run_id("pca", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "PCA", "name": req.name,
            "config": {"n_components": req.n_components, "normalization": req.normalization},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("PCA run failed")
        raise HTTPException(status_code=400, detail=str(e))


class EmbeddingRunRequest(BaseModel):
    project_id: str
    name: str
    parent_pca_run_id: str
    pca_embedding: List[List[float]]
    sample_ids: List[str]
    metadata: List[Dict[str, Any]] = []
    metadata_columns: List[str] = []
    params: Dict[str, Any] = {}
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/pca/run-umap")
async def pca_run_umap(req: EmbeddingRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_umap(req.pca_embedding, req.sample_ids, req.metadata, req.metadata_columns, req.params)
        run_id = _resolve_run_id("umap", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "UMAP", "name": req.name,
            "parent_pca_run_id": req.parent_pca_run_id, "config": {"params": req.params},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("UMAP run failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/pca/run-tsne")
async def pca_run_tsne(req: EmbeddingRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_tsne(req.pca_embedding, req.sample_ids, req.metadata, req.metadata_columns, req.params)
        run_id = _resolve_run_id("tsne", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "tSNE", "name": req.name,
            "parent_pca_run_id": req.parent_pca_run_id, "config": {"params": req.params},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("t-SNE run failed")
        raise HTTPException(status_code=400, detail=str(e))


class LoadRunRequest(BaseModel):
    project_id: str
    data_path: str


@app.post("/pca/load-run")
async def pca_load_run(req: LoadRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        data = load_run_from_storage(uid, req.project_id, req.data_path)
        return JSONResponse(content=data)
    except Exception as e:
        logger.exception("Load run failed")
        raise HTTPException(status_code=404, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# PLS-DA
# ═══════════════════════════════════════════════════════════════

class PLSDARunRequest(BaseModel):
    project_id: str
    name: str
    matrix_path: str
    meta_path: str
    target_meta: str
    n_components: int = 2
    cv_folds: int = 5
    normalization: Dict[str, Any] = {}
    selected_groups: Optional[List[str]] = None
    s_plot_corr: str = "spearman"
    s_plot_scale: str = "pareto"
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/plsda/run")
async def plsda_run(req: PLSDARunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_plsda_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_components=req.n_components, cv_folds=req.cv_folds,
            normalize_config=req.normalization, selected_groups=req.selected_groups,
            s_plot_corr=req.s_plot_corr, s_plot_scale=req.s_plot_scale,
        )
        run_id = _resolve_run_id("plsda", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "PLS-DA", "name": req.name,
            "config": {"target_meta": req.target_meta, "n_components": req.n_components, "cv_folds": req.cv_folds,
                       "normalization": req.normalization, "selected_groups": req.selected_groups or [],
                       "s_plot_corr": req.s_plot_corr, "s_plot_scale": req.s_plot_scale},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("PLS-DA run failed")
        raise HTTPException(status_code=400, detail=str(e))


class CheckingRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    target_meta: str
    n_components: int = 2
    cv_folds: int = 5
    n_permutations: int = 100
    selected_groups: Optional[List[str]] = None


@app.post("/plsda/run-checking/permutation")
async def plsda_permutation(req: CheckingRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_plsda_permutation_checking_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_components=req.n_components, cv_folds=req.cv_folds,
            n_permutations=req.n_permutations, selected_groups=req.selected_groups,
        )
        return numpy_response({"status": "ok", "data": result})
    except Exception as e:
        logger.exception("PLS-DA permutation failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/plsda/run-checking/cv-anova")
async def plsda_cvanova(req: CheckingRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_plsda_cvanova_checking_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_components=req.n_components, cv_folds=req.cv_folds,
            selected_groups=req.selected_groups,
        )
        return numpy_response({"status": "ok", "data": result})
    except Exception as e:
        logger.exception("PLS-DA CV-ANOVA failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/plsda/load-run")
async def plsda_load_run(req: LoadRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        data = load_run_from_storage(uid, req.project_id, req.data_path)
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# OPLS-DA
# ═══════════════════════════════════════════════════════════════

class OPLSDARunRequest(BaseModel):
    project_id: str
    name: str
    matrix_path: str
    meta_path: str
    target_meta: str
    n_orthogonal: int = 0
    cv_folds: int = 5
    normalization: Dict[str, Any] = {}
    selected_groups: Optional[List[str]] = None
    s_plot_corr: str = "spearman"
    s_plot_scale: str = "pareto"
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/oplsda/run")
async def oplsda_run(req: OPLSDARunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_oplsda_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_orthogonal=req.n_orthogonal, cv_folds=req.cv_folds,
            normalize_config=req.normalization, selected_groups=req.selected_groups,
            s_plot_corr=req.s_plot_corr, s_plot_scale=req.s_plot_scale,
        )
        run_id = _resolve_run_id("oplsda", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "OPLS-DA", "name": req.name,
            "config": {"target_meta": req.target_meta, "n_predictive": 1, "n_orthogonal": req.n_orthogonal,
                       "cv_folds": req.cv_folds, "normalization": req.normalization, "selected_groups": req.selected_groups or [],
                       "s_plot_corr": req.s_plot_corr, "s_plot_scale": req.s_plot_scale},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("OPLS-DA run failed")
        raise HTTPException(status_code=400, detail=str(e))


class OPLSDACheckingRequest(BaseModel):
    project_id: str
    matrix_path: str
    meta_path: str
    target_meta: str
    n_orthogonal: int = 0
    cv_folds: int = 5
    n_permutations: int = 100
    selected_groups: Optional[List[str]] = None


@app.post("/oplsda/run-checking/permutation")
async def oplsda_permutation(req: OPLSDACheckingRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_oplsda_permutation_checking_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_orthogonal=req.n_orthogonal, cv_folds=req.cv_folds,
            n_permutations=req.n_permutations, selected_groups=req.selected_groups,
        )
        return numpy_response({"status": "ok", "data": result})
    except Exception as e:
        logger.exception("OPLS-DA permutation failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/oplsda/run-checking/cv-anova")
async def oplsda_cvanova(req: OPLSDACheckingRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_oplsda_cvanova_checking_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, n_orthogonal=req.n_orthogonal, cv_folds=req.cv_folds,
            selected_groups=req.selected_groups,
        )
        return numpy_response({"status": "ok", "data": result})
    except Exception as e:
        logger.exception("OPLS-DA CV-ANOVA failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/oplsda/load-run")
async def oplsda_load_run(req: LoadRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        data = load_run_from_storage(uid, req.project_id, req.data_path)
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# sPLS-DA
# ═══════════════════════════════════════════════════════════════

class SPLSDARunRequest(BaseModel):
    project_id: str
    name: str
    matrix_path: str
    meta_path: str
    target_meta: str
    ncomp: int = 2
    keepX: List[int] = []
    scale: bool = True
    cv_folds: int = 5
    selected_groups: Optional[List[str]] = None
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/splsda/run")
async def splsda_run(req: SPLSDARunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_splsda_from_paths(
            matrix_path=req.matrix_path, meta_path=req.meta_path, uid=uid, project_id=req.project_id,
            target_meta=req.target_meta, ncomp=req.ncomp, keepX=req.keepX, scale=req.scale,
            cv_folds=req.cv_folds, selected_groups=req.selected_groups,
        )
        run_id = _resolve_run_id("splsda", req.project_id, uid, req.name, req.run_id)
        data_path = save_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "type": "sPLS-DA", "name": req.name,
            "config": {"target_meta": req.target_meta, "ncomp": req.ncomp, "keepX": req.keepX,
                       "scale": req.scale, "cv_folds": req.cv_folds, "selected_groups": req.selected_groups or []},
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("sPLS-DA run failed")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/splsda/load-run")
async def splsda_load_run(req: LoadRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        data = load_run_from_storage(uid, req.project_id, req.data_path)
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# VIP SCORE
# ═══════════════════════════════════════════════════════════════

class VipScoreRunRequest(BaseModel):
    project_id: str
    name: str
    matrix_path: str
    meta_path: str
    target_meta: str
    comparison: str
    vip_scores: List[Dict[str, Any]]
    run_id_src: str
    method_src: str


@app.post("/vip-score/run")
async def vip_score_run(req: VipScoreRunRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    uid = str(user.id)
    project = db.query(Project).filter(Project.id == req.project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    identity = reserve_task_identity(db, str(project.id))
    run_id = identity["run_id"]
    task_id = identity["task_id"]
    db.commit()

    def _run():
        try:
            run_vip_combined(
                project_id=req.project_id, uid=uid, matrix_path=req.matrix_path, meta_path=req.meta_path,
                vip_scores=req.vip_scores, target_meta=req.target_meta, comparison=req.comparison,
                analysis_name=req.name, run_id_src=req.run_id_src, method_src=req.method_src,
                run_id=run_id, task_id=task_id,
            )
        except Exception as exc:
            logger.error(f"VIP combined task failed: {exc}")
            from services.common import set_task_error
            set_task_error(req.project_id, run_id, str(exc))

    _run_in_background(_run)
    return {"status": "processing_vip_combined", "run_id": run_id, "task_id": task_id}


# ═══════════════════════════════════════════════════════════════
# KMEANS
# ═══════════════════════════════════════════════════════════════

class KMeansRunRequest(BaseModel):
    project_id: str
    name: str
    input_type: str
    matrix_path: str
    meta_path: str
    n_clusters: int = 3
    selected_labels: List[str] = []
    meta_col: str = ""
    pca_run_data_path: Optional[str] = None
    run_new_pca: bool = False
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/kmeans/run")
async def kmeans_run(req: KMeansRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_kmeans(
            project_id=req.project_id, uid=uid, name=req.name, input_type=req.input_type,
            matrix_path=req.matrix_path, meta_path=req.meta_path, n_clusters=req.n_clusters,
            selected_labels=req.selected_labels, meta_col=req.meta_col,
            pca_run_data_path=req.pca_run_data_path, run_new_pca=req.run_new_pca,
        )
        run_id = _resolve_run_id("kmeans", req.project_id, uid, req.name, req.run_id)
        data_path = save_kmeans_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "name": req.name,
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("KMeans run failed")
        raise HTTPException(status_code=400, detail=str(e))


class KMeansSaveClustersRequest(BaseModel):
    project_id: str
    meta_path: str
    cluster_col_name: str
    source_col_name: Optional[str] = None
    remove_source_when_renamed: bool = False
    cluster_assignments: Dict[str, Any]
    rename_map: Optional[Dict[str, str]] = None
    run_id: Optional[str] = None
    run_name: Optional[str] = None
    run_data: Optional[Dict[str, Any]] = None


@app.post("/kmeans/save-clusters")
async def kmeans_save_clusters(req: KMeansSaveClustersRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        meta_path = save_clusters_to_meta(
            project_id=req.project_id, uid=uid, meta_path=req.meta_path,
            cluster_col_name=req.cluster_col_name, source_col_name=req.source_col_name,
            remove_source_when_renamed=req.remove_source_when_renamed,
            cluster_assignments=req.cluster_assignments, rename_map=req.rename_map,
        )
        pca_sync_path = None
        if req.run_id and req.run_data:
            pca_sync_path = sync_kmeans_to_pca_history(
                uid=uid, project_id=req.project_id, run_id=req.run_id,
                run_name=req.run_name or req.cluster_col_name,
                cluster_col_name=req.cluster_col_name, cluster_assignments=req.cluster_assignments,
                run_data=req.run_data,
            )
        return {"status": "ok", "meta_path": meta_path, "pca_sync_path": pca_sync_path}
    except Exception as e:
        logger.exception("KMeans save clusters failed")
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# SOM
# ═══════════════════════════════════════════════════════════════

class SOMRunRequest(BaseModel):
    project_id: str
    name: str
    input_type: str
    matrix_path: str
    meta_path: str
    selected_labels: List[str] = []
    meta_col: str = ""
    x_dim: int = 8
    y_dim: int = 8
    initialization: str = "sample"
    neighborhood: str = "gaussian"
    layout: str = "overlay"
    pca_run_data_path: Optional[str] = None
    run_new_pcas: bool = False
    run_id: Optional[str] = None
    task_id: Optional[int] = None


@app.post("/som/run")
async def som_run(req: SOMRunRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = run_som(
            project_id=req.project_id, uid=uid, name=req.name, input_type=req.input_type,
            matrix_path=req.matrix_path, meta_path=req.meta_path, selected_labels=req.selected_labels,
            meta_col=req.meta_col, x_dim=req.x_dim, y_dim=req.y_dim,
            initialization=req.initialization, neighborhood=req.neighborhood, layout=req.layout,
            pca_run_data_path=req.pca_run_data_path, run_new_pcas=req.run_new_pcas,
        )
        run_id = _resolve_run_id("som", req.project_id, uid, req.name, req.run_id)
        data_path = save_som_run_to_storage(uid, req.project_id, run_id, result)
        return numpy_response({
            "status": "ok", "run_id": run_id, "task_id": req.task_id, "name": req.name,
            "data": result, "data_path": data_path,
        })
    except Exception as e:
        logger.exception("SOM run failed")
        raise HTTPException(status_code=400, detail=str(e))


class SOMSaveClustersRequest(BaseModel):
    project_id: str
    meta_path: str
    cluster_col_name: str
    source_col_name: Optional[str] = None
    remove_source_when_renamed: bool = False
    cluster_assignments: Dict[str, Any]
    rename_map: Optional[Dict[str, str]] = None
    run_id: Optional[str] = None
    run_name: Optional[str] = None
    run_data: Optional[Dict[str, Any]] = None


@app.post("/som/save-clusters")
async def som_save_clusters(req: SOMSaveClustersRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        meta_path = save_som_clusters_to_meta(
            project_id=req.project_id, uid=uid, meta_path=req.meta_path,
            cluster_col_name=req.cluster_col_name, source_col_name=req.source_col_name,
            remove_source_when_renamed=req.remove_source_when_renamed,
            cluster_assignments=req.cluster_assignments, rename_map=req.rename_map,
        )
        pca_sync_path = None
        if req.run_id and req.run_data:
            pca_sync_path = sync_som_to_pca_history(
                uid=uid, project_id=req.project_id, run_id=req.run_id,
                run_name=req.run_name or req.cluster_col_name,
                cluster_col_name=req.cluster_col_name, cluster_assignments=req.cluster_assignments,
                run_data=req.run_data,
            )
        return {"status": "ok", "meta_path": meta_path, "pca_sync_path": pca_sync_path}
    except Exception as e:
        logger.exception("SOM save clusters failed")
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# METADATA COLUMN OPS
# ═══════════════════════════════════════════════════════════════

class DeleteMetaColumnsRequest(BaseModel):
    project_id: str
    meta_path: str
    column_names: List[str]


@app.post("/metadata/delete-columns")
async def metadata_delete_columns(req: DeleteMetaColumnsRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = delete_meta_columns(project_id=req.project_id, uid=uid, meta_path=req.meta_path, column_names=req.column_names)
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("Delete metadata columns failed")
        raise HTTPException(status_code=400, detail=str(e))


class CreateMetaColumnRequest(BaseModel):
    project_id: str
    meta_path: str
    new_column_name: str
    mode: str
    source_columns: List[str]


@app.post("/metadata/create-column")
async def metadata_create_column(req: CreateMetaColumnRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = create_meta_column(
            project_id=req.project_id, uid=uid, meta_path=req.meta_path,
            new_column_name=req.new_column_name, mode=req.mode, source_columns=req.source_columns,
        )
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("Create metadata column failed")
        raise HTTPException(status_code=400, detail=str(e))


class ReorderGroupsRequest(BaseModel):
    project_id: str
    column_name: str
    ordered_groups: List[str]


@app.post("/metadata/reorder-groups")
async def metadata_reorder_groups(req: ReorderGroupsRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = reorder_meta_groups(
            project_id=req.project_id, uid=uid,
            column_name=req.column_name, ordered_groups=req.ordered_groups,
        )
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("Reorder metadata groups failed")
        raise HTTPException(status_code=400, detail=str(e))


class RenameMetaColumnRequest(BaseModel):
    project_id: str
    meta_path: str
    old_name: str
    new_name: str


@app.post("/metadata/rename-column")
async def metadata_rename_column(req: RenameMetaColumnRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    try:
        result = rename_meta_column(
            project_id=req.project_id, uid=uid, meta_path=req.meta_path,
            old_name=req.old_name, new_name=req.new_name,
        )
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("Rename metadata column failed")
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# STORAGE DELETE
# ═══════════════════════════════════════════════════════════════

class StorageDeleteRequest(BaseModel):
    project_id: str
    paths: List[str]


@app.post("/storage/delete")
async def delete_storage_files(req: StorageDeleteRequest, user: User = Depends(get_current_user)):
    uid = str(user.id)
    deleted = []
    missing = []
    errors = []
    for rel_path in req.paths:
        try:
            if delete_file(uid, req.project_id, rel_path):
                deleted.append(rel_path)
            else:
                missing.append(rel_path)
        except Exception as exc:
            errors.append({"path": rel_path, "error": str(exc)})
    return {"status": "ok", "deleted": deleted, "missing": missing, "errors": errors}


# ═══════════════════════════════════════════════════════════════
# TASK HISTORY
# ═══════════════════════════════════════════════════════════════

@app.get("/tasks/{project_id}/history/{analysis_type}")
async def task_history(project_id: str, analysis_type: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_dep)):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return get_history(db, project_id, analysis_type)


# ─── SERVE CLIENT STATIC FILES ───────────────────────────────────
# Mount the client directory so both API and client are on port 8000.
# This enables a single tunnel URL for the entire portal.
from fastapi.staticfiles import StaticFiles
from pathlib import Path as _Path

_CLIENT_DIR = _Path(__file__).resolve().parent.parent / "client"
if _CLIENT_DIR.exists():
    # Serve src/ (JS, CSS, images) and other static assets
    app.mount("/src", StaticFiles(directory=str(_CLIENT_DIR / "src")), name="client-src")

    # Serve individual HTML files at root level (index.html, login.html, etc.)
    @app.get("/{page}.html")
    async def serve_html_page(page: str):
        html_path = _CLIENT_DIR / f"{page}.html"
        if html_path.exists():
            return FileResponse(str(html_path))
        raise HTTPException(status_code=404, detail="Page not found")

    # Root → index.html
    @app.get("/")
    async def serve_root():
        return FileResponse(str(_CLIENT_DIR / "index.html"))

    # Serve header.html, sidebar.html etc. (already covered by /{page}.html)

    logger.info(f"Client static files mounted from: {_CLIENT_DIR}")


if __name__ == "__main__":
    import os
    import uvicorn
    logger.info("Starting FastAPI server (v4 — SQLite)...")
    init_db()
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
