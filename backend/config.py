from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


def _data_dir() -> str:
    """DATA_DIR when set (Docker), otherwise ./data next to the backend folder."""
    return os.environ.get("DATA_DIR") or str(Path(__file__).resolve().parent.parent / "data")


def _load_or_create_secret() -> str:
    """Never ship a known JWT signing key: use the env var or a persisted random key."""
    env = (os.environ.get("JWT_SECRET") or "").strip()
    if len(env) >= 32:
        return env
    path = Path(_data_dir()) / ".jwt_secret"
    try:
        if path.exists():
            value = path.read_text(encoding="utf-8").strip()
            if len(value) >= 32:
                return value
        value = secrets.token_urlsafe(48)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return value
    except OSError:
        # Last resort: random per process. Tokens simply do not survive a restart.
        return secrets.token_urlsafe(48)


class Settings(BaseSettings):
    # SQLite by default — works locally and in a container without a separate
    # database server. Override DATABASE_URL to use PostgreSQL if needed.
    database_url: str = f"sqlite:///{_data_dir()}/lipidportal.db"
    jwt_secret: str = _load_or_create_secret()
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 24
    jwt_issuer: str = "lipidportal"
    jwt_audience: str = "lipidportal-client"
    storage_root: str = f"{_data_dir()}/storage"
    cors_origins: str = (
        "http://localhost:5000,http://localhost:5173,http://localhost:5500,"
        "http://127.0.0.1:5000,http://127.0.0.1:5173,http://127.0.0.1:5500"
    )
    max_workers: int = 2
    max_upload_mb: int = 200
    project_quota_mb: int = 5120
    ssl_certfile: str = ""
    ssl_keyfile: str = ""
    enable_docs: bool = False
    allowed_hosts: str = "*"
    external_enrichment_enabled: bool = True
    external_call_timeout_seconds: int = 120
    backup_dir: str = f"{_data_dir()}/backups"
    backup_retention_days: int = 7
    backup_max_total_mb: int = 10240
    backup_encryption_key: str = ""
    export_ttl_minutes: int = 60

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    @property
    def storage_root_path(self) -> Path:
        p = Path(self.storage_root).resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
