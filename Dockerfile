# LipidoX — single-container image (FastAPI + SQLite + local file storage)

# Pinned by digest so rebuilds resolve the same base image. Python 3.12 is the
# version the lock file was audited against.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# ── System dependencies ─────────────────────────────────────────
# libgomp1: required by scikit-learn / scipy / umap (OpenMP)
# libfreetype6, libgl1: matplotlib + seaborn rendering backends
# curl: healthcheck
# No compiler toolchain: 79/81 dependencies ship manylinux wheels; MiniSom
# and pyopls are pure-Python sdists that build without one.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        libfreetype6 \
        libgl1 \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run the app as an unprivileged user.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser

WORKDIR /app

# ── Install Python dependencies first (better layer caching) ────
COPY backend/requirements.txt backend/requirements.lock.txt ./backend/
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r backend/requirements.lock.txt

# ── Copy application code ────────────────────────────────────────
# --chown avoids a second recursive chown layer.
COPY --chown=appuser:appuser backend/ ./backend/
COPY --chown=appuser:appuser client/  ./client/

# ── Persistent storage volume ───────────────────────────────────
# Mount a writable volume at /data to keep the SQLite database and uploaded
# files across container restarts (see README).
RUN mkdir -p /data/storage /data/backups /home/appuser/.cache/matplotlib \
    && chown -R appuser:appuser /data /home/appuser

# ── Environment ─────────────────────────────────────────────────
ENV DATA_DIR=/data \
    STORAGE_ROOT=/data/storage \
    BACKUP_DIR=/data/backups \
    DATABASE_URL=sqlite:////data/lipidportal.db \
    MPLBACKEND=Agg \
    HOME=/home/appuser \
    MPLCONFIGDIR=/home/appuser/.cache/matplotlib \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=7860 \
    PYTHONPATH=/app/backend

USER appuser

EXPOSE 7860

# Healthcheck — hit the API root (serves index.html, returns 200).
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:7860/ || exit 1

# Run the FastAPI app. PYTHONPATH lets `from auth import ...` style imports
# (used throughout backend/) resolve correctly.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
