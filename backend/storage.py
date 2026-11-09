from __future__ import annotations

import io
import logging
import uuid
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
    value = str(path).strip().replace("\\", "/").lstrip("/")
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


def _safe_rel(rel_path: str) -> str:
    """Reject absolute paths, drive letters, NUL bytes and any '..' segment."""
    value = _normalize_separators(str(rel_path)).strip().lstrip("/")
    if not value:
        raise PermissionError("Empty path")
    if "\x00" in value:
        raise PermissionError("Invalid path")
    if value.startswith("~") or ":" in value.split("/", 1)[0]:
        raise PermissionError(f"Path '{rel_path}' is absolute")
    parts = value.split("/")
    if any(part in ("..", ".") for part in parts):
        raise PermissionError(f"Path '{rel_path}' contains traversal segments")
    return value


def _normalize_separators(value: str) -> str:
    return value.replace("\\", "/")


def _resolve_under(root: Path, rel: str) -> Path:
    root = root.resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(f"Path '{rel}' escapes storage root")
    return target


def _uuid_or_403(project_id: str) -> str:
    try:
        return str(uuid.UUID(str(project_id)))
    except (ValueError, AttributeError, TypeError):
        raise PermissionError("Invalid project id")


def _is_shared_path(rel_path: str) -> bool:
    """Check if a path references a shared (non-project) file, e.g. Example/..."""
    value = _normalize_separators(str(rel_path)).strip().lstrip("/")
    return value == "Example" or value.startswith("Example/")


def _validate_path(user_id: str, project_id: str, rel_path: str) -> Path:
    rel = _safe_rel(_normalize_rel_path(user_id, project_id, rel_path))

    # Shared example files live at STORAGE_ROOT/Example/... (read-only).
    if _is_shared_path(rel):
        target = _resolve_under(STORAGE_ROOT / "Example", rel[len("Example/"):] if rel.startswith("Example/") else "")
        return target

    project_root = (STORAGE_ROOT / "projects" / str(user_id) / _uuid_or_403(project_id)).resolve()
    target = _resolve_under(project_root, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def resolve_shared_read(rel_path: str) -> Path:
    """Resolve a read-only shared file (Example/...), rejecting traversal."""
    target = _validate_path("", "", rel_path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {rel_path}")
    return target


def _validate_existing_path(user_id: str, project_id: str, rel_path: str) -> Path:
    target = _validate_path(user_id, project_id, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"File not found: {rel_path}")
    return target


def resolve_project_file(user_id: str, project_id: str, rel_path: str) -> Path:
    return _validate_existing_path(user_id, project_id, rel_path)


def project_root(user_id: str, project_id: str) -> Path:
    p = (STORAGE_ROOT / "projects" / str(user_id) / _uuid_or_403(project_id)).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def rel_path_from_full(user_id: str, project_id: str, full_path: str) -> str:
    return _normalize_rel_path(user_id, project_id, full_path)


def save_bytes(user_id: str, project_id: str, rel_path: str, data: bytes) -> str:
    if _is_shared_path(_normalize_rel_path(user_id, project_id, rel_path)):
        raise PermissionError("Shared example files are read-only")
    target = _validate_path(user_id, project_id, rel_path)
    target.write_bytes(data)
    logger.info(f"[STORAGE] Saved {len(data)} bytes → {_normalize_rel_path(user_id, project_id, rel_path)}")
    return _normalize_rel_path(user_id, project_id, rel_path)


def save_stream(
    user_id: str,
    project_id: str,
    rel_path: str,
    reader,
    max_bytes: Optional[int] = None,
    chunk_size: int = 1024 * 1024,
) -> str:
    """Stream an upload to disk, aborting cleanly when it exceeds max_bytes."""
    if _is_shared_path(_normalize_rel_path(user_id, project_id, rel_path)):
        raise PermissionError("Shared example files are read-only")
    target = _validate_path(user_id, project_id, rel_path)
    tmp = target.with_name(target.name + ".part")
    total = 0
    try:
        with tmp.open("wb") as handle:
            while True:
                chunk = reader.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise ValueError(f"File exceeds the {max_bytes} byte limit")
                handle.write(chunk)
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    logger.info(f"[STORAGE] Saved {total} bytes → {_normalize_rel_path(user_id, project_id, rel_path)}")
    return _normalize_rel_path(user_id, project_id, rel_path)


def project_size(user_id: str, project_id: str) -> int:
    root = project_root(user_id, project_id)
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def save_text(user_id: str, project_id: str, rel_path: str, text: str, encoding: str = "utf-8") -> str:
    return save_bytes(user_id, project_id, rel_path, text.encode(encoding))


def csv_safe(value: Any) -> Any:
    """Neutralize spreadsheet formulas without touching real numbers."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def csv_safe_frame(df: pd.DataFrame) -> pd.DataFrame:
    # pandas 3 defaults to StringDtype, so comparing to object alone silently
    # skips text columns (and the formula injection they can carry).
    from pandas.api.types import is_string_dtype

    out = df.copy(deep=False)
    for column in out.columns:
        if is_string_dtype(out[column].dtype):
            out[column] = out[column].map(csv_safe)
    if is_string_dtype(out.index.dtype):
        out.index = out.index.map(csv_safe)
    return out


def save_df_csv(user_id: str, project_id: str, rel_path: str, df: pd.DataFrame) -> str:
    buf = io.StringIO()
    csv_safe_frame(df).to_csv(buf)
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
    if _is_shared_path(_normalize_rel_path(user_id, project_id, rel_path)):
        raise PermissionError("Shared example files are read-only")
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
