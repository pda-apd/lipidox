from __future__ import annotations

import asyncio
import collections
import json
import logging
from typing import Any, Optional

logger = logging.getLogger("TASK_EVENTS")

_subscribers: list[tuple[Optional[str], asyncio.Queue]] = []


def subscribe(uid: Optional[str] = None) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    _subscribers.append((str(uid) if uid else None, q))
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    for entry in list(_subscribers):
        if entry[1] is q:
            _subscribers.remove(entry)


def publish(project_id: str, event: dict[str, Any]) -> None:
    from auth import log_uid_var

    owner = log_uid_var.get()
    msg = json.dumps({"project_id": str(project_id), **event}, default=str, ensure_ascii=False)
    for sub_uid, q in list(_subscribers):
        if owner and sub_uid and sub_uid != owner:
            continue
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(msg)
            except Exception:
                pass


def publish_task_update(
    project_id: str,
    task_id: Optional[str],
    run_id: Optional[str],
    analysis_type: str,
    status: str,
    message: Optional[str] = None,
    **extra: Any,
) -> None:
    event = {
        "task_id": task_id,
        "run_id": run_id,
        "analysis_type": analysis_type,
        "status": status,
        "message": message,
        **extra,
    }
    publish(project_id, event)
