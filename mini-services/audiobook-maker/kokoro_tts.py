"""kokoro_tts.py — Kokoro-82M local TTS engine (CPU-only, free, no API key).

Kokoro is an open-weight TTS model (Apache 2.0, 82M params) that runs
entirely locally — no API calls, no credits, no rate limits. Same free
tier as edge-tts.

Model: https://huggingface.co/hexgrad/Kokoro-82M
Library: pip install kokoro soundfile (requires CPU-only torch)

Voice ID format: kokoro:<voice_name>
  e.g. kokoro:af_bella  (American English female, grade A-)
       kokoro:am_michael (American English male, grade C+)

Memory: the model is ~330MB in RAM. Loaded lazily on first synthesize()
call, then reused for all subsequent calls (single shared pipeline).
On an 8GB RAM machine, this is safe alongside edge-tts + Flask + ngrok.

No payment gating, no quota, no rate limiting — free and unmetered.
"""

from __future__ import annotations

import os
import threading
import time

# === Lazy-loaded shared pipeline ===========================================
# The Kokoro model is ~330MB in RAM. We load it ONCE on first use, then
# reuse the same pipeline instance for all subsequent calls. This prevents
# OOM kills on 8GB machines during multi-chapter jobs.

_pipeline = None
_pipeline_lock = threading.Lock()
_pipeline_voice = None  # Kokoro pipelines are per-language, not per-voice


def _get_pipeline():
    """Get or create the shared Kokoro pipeline (lazy, thread-safe).

    Returns None if Kokoro can't be loaded (missing deps, model download
    failure, etc.). The caller checks for None and falls back to edge-tts.
    """
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    with _pipeline_lock:
        if _pipeline is not None:  # double-check after acquiring lock
            return _pipeline

        try:
            from kokoro import KPipeline
            t0 = time.time()
            print("[kokoro] Loading model (first call, ~330MB RAM)...",
                  flush=True)
            _pipeline = KPipeline(lang_code='a')  # 'a' = American English
            print(f"[kokoro] Model loaded in {time.time()-t0:.1f}s",
                  flush=True)
            return _pipeline
        except ImportError:
            print("[kokoro] Not available (kokoro/soundfile not installed)",
                  flush=True)
            return None
        except Exception as e:
            print(f"[kokoro] Failed to load model: {e}", flush=True)
            return None


# === Voice catalog =========================================================
# Pulled from https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md
# English-only for this task. Each voice has a quality grade (A-F).
# We expose a curated subset (grade B+ and above for quality).

KOKORO_VOICES = [
    # Curated 10 best voices for audiobook narration: 8 Female + 2 Male.
    # Selected by quality grade + training hours from VOICES.md.
    # Grades: A > A- > B- > C+ > C > D
    #
    # Female (8):
    {"id": "af_heart",   "gender": "Female", "name": "Heart — BEST",     "grade": "A",  "locale": "en-US"},
    {"id": "af_bella",   "gender": "Female", "name": "Bella — Warm",     "grade": "A-", "locale": "en-US"},
    {"id": "af_nicole",  "gender": "Female", "name": "Nicole — Clear",   "grade": "B-", "locale": "en-US"},
    {"id": "bf_emma",    "gender": "Female", "name": "Emma — British",   "grade": "B-", "locale": "en-GB"},
    {"id": "af_aoede",   "gender": "Female", "name": "Aoede — Soft",     "grade": "C+", "locale": "en-US"},
    {"id": "af_kore",    "gender": "Female", "name": "Kore — Steady",    "grade": "C+", "locale": "en-US"},
    {"id": "af_sarah",   "gender": "Female", "name": "Sarah — Calm",     "grade": "C+", "locale": "en-US"},
    {"id": "bf_isabella","gender": "Female", "name": "Isabella — British","grade": "C", "locale": "en-GB"},
    # Male (2):
    {"id": "am_michael", "gender": "Male",   "name": "Michael — BEST Male", "grade": "C+", "locale": "en-US"},
    {"id": "am_fenrir",  "gender": "Male",   "name": "Fenrir — Deep",    "grade": "C+", "locale": "en-US"},
]

# Quick lookup: voice_id → voice info
_VOICE_MAP = {v["id"]: v for v in KOKORO_VOICES}


def get_voices():
    """Return the Kokoro voice catalog grouped by language.

    Shape: {"en": [voice_entry, ...]}
    Each entry: {id, name, gender, gender_icon, engine, locale}
    """
    out = {"en": []}
    for v in KOKORO_VOICES:
        out["en"].append({
            "id": f"kokoro:{v['id']}",
            "name": v["name"],
            "gender": v["gender"],
            "gender_icon": "\u2640" if v["gender"] == "Female" else "\u2642",
            "engine": "kokoro",
            "locale": v["locale"],
        })
    out["en"].sort(key=lambda x: (0 if x["gender"] == "Female" else 1, x["name"]))
    return out


# === Voice ID parsing ======================================================

KOKORO_VOICE_PREFIX = "kokoro:"


def parse_voice_id(voice_id):
    """Parse 'kokoro:<voice_name>' → voice_name. Returns None if invalid."""
    if not voice_id or not voice_id.startswith(KOKORO_VOICE_PREFIX):
        return None
    name = voice_id[len(KOKORO_VOICE_PREFIX):]
    return name if name else None


def voice_locale(voice_id):
    """Return the locale (en-US, en-GB) for a Kokoro voice, or None."""
    name = parse_voice_id(voice_id)
    if not name:
        return None
    v = _VOICE_MAP.get(name)
    return v["locale"] if v else "en-US"


# === Availability ==========================================================

def is_available():
    """True if the Kokoro library is importable. Does NOT load the model —
    that happens lazily on first synthesize() call."""
    try:
        import kokoro  # noqa: F401
        import soundfile  # noqa: F401
        return True
    except ImportError:
        return False


# === Synthesis =============================================================

class KokoroUnavailable(Exception):
    pass


def synthesize(text, voice_id, output_path, rate="+0%", **kwargs):
    """Synthesize `text` to a WAV file at `output_path` via Kokoro TTS.

    Kokoro outputs 24kHz mono PCM. We write it as WAV (soundfile handles
    the encoding). The generation pipeline expects .mp3 files, so the
    caller should convert WAV→MP3 via ffmpeg after this returns (same
    pattern as google_tts when it outputs MP3).

    However, for simplicity and to match the edge-tts MP3 output pattern,
    we convert WAV→MP3 inside this function using ffmpeg.

    Returns dict with: success, bytes_written, billable_chars, voice_name.
    Raises KokoroUnavailable if deps missing, RuntimeError on failure.
    """
    voice_name = parse_voice_id(voice_id)
    if not voice_name:
        raise ValueError(f"Invalid Kokoro voice_id: {voice_id}")

    pipeline = _get_pipeline()
    if pipeline is None:
        raise KokoroUnavailable(
            "Kokoro TTS not available (install: pip install kokoro soundfile)")

    # Convert edge-tts rate ("+10%", "-5%") to Kokoro speed multiplier.
    # edge-tts: +10% = 10% faster. Kokoro: speed=1.1 = 10% faster.
    # Kokoro recommends 0.5-2.0 range.
    speed = _rate_to_speed(rate)

    # Kokoro splits long text internally into chunks and returns a generator.
    # We collect all audio chunks and concatenate them.
    import numpy as np
    import soundfile as sf
    import tempfile
    import subprocess

    t0 = time.time()
    audio_chunks = []
    for i, (graphemes, phonemes, audio) in enumerate(
            pipeline(text, voice=voice_name, speed=speed)):
        if hasattr(audio, 'cpu'):
            audio = audio.cpu().numpy()
        audio_chunks.append(audio)
        if i == 0:
            print(f"[kokoro] First chunk: {len(audio)} samples "
                  f"({len(audio)/24000:.1f}s)", flush=True)

    if not audio_chunks:
        raise RuntimeError("Kokoro produced no audio")

    full_audio = np.concatenate(audio_chunks)
    elapsed = time.time() - t0
    duration = len(full_audio) / 24000
    print(f"[kokoro] Synthesized {len(text)} chars → {duration:.1f}s audio "
          f"in {elapsed:.1f}s ({len(audio_chunks)} chunks, "
          f"RTF={elapsed/duration:.2f})", flush=True)

    # Write WAV to temp, convert to MP3 via ffmpeg
    wav_tmp = output_path + ".wav"
    sf.write(wav_tmp, full_audio, 24000)

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_tmp,
             "-codec:a", "libmp3lame", "-b:a", "64k", output_path],
            check=True, timeout=30,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except Exception as e:
        # Fallback: copy WAV as output (pipeline can handle WAV with .mp3 ext)
        print(f"[kokoro] ffmpeg WAV→MP3 failed (using WAV): {e}")
        import shutil
        shutil.copy2(wav_tmp, output_path)
    finally:
        try:
            os.remove(wav_tmp)
        except OSError:
            pass

    out_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    return {
        "success": True,
        "bytes_written": out_size,
        "sample_rate": 24000,
        "channels": 1,
        "billable_chars": len(text),
        "voice_name": voice_name,
    }


def _rate_to_speed(rate):
    """Convert edge-tts rate string ('+10%', '-5%') to Kokoro speed.

    Kokoro speed: 1.0 = normal, 1.5 = 50% faster, 0.8 = 20% slower.
    Clamp to [0.5, 2.0] (Kokoro's recommended range).
    """
    if not rate or not isinstance(rate, str):
        return 1.0
    try:
        pct = float(rate.replace("%", "").replace("+", ""))
        speed = 1.0 + (pct / 100.0)
        return max(0.5, min(2.0, speed))
    except (ValueError, TypeError):
        return 1.0
