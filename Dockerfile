# LipidoX — single-container image (FastAPI + SQLite + local file storage)

FROM python:3.10-slim-bookworm

# ── System dependencies ─────────────────────────────────────────
# build-essential: needed to compile some wheels (pyopls, umap-learn, etc.)
# libgomp1: required by scikit-learn / scipy / umap (OpenMP)
# libfreetype6, libgl1: matplotlib + seaborn rendering backends
# curl: healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgomp1 \
        libfreetype6 \
        libgl1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install Python dependencies first (better layer caching) ────
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r backend/requirements.txt

# ── Copy application code ────────────────────────────────────────
COPY backend/ ./backend/
COPY client/  ./client/

# ── Persistent storage volume ───────────────────────────────────
# Mount a writable volume at /data to keep the SQLite database and uploaded
# files across container restarts (see README).
RUN mkdir -p /data/storage /data/backups

# ── Environment ─────────────────────────────────────────────────
ENV DATA_DIR=/data \
    STORAGE_ROOT=/data/storage \
    BACKUP_DIR=/data/backups \
    DATABASE_URL=sqlite:////data/lipidportal.db \
    MPLBACKEND=Agg \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    PYTHONPATH=/app/backend

EXPOSE 7860

# Healthcheck — hit the API root (serves index.html, returns 200).
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:7860/ || exit 1

# Run the FastAPI app. PYTHONPATH lets `from auth import ...` style imports
# (used throughout backend/) resolve correctly.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
