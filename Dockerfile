# Dockerfile — audiobook-maker Flask backend (Docker, local-first).
#
# Python 3.11. System deps: ffmpeg + espeak-ng (for Kokoro's phonemizer).
# CPU-only torch (pinned via --index-url to avoid pulling CUDA wheels).

FROM python:3.11-slim

# ffmpeg + espeak-ng — ffmpeg for audio processing, espeak-ng for Kokoro's
# G2P phonemizer (required by the misaki library).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies.
# torch MUST be installed from the CPU-only index URL to avoid pulling
# the 2GB+ CUDA wheel. We install it separately before requirements.txt
# so the index-url is used exclusively for torch.
COPY mini-services/audiobook-maker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Copy the application code.
COPY mini-services/audiobook-maker/ ./mini-services/audiobook-maker/

# Data directory — mounted as a named volume in docker-compose.yml.
RUN mkdir -p /app/data
ENV ABM_DATA_DIR=/app/data \
    ABM_UPLOAD_DIR=/app/data \
    ABM_PORT=5601 \
    PYTHONUNBUFFERED=1

EXPOSE 5601

WORKDIR /app/mini-services/audiobook-maker
CMD ["python", "audiobook_app.py"]
