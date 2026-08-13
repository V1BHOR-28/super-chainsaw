# Dockerfile — audiobook-maker Flask backend (Docker, local-first).
#
# Build context is the repo root. The Flask app lives in
# mini-services/audiobook-maker/audiobook_app.py and exposes `app`
# (line 225: app = Flask(__name__)).
#
# Python 3.11 (matches render.yaml's PYTHON_VERSION=3.11.9).
# Only system binary dependency is ffmpeg (ffprobe ships with it).
# Verified via grep: audio_utils.py + bgm_mix.py + tts_split.py shell
# out to exactly ["ffmpeg"] and ["ffprobe"] — nothing else.

FROM python:3.11-slim

# ffmpeg + ffprobe — required by audio_utils.py (duration probing, mp3 concat,
# m4b muxing) and tts_split.py (mp3→pcm conversion). --no-install-recommends
# keeps the image small; rm apt lists after.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better layer caching).
COPY mini-services/audiobook-maker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code.
COPY mini-services/audiobook-maker/ ./mini-services/audiobook-maker/

# Data directory — mounted as a named volume in docker-compose.yml.
# This is the durable primary store (EPUBs, generated MP3s, tokens, registry).
# Storj/R2 is an off-site backup target, not the source of truth.
RUN mkdir -p /app/data
ENV ABM_DATA_DIR=/app/data \
    ABM_UPLOAD_DIR=/app/data \
    ABM_PORT=5601 \
    PYTHONUNBUFFERED=1

EXPOSE 5601

# Run the Flask app directly (not gunicorn) — matches the existing __main__
# block in audiobook_app.py which handles host/port binding via ABM_PORT.
# The app is threaded (Flask's default dev server with threaded=True) and
# generation runs in background threads, so a single process is fine.
WORKDIR /app/mini-services/audiobook-maker
CMD ["python", "audiobook_app.py"]
