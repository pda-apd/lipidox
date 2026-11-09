from __future__ import annotations

import uuid
from typing import Optional

from fastapi import HTTPException

from db import SessionLocal
from models import Project, User


def require_project(project_id: Optional[str], user: User) -> str:
    """Return the normalized project id only when it belongs to `user`.

    Routes call this before touching services that historically looked projects
    up by id alone. A missing/foreign/malformed id is indistinguishable (404).
    """
    try:
        pid = uuid.UUID(str(project_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=404, detail="Project not found")
    with SessionLocal() as db:
        found = (
            db.query(Project.id)
            .filter(Project.id == pid, Project.user_id == user.id)
            .first()
        )
    if not found:
        raise HTTPException(status_code=404, detail="Project not found")
    return str(pid)
