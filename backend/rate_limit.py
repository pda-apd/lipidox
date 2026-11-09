from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Small in-process sliding-window limiter for a single uvicorn worker."""

    def __init__(self, app, limit: int = 300, window: int = 60, auth_limit: int = 15):
        super().__init__(app)
        self.limit = limit
        self.window = window
        self.auth_limit = auth_limit
        self._hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self._lock = threading.Lock()

    @staticmethod
    def _client_ip(request) -> str:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return request.client.host if request.client else "unknown"

    def _hit(self, key, limit: int) -> int:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= limit:
                return max(1, int(self.window - (now - q[0])) + 1)
            q.append(now)
            if len(self._hits) > 10000:
                for k in [k for k, v in self._hits.items() if not v][:1000]:
                    self._hits.pop(k, None)
            return 0

    async def dispatch(self, request, call_next):
        path = request.url.path
        is_auth = path.startswith("/auth/")
        retry = self._hit(
            (self._client_ip(request), "auth" if is_auth else "global"),
            self.auth_limit if is_auth else self.limit,
        )
        if retry:
            return JSONResponse(
                {"detail": "Too many requests"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        return await call_next(request)
