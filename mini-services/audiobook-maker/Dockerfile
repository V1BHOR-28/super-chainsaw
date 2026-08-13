# syntax=docker/dockerfile:1.7
#
# Audiobook-maker (Flask) — Docker image for the Python backend.
#
# Replaces the Render deployment. Same code, same env vars, but runs in Docker
# so you can deploy it anywhere (a VPS, Fly.io, Railway, your own k8s, etc.).
#
# ─── Build ──────────────────────────────────────────────────────────────────
#   docker build -t aria-abm mini-services/audiobook-maker
#
# ─── Run (needs R2 creds + Gemini/Groq keys at runtime) ─────────────────────
#   docker run --env-file mini-services/audiobook-maker/.env.abm \
#     -p 5601:5601 aria-abm
#
# ─── Or via docker-compose (recommended — wires up the frontend too) ────────
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
#   - netcat-openbsd: nc, used by entrypoint for DB waits (not needed here
#     but kept for parity with the frontend image)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      build-essential \
      libxml2-dev \
      libxslt1-dev \
      libjpeg-dev \
      zlib1g-dev \
      curl \
      netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (cached unless requirements.txt changes).
# This is the layer that takes the longest — putting it before COPY . . means
# a code change doesn't invalidate the pip cache.
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy the Flask app. The .dockerignore in this dir excludes __pycache__,
# tests, *.md, and the .pytest_cache.
COPY . .

# Create the data dir ABM_DATA_DIR points at. Render used /tmp/abm-data
# (ephemeral); in Docker, mount a volume here for persistence across restarts.
RUN mkdir -p /tmp/abm-data

# Run as a non-root user. The Flask app doesn't need root.
RUN useradd --create-home --uid 1001 abm \
  && chown -R abm:abm /app /tmp/abm-data
USER abm

ENV ABM_DATA_DIR=/tmp/abm-data \
    PYTHON_VERSION=3.11 \
    PORT=5601

EXPOSE 5601

# Healthcheck: hit the Flask app's root route. Returns 200 when the app is up.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl --silent --fail http://localhost:5601/ || exit 1

# gunicorn with 2 workers + 4 threads matches the Render blueprint in
# render.yaml. 900s timeout because audiobook generation is long-running.
# `--bind 0.0.0.0:5601` matches PORT above and what the Next.js proxy expects.
CMD ["gunicorn", "audiobook_app:app", \
     "--bind", "0.0.0.0:5601", \
     "--workers", "2", \
     "--threads", "4", \
     "--timeout", "900"]
