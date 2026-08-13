# syntax=docker/dockerfile:1.7
#
# Audiobook-maker (Flask) — Docker image.
#
# Designed to run on:
#   1. Hugging Face Spaces (Docker SDK) — primary target. Free, no sleep,
#      16GB RAM, 10GB persistent storage at /data. See DEPLOY_HF.md.
#   2. Local Docker / docker-compose — for development. See docker-compose.yml
#      in the repo root.
#   3. Any other Docker host (VPS, Fly.io, Railway) — same image works.
#
# ─── Build ──────────────────────────────────────────────────────────────────
#   docker build -t aria-abm mini-services/audiobook-maker
#
# ─── Run (needs R2 creds + Gemini/Groq keys at runtime) ─────────────────────
#   docker run --env-file .env.abm -p 7860:7860 aria-abm
#
# ─── Or via docker-compose (recommended for local dev) ──────────────────────
#   docker compose up
#
# The image bakes the code + deps but NO secrets. All ABM_* env vars are
# supplied at runtime so the same image works across dev/staging/prod.

FROM python:3.11-slim AS base

# Don't write .pyc files (saves space, avoids stale-cache bugs in Docker).
# Send stdout/stderr straight to the terminal without buffering — so logs
# appear in `docker logs` in real time.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system deps:
#   - ffmpeg: required by Edge-TTS chunk concatenation
#   - build-essential + libxml2-dev + libxslt-dev + libjpeg-dev: needed to
#     build lxml / Pillow / pymupdf wheels on slim images
#   - curl: for the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      build-essential \
      libxml2-dev \
      libxslt1-dev \
      libjpeg-dev \
      zlib1g-dev \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (cached unless requirements.txt changes).
# This is the layer that takes the longest — putting it before COPY . . means
# a code change doesn't invalidate the pip cache.
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy the Flask app. The .dockerignore in this dir excludes __pycache__,
# tests, *.md (except README.md — HF requires it at the repo root for the
# Space metadata), and the .pytest_cache.
COPY . .

# ─── HF Spaces requirements ─────────────────────────────────────────────────
# HF Spaces Docker SDK requires:
#   1. A user named "user" with UID 1000.
#   2. The app listening on the port declared in README.md frontmatter
#      (app_port: 7860 — HF's default).
#   3. Files owned by "user" so the container can read/write them.
#
# We create the user, chown the app + /data, then drop privileges.
RUN useradd --create-home --uid 1000 user \
  && mkdir -p /data/abm-data \
  && chown -R user:user /app /data

USER user

# /data is HF's persistent storage (10GB free, survives restarts).
# /tmp is ephemeral scratch (wiped on restart).
ENV ABM_DATA_DIR=/data/abm-data \
    PYTHON_VERSION=3.11 \
    PORT=7860

EXPOSE 7860

# Healthcheck: hit the Flask app's root route. Returns 200 when the app is up.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl --silent --fail http://localhost:7860/ || exit 1

# gunicorn with 2 workers + 4 threads matches the Render blueprint in
# render.yaml. 900s timeout because audiobook generation is long-running.
# `--bind 0.0.0.0:7860` matches PORT above and what HF Spaces expects.
#
# Note: when run via `python audiobook_app.py` (e.g. local dev without
# Docker), the app reads $PORT itself and binds to 0.0.0.0:$PORT. The
# gunicorn entrypoint here is for production only.
CMD ["gunicorn", "audiobook_app:app", \
     "--bind", "0.0.0.0:7860", \
     "--workers", "2", \
     "--threads", "4", \
     "--timeout", "900"]
