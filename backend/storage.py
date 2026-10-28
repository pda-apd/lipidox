from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Any, Optional, Union

import pandas as pd

from config import get_settings

logger = logging.getLogger("STORAGE")

settings = get_settings()
STORAGE_ROOT = settings.storage_root_path


def _normalize_rel_path(user_id: str, project_id: str, path: str) -> str:
    """Accept either 'projects/{uid}/{project_id}/file.csv' or 'file.csv'.

    This lets portable full blob paths their original full blob paths
    without modification.
    """
    value = str(path).strip().lstrip("/")
    prefix = f"projects/{user_id}/{project_id}/"
    if value.startswith(prefix):
        return value[len(prefix):]
    # Also handle the case where the prefix uses different separators
    parts = value.split("/", 3)
    if (
        len(parts) >= 4
        and parts[0] == "projects"
        and parts[1] == str(user_id)
        and parts[2] == str(project_id)
    ):
        return parts[3]
    return value


def _is_shared_path(rel_path: str) -> bool:
    """Check if a path references a shared (non-project) file, e.g. Example/..."""
    value = str(rel_path).strip().lstrip("/")
    return value.startswith("Example/")


def _validate_path(user_id: str, project_id: str, rel_path: str) -> Path:
    rel = _normalize_rel_path(user_id, project_id, rel_path)

    # Shared example files are read from STORAGE_ROOT/Example/...
    if _is_shared_path(rel):
        target = (STORAGE_ROOT / rel).resolve()
        try:
            target.relative_to(STORAGE_ROOT.resolve())
        except ValueError:
            raise PermissionError(f"Path '{rel_path}' escapes storage root")
        return target

    project_root = (STORAGE_ROOT / "projects" / str(user_id) / str(project_id)).resolve()
    target = (project_root / rel).resolve()
    try:
        target.relative_to(project_root)
    except ValueError:
        raise PermissionError(f"Path '{rel_path}' escapes project storage root")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def _validate_existing_path(user_id: str, project_id: str, rel_path: str) -> Path:
    target = _validate_path(user_id, project_id, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"File not found: {rel_path}")
    return target


def project_root(user_id: str, project_id: str) -> Path:
    p = (STORAGE_ROOT / "projects" / str(user_id) / str(project_id)).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def rel_path_from_full(user_id: str, project_id: str, full_path: str) -> str:
    return _normalize_rel_path(user_id, project_id, full_path)


def save_bytes(user_id: str, project_id: str, rel_path: str, data: bytes) -> str:
    target = _validate_path(user_id, project_id, rel_path)
    target.write_bytes(data)
    logger.info(f"[STORAGE] Saved {len(data)} bytes → {_normalize_rel_path(user_id, project_id, rel_path)}")
    return _normalize_rel_path(user_id, project_id, rel_path)


def save_text(user_id: str, project_id: str, rel_path: str, text: str, encoding: str = "utf-8") -> str:
    return save_bytes(user_id, project_id, rel_path, text.encode(encoding))


def save_df_csv(user_id: str, project_id: str, rel_path: str, df: pd.DataFrame) -> str:
    buf = io.StringIO()
    df.to_csv(buf)
    return save_text(user_id, project_id, rel_path, buf.getvalue())


def save_json(user_id: str, project_id: str, rel_path: str, data: Any) -> str:
    import json
    from main import NumpyEncoder
    text = json.dumps(data, cls=NumpyEncoder, ensure_ascii=False)
    return save_text(user_id, project_id, rel_path, text)


def read_bytes(user_id: str, project_id: str, rel_path: str) -> bytes:
    target = _validate_existing_path(user_id, project_id, rel_path)
    return target.read_bytes()


def read_text(user_id: str, project_id: str, rel_path: str, encoding: str = "utf-8") -> str:
    return read_bytes(user_id, project_id, rel_path).decode(encoding)


def read_csv(user_id: str, project_id: str, rel_path: str, **kwargs) -> pd.DataFrame:
    raw = read_bytes(user_id, project_id, rel_path)
    return pd.read_csv(io.BytesIO(raw), **kwargs)


def file_exists(user_id: str, project_id: str, rel_path: str) -> bool:
    try:
        return _validate_existing_path(user_id, project_id, rel_path).is_file()
    except (FileNotFoundError, PermissionError):
        return False


def delete_file(user_id: str, project_id: str, rel_path: str) -> bool:
    target = _validate_existing_path(user_id, project_id, rel_path)
    if target.is_file():
        target.unlink()
        return True
    return False


def delete_project_files(user_id: str, project_id: str) -> int:
    root = project_root(user_id, project_id)
    count = 0
    for p in root.rglob("*"):
        if p.is_file():
            p.unlink()
            count += 1
    return count


def list_files(user_id: str, project_id: str, subdir: str = "") -> list[str]:
    root = project_root(user_id, project_id)
    base = root / subdir if subdir else root
    if not base.exists():
        return []
    return [str(p.relative_to(root)) for p in base.rglob("*") if p.is_file()]


def file_url(user_id: str, project_id: str, rel_path: str) -> str:
    """Return the REST URL for serving a stored file via /files/ endpoint."""
    rel = _normalize_rel_path(user_id, project_id, rel_path)
    if _is_shared_path(rel):
        return f"/files/{rel}"
    return f"/files/projects/{user_id}/{project_id}/{rel}"
