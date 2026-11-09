from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session

from models import Project, Task, TaskCounter
from task_events import publish_task_update

logger = logging.getLogger("TASK_UTILS")


def utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def utc_now_compact() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def reserve_task_identity(db: Session, project_id: str) -> dict[str, Any]:
    counter = db.query(TaskCounter).filter(TaskCounter.project_id == project_id).with_for_update().first()
    if counter is None:
        counter = TaskCounter(project_id=project_id, counter=0)
        db.add(counter)
        db.flush()
        counter = db.query(TaskCounter).filter(TaskCounter.project_id == project_id).with_for_update().first()
    counter.counter += 1
    db.flush()
    task_id = counter.counter
    run_id = f"{utc_now_compact()}_{task_id}"
    return {"task_id": task_id, "run_id": run_id}


def create_task(
    db: Session,
    project_id: str,
    analysis_type: str,
    run_id: str,
    task_id: Optional[int] = None,
    name: Optional[str] = None,
    config: Optional[dict] = None,
) -> Task:
    task = Task(
        project_id=project_id,
        analysis_type=analysis_type,
        run_id=run_id,
        task_id=task_id,
        name=name or f"{analysis_type} {run_id}",
        status="pending",
        message="Queued for processing.",
        config=config or {},
    )
    db.add(task)
    db.flush()
    return task


def update_task_status(
    db: Session,
    project_id: str,
    run_id: str,
    status: str,
    message: Optional[str] = None,
    results: Optional[dict] = None,
    completed: bool = False,
) -> Optional[Task]:
    task = db.query(Task).filter(Task.run_id == run_id, Task.project_id == project_id).first()
    if task is None:
        logger.warning(f"Task not found: run_id={run_id}, project={project_id}")
        return None
    task.status = status
    if message is not None:
        task.message = message
    if results is not None:
        task.results = results
    if completed:
        import datetime
        task.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db.flush()

    publish_task_update(
        project_id=str(project_id),
        task_id=str(task.task_id) if task.task_id else None,
        run_id=run_id,
        analysis_type=task.analysis_type,
        status=status,
        message=message,
    )
    return task


def update_project_status(
    db: Session,
    project_id: str,
    status: Optional[str] = None,
    message: Optional[str] = None,
    paths: Optional[dict] = None,
    extra: Optional[dict] = None,
) -> Optional[Project]:
    from auth import log_uid_var

    query = db.query(Project).filter(Project.id == project_id)
    uid = log_uid_var.get()
    if uid:
        query = query.filter(Project.user_id == uid)
    project = query.first()
    if project is None:
        logger.warning(f"Project not found: {project_id}")
        return None
    if status is not None:
        project.status = status
    if message is not None:
        project.message = message
    if paths:
        merged = dict(project.paths or {})
        merged.update(paths)
        project.paths = merged
    if extra:
        merged = dict(project.extra or {})
        merged.update(extra)
        project.extra = merged
    db.flush()
    return project


def get_history(db: Session, project_id: str, analysis_type: str, limit: int = 50) -> list[dict[str, Any]]:
    tasks = (
        db.query(Task)
        .filter(Task.project_id == project_id, Task.analysis_type == analysis_type)
        .order_by(Task.started_at.desc())
        .limit(limit)
        .all()
    )
    return [task_to_dict(t) for t in tasks]


def get_latest_task(db: Session, project_id: str, analysis_type: str) -> Optional[Task]:
    return (
        db.query(Task)
        .filter(Task.project_id == project_id, Task.analysis_type == analysis_type)
        .order_by(Task.started_at.desc())
        .first()
    )


def task_to_dict(task: Task) -> dict[str, Any]:
    return {
        "id": str(task.id),
        "run_id": task.run_id,
        "task_id": task.task_id,
        "analysis_type": task.analysis_type,
        "name": task.name,
        "status": task.status,
        "message": task.message,
        "config": task.config or {},
        "results": task.results or {},
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "heartbeat_at": task.heartbeat_at.isoformat() if task.heartbeat_at else None,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
    }


def project_to_dict(project: Project, include_tasks: bool = False, user_id: Optional[str] = None) -> dict[str, Any]:
    d = {
        "id": str(project.id),
        "name": project.name,
        "status": project.status,
        "message": project.message,
        "paths": project.paths or {},
        "extra": project.extra or {},
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }
    if user_id:
        d["uid"] = str(user_id)
    if include_tasks:
        d["tasks"] = [task_to_dict(t) for t in (project.tasks or [])]
    return d
