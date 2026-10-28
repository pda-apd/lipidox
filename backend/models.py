from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, JSON, String, Text, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.types import TypeDecorator

from db import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class GUID(TypeDecorator):
    """UUID column that also accepts plain strings at bind time (SQLite-safe).

    The stock generic ``UUID(as_uuid=True)`` calls ``value.hex`` on bind and
    crashes with ``AttributeError: 'str' object has no attribute 'hex'`` when a
    raw string (JWT ``sub``, path param, JSON field) hits a comparison. This
    type coerces str â†’ uuid.UUID first; storage format is unchanged.
    """

    impl = UUID
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and not isinstance(value, uuid.UUID):
            value = uuid.UUID(str(value))
        return value


class User(Base):
    __tablename__ = "users"

    id = Column(GUID, primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(Text, nullable=False)
    role_id = Column(Integer, nullable=False, default=2)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utc_now)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id = Column(GUID, primary_key=True, default=uuid.uuid4)
    user_id = Column(GUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    status = Column(String(100), nullable=True)
    message = Column(Text, nullable=True)
    paths = Column(JSON, nullable=False, default=dict)
    extra = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utc_now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_utc_now, onupdate=_utc_now)

    user = relationship("User", back_populates="projects")
    tasks = relationship("Task", back_populates="project", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(GUID, primary_key=True, default=uuid.uuid4)
    project_id = Column(GUID, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    analysis_type = Column(String(50), nullable=False)
    run_id = Column(String(100), nullable=False, index=True)
    task_id = Column(Integer, nullable=True)
    name = Column(String(255), nullable=True)
    status = Column(String(50), nullable=False, default="pending")
    message = Column(Text, nullable=True)
    config = Column(JSON, nullable=False, default=dict)
    results = Column(JSON, nullable=False, default=dict)
    started_at = Column(DateTime(timezone=True), default=_utc_now)
    heartbeat_at = Column(DateTime(timezone=True), default=_utc_now)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    project = relationship("Project", back_populates="tasks")


class TaskCounter(Base):
    __tablename__ = "task_counters"

    project_id = Column(GUID, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    counter = Column(Integer, nullable=False, default=0)
