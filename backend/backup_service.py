"""
Local backup service for LipidPortal v2.

Backs up the local storage directory (uploaded files) and the PostgreSQL
database (project/user/task tables) to timestamped zip files on a schedule.

Local backup service for storage + database.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from config import get_settings
from db import SessionLocal
from models import Project, Task, User

logger = logging.getLogger("BACKUP")

settings = get_settings()
BASE_DIR = Path(__file__).resolve().parent
BACKUP_DIR = Path(settings.backup_dir)
STATE_FILE = BACKUP_DIR / "backup_state.json"

SLOT_HOURS = {0, 3, 6, 9, 12, 15, 18, 21}
POLL_SECONDS = 60
RETENTION_DAYS = settings.backup_retention_days

_scheduler_instance = None
_scheduler_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_text() -> str:
    return _utc_now().strftime("%Y%m%d_%H%M%S")


def _ensure_dirs() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def _safe_json_default(value: Any) -> str:
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    return str(value)


def _load_state() -> Dict[str, Any]:
    _ensure_dirs()
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to read backup state file.")
        return {}


def _save_state(state: Dict[str, Any]) -> None:
    _ensure_dirs()
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, default=_safe_json_default),
        encoding="utf-8",
    )


def _current_slot_label(now: Optional[datetime] = None) -> Optional[str]:
    now = now or _utc_now()
    if now.hour not in SLOT_HOURS:
        return None
    slot_dt = now.replace(minute=0, second=0, microsecond=0)
    return slot_dt.strftime("%Y-%m-%dT%H:00:00Z")


def _export_database() -> List[Dict[str, Any]]:
    """Export all DB rows as a list of {table, rows} dicts.

    Password hashes are deliberately excluded: a backup must not double as an
    offline cracking target. Restore of the users table therefore needs a
    password reset, which is acceptable because restore is manual only.
    """
    exported: List[Dict[str, Any]] = []
    with SessionLocal() as db:
        users = [
            {
                "id": str(u.id), "email": u.email,
                "role_id": u.role_id,
                "created_at": u.created_at.isoformat() if u.created_at else None,
            }
            for u in db.query(User).all()
        ]
        exported.append({"table": "users", "rows": users})

        projects = []
        for p in db.query(Project).all():
            projects.append({
                "id": str(p.id), "user_id": str(p.user_id), "name": p.name,
                "status": p.status, "message": p.message,
                "paths": p.paths or {}, "extra": p.extra or {},
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            })
        exported.append({"table": "projects", "rows": projects})

        tasks = []
        for t in db.query(Task).all():
            tasks.append({
                "id": str(t.id), "project_id": str(t.project_id),
                "analysis_type": t.analysis_type, "run_id": t.run_id,
                "task_id": t.task_id, "name": t.name,
                "status": t.status, "message": t.message,
                "config": t.config or {}, "results": t.results or {},
                "started_at": t.started_at.isoformat() if t.started_at else None,
                "heartbeat_at": t.heartbeat_at.isoformat() if t.heartbeat_at else None,
                "completed_at": t.completed_at.isoformat() if t.completed_at else None,
            })
        exported.append({"table": "tasks", "rows": tasks})

    return exported


def _build_storage_manifest() -> List[Dict[str, Any]]:
    storage_root = settings.storage_root_path
    manifest: List[Dict[str, Any]] = []
    if not storage_root.exists():
        return manifest
    for path in storage_root.rglob("*"):
        if path.is_file():
            rel = path.relative_to(storage_root).as_posix()
            stat = path.stat()
            manifest.append({
                "name": rel,
                "size": int(stat.st_size),
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
    manifest.sort(key=lambda item: item["name"])
    return manifest


def _build_fingerprint(db_export, storage_manifest) -> str:
    payload = {
        "db": db_export,
        "storage": storage_manifest,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=_safe_json_default).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _zip_storage(temp_root: Path) -> None:
    storage_root = settings.storage_root_path
    dest = temp_root / "storage"
    if storage_root.exists():
        shutil.copytree(storage_root, dest, dirs_exist_ok=True)


def _write_db_dump(temp_root: Path) -> Path:
    db_export = _export_database()
    output = temp_root / "database.json"
    output.write_text(
        json.dumps(db_export, ensure_ascii=False, default=_safe_json_default),
        encoding="utf-8",
    )
    return output


def _encryption_key() -> Optional[bytes]:
    raw = (settings.backup_encryption_key or os.environ.get("BACKUP_ENCRYPTION_KEY", "")).strip()
    if not raw:
        return None
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _encrypt_file(source: Path, destination: Path, key: bytes) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, source.read_bytes(), b"lipidportal-backup")
    destination.write_bytes(b"LPBK1" + nonce + ciphertext)


def _decrypt_file(source: Path, destination: Path, key: bytes) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    blob = source.read_bytes()
    if not blob.startswith(b"LPBK1") or len(blob) < 5 + 12:
        raise ValueError("Not an encrypted LipidPortal backup")
    plaintext = AESGCM(key).decrypt(blob[5:17], blob[17:], b"lipidportal-backup")
    destination.write_bytes(plaintext)


def _write_manifest(temp_root: Path, fingerprint: str, storage_manifest) -> None:
    payload = {
        "created_at": _utc_now().isoformat(),
        "fingerprint": fingerprint,
        "storage_objects": len(storage_manifest),
        "storage_root": str(settings.storage_root_path),
    }
    (temp_root / "manifest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=_safe_json_default),
        encoding="utf-8",
    )


def _zip_folder(source_dir: Path, output_zip: Path) -> None:
    temp_zip = output_zip.with_suffix(".tmp")
    if temp_zip.exists():
        temp_zip.unlink()
    with zipfile.ZipFile(temp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in source_dir.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir))
    temp_zip.replace(output_zip)


def cleanup_old_backups(retention_days: int = RETENTION_DAYS) -> List[str]:
    _ensure_dirs()
    cutoff = _utc_now() - timedelta(days=retention_days)
    deleted: List[str] = []
    backup_files = sorted(
        (p for p in BACKUP_DIR.glob("backup_*") if p.is_file() and (p.name.endswith(".zip") or p.name.endswith(".zip.enc"))),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    # Never delete the newest backup, even if it alone exceeds the size cap.
    for backup_file in backup_files[1:]:
        try:
            modified = datetime.fromtimestamp(backup_file.stat().st_mtime, tz=timezone.utc)
            if modified < cutoff:
                backup_file.unlink(missing_ok=True)
                deleted.append(backup_file.name)
        except Exception:
            logger.exception("Failed to delete old backup %s", backup_file)

    # DATA-05: age alone allows ~56 copies; cap total bytes as well.
    cap = max(1, int(settings.backup_max_total_mb)) * 1024 * 1024
    remaining = sorted(
        (p for p in BACKUP_DIR.glob("backup_*") if p.is_file() and (p.name.endswith(".zip") or p.name.endswith(".zip.enc"))),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    total = sum(p.stat().st_size for p in remaining)
    for backup_file in reversed(remaining[1:]):
        if total <= cap:
            break
        try:
            size = backup_file.stat().st_size
            backup_file.unlink(missing_ok=True)
            total -= size
            deleted.append(backup_file.name)
        except Exception:
            logger.exception("Failed to enforce backup size cap for %s", backup_file)
    return deleted


def run_backup_once(force: bool = False) -> Dict[str, Any]:
    _ensure_dirs()
    state = _load_state()

    db_export = _export_database()
    storage_manifest = _build_storage_manifest()
    fingerprint = _build_fingerprint(db_export, storage_manifest)

    if not force and state.get("last_fingerprint") == fingerprint:
        deleted = cleanup_old_backups()
        state["last_skip_reason"] = "no_changes"
        state["last_checked_at"] = _utc_now().isoformat()
        state["last_cleanup_deleted"] = deleted
        _save_state(state)
        logger.info("No changes detected. Backup skipped.")
        return {"status": "skipped", "reason": "no_changes", "deleted_old_backups": deleted}

    file_name = f"backup_{_utc_now_text()}.zip"
    output_zip = BACKUP_DIR / file_name

    with tempfile.TemporaryDirectory(prefix="lipid_backup_") as tmp_dir:
        temp_root = Path(tmp_dir)
        _zip_storage(temp_root)
        _write_db_dump(temp_root)
        _write_manifest(temp_root, fingerprint, storage_manifest)
        _zip_folder(temp_root, output_zip)

    key = _encryption_key()
    if key:
        encrypted = output_zip.with_suffix(".zip.enc")
        _encrypt_file(output_zip, encrypted, key)
        output_zip.unlink(missing_ok=True)
        output_zip = encrypted
        file_name = encrypted.name

    deleted = cleanup_old_backups()
    state.update({
        "last_backup_at": _utc_now().isoformat(),
        "last_backup_file": file_name,
        "last_fingerprint": fingerprint,
        "last_skip_reason": None,
        "last_checked_at": _utc_now().isoformat(),
        "last_cleanup_deleted": deleted,
    })
    _save_state(state)
    logger.info("Backup created: %s", output_zip)
    return {"status": "created", "file": str(output_zip), "deleted_old_backups": deleted}


_MAX_RESTORE_BYTES = 20 * 1024 * 1024 * 1024
_MAX_RESTORE_MEMBERS = 200_000


def _safe_extract(source: zipfile.ZipFile, destination: Path) -> None:
    """Extract a zip without allowing zip-slip or a decompression bomb."""
    destination = destination.resolve()
    total = 0
    members = source.infolist()
    if len(members) > _MAX_RESTORE_MEMBERS:
        raise ValueError("Backup contains too many entries")
    for info in members:
        name = info.filename.replace("\\", "/")
        pure = PurePosixPath(name)
        parts = pure.parts
        if not parts or pure.is_absolute() or ".." in parts or ":" in parts[0]:
            raise ValueError(f"Unsafe backup entry: {info.filename}")
        total += max(0, int(info.file_size))
        if total > _MAX_RESTORE_BYTES:
            raise ValueError("Backup exceeds the restore size limit")
        target = (destination / pure).resolve()
        try:
            target.relative_to(destination)
        except ValueError:
            raise ValueError(f"Unsafe backup entry: {info.filename}")
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open(info, "r") as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)


def restore_backup(zip_path: str, clear_existing: bool = False) -> Dict[str, Any]:
    source = Path(zip_path)
    if not source.exists():
        raise FileNotFoundError(f"Backup file not found: {source}")

    with tempfile.TemporaryDirectory(prefix="lipid_restore_") as tmp_dir:
        temp_root = Path(tmp_dir)
        zip_file = source
        if source.name.endswith(".enc"):
            key = _encryption_key()
            if not key:
                raise ValueError("BACKUP_ENCRYPTION_KEY is required to restore this backup")
            zip_file = temp_root / "backup.zip"
            _decrypt_file(source, zip_file, key)

        with zipfile.ZipFile(zip_file, "r") as zf:
            _safe_extract(zf, temp_root)

        db_dump = temp_root / "database.json"
        storage_src = temp_root / "storage"

        if clear_existing and settings.storage_root_path.exists():
            shutil.rmtree(settings.storage_root_path)

        if storage_src.exists():
            shutil.copytree(storage_src, settings.storage_root_path, dirs_exist_ok=True)

        if db_dump.exists():
            db_payload = json.loads(db_dump.read_text(encoding="utf-8"))
            logger.info("DB dump contains %d tables. Manual restore via SQL recommended.", len(db_payload))
        elif (temp_root / "database.pkl").exists():
            # Legacy pickle dumps are intentionally not deserialized.
            logger.warning("Legacy database.pkl ignored; re-create the backup with this version.")

    return {"status": "restored", "source": str(source), "cleared_existing": bool(clear_existing)}


class BackupScheduler:
    def __init__(self, poll_seconds: int = POLL_SECONDS):
        self.poll_seconds = max(15, int(poll_seconds))
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._run_lock = threading.Lock()

    def start(self) -> "BackupScheduler":
        if self._thread and self._thread.is_alive():
            return self
        self._thread = threading.Thread(target=self._loop, name="backup-scheduler", daemon=True)
        self._thread.start()
        logger.info("Backup scheduler started.")
        return self

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        logger.info("Backup scheduler stopped.")

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.check_due_slot()
            except Exception:
                logger.exception("Backup scheduler loop failed.")
            self._stop_event.wait(self.poll_seconds)

    def check_due_slot(self) -> None:
        now = _utc_now()
        if now.hour not in SLOT_HOURS:
            return
        slot_label = now.replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:00:00Z")
        with self._run_lock:
            state = _load_state()
            if state.get("last_checked_slot") == slot_label:
                return
            state["last_checked_slot"] = slot_label
            state["last_checked_at"] = _utc_now().isoformat()
            _save_state(state)
            result = run_backup_once(force=False)
            logger.info("Backup slot %s result: %s", slot_label, result)


def start_backup_scheduler(poll_seconds: int = POLL_SECONDS) -> BackupScheduler:
    global _scheduler_instance
    with _scheduler_lock:
        if _scheduler_instance is None:
            _scheduler_instance = BackupScheduler(poll_seconds=poll_seconds).start()
        return _scheduler_instance


def stop_backup_scheduler() -> None:
    global _scheduler_instance
    with _scheduler_lock:
        if _scheduler_instance is not None:
            _scheduler_instance.stop()
            _scheduler_instance = None


def main() -> None:
    parser = argparse.ArgumentParser(description="LipidPortal backup utility")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("once", help="Run a single backup now")
    subparsers.add_parser("loop", help="Run the backup scheduler loop")
    restore_parser = subparsers.add_parser("restore", help="Restore from a backup zip")
    restore_parser.add_argument("zip_path")
    restore_parser.add_argument("--clear-existing", action="store_true")
    subparsers.add_parser("cleanup", help="Delete old backups")

    args = parser.parse_args()
    if args.command == "once":
        result = run_backup_once(force=True)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=_safe_json_default))
    elif args.command == "loop":
        scheduler = BackupScheduler().start()
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            scheduler.stop()
    elif args.command == "restore":
        result = restore_backup(args.zip_path, clear_existing=args.clear_existing)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=_safe_json_default))
    elif args.command == "cleanup":
        print(json.dumps({"deleted": cleanup_old_backups()}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
