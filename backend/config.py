from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


def _data_dir() -> str:
    """DATA_DIR when set (Docker), otherwise ./data next to the backend folder."""
    return os.environ.get("DATA_DIR") or str(Path(__file__).resolve().parent.parent / "data")


class Settings(BaseSettings):
    # SQLite by default — works locally and in a container without a separate
    # database server. Override DATABASE_URL to use PostgreSQL if needed.
    database_url: str = f"sqlite:///{_data_dir()}/lipidportal.db"
    jwt_secret: str = "change-me-in-production-please-use-a-long-random-string"
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 24
    storage_root: str = f"{_data_dir()}/storage"
    cors_origins: str = "*"
    max_workers: int = 2
    backup_dir: str = f"{_data_dir()}/backups"
    backup_retention_days: int = 7

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
