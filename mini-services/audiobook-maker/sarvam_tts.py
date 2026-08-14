"""sarvam_tts.py — Sarvam AI Bulbul TTS integration.

Indian-language TTS via Sarvam AI's Bulbul models (v2 + v3).
35+ voices across Hindi (hi-IN) and Indian-English (en-IN).

API: POST https://api.sarvam.ai/text-to-speech
Auth: api-subscription-key header (primary, per Sarvam docs)
Audio: Returns base64-encoded WAV in JSON {"audios": [...]}
Limit: 500 chars per request (verified via live API for BOTH v2 and v3 —
       the docs claim v3 supports 2500 but the REST endpoint rejects >500)

Voice ID format: sarvam:<speaker>:<lang>
  e.g. sarvam:aditya:hi-IN  (Hindi female, v3)
       sarvam:manisha:hi-IN (Hindi female, v2)

Payment model (currently disabled for testing):
  - Admin (ABM_ADMIN_TOKEN): free, unlimited
  - Non-admin: $0.80/chapter, 2 free chapters/day
"""

from __future__ import annotations

import base64
import contextlib
import os
import re
import threading
import time

# === Concurrency gate (mirrors speechify_tts pattern) =====================

_gate_lock = threading.Condition()
_gate_active = 0


@contextlib.contextmanager
def slot(timeout=None):
    """Context manager: acquire one global API slot for the block."""
    global _gate_active
    deadline = None if timeout is None else (time.monotonic() + timeout)
    with _gate_lock:
        while _gate_active >= max_concurrency():
            if deadline is None:
                _gate_lock.wait()
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Sarvam API slot timeout")
                _gate_lock.wait(timeout=remaining)
        _gate_active += 1
    try:
        yield
    finally:
        with _gate_lock:
            _gate_active -= 1
            _gate_lock.notify()


def _env_int(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (ValueError, TypeError):
        return default


def _env_float(name, default):
    try:
        return float(os.environ.get(name, str(default)))
    except (ValueError, TypeError):
        return default


# === Config ================================================================

API_BASE = "https://api.sarvam.ai"
TTS_ENDPOINT = "/text-to-speech"
TRANSLATE_ENDPOINT = "/translate"

PER_CHAPTER_USD = _env_float("ABM_SARVAM_PER_CHAPTER_USD", 0.80)
FREE_CHAPTERS_PER_DAY = _env_int("ABM_SARVAM_FREE_CHAPTERS_PER_DAY", 2)
USD_EUR_RATE = _env_float("ABM_GEMINI_USD_EUR_RATE", 0.86)

# Sarvam REST API char limit — verified via live API testing.
# Both v2 and v3 reject inputs > 500 chars with HTTP 400.
# (Sarvam docs claim v3 supports 2500, but the REST endpoint enforces 500.
#  The streaming/WebSocket API may have a higher limit — not used here.)
MAX_CHARS_V2 = 500
MAX_CHARS_V3 = 500


def api_key():
    return os.environ.get("ABM_SARVAM_API_KEY", "").strip()


def is_available():
    return bool(api_key())


def max_concurrency():
    return max(1, _env_int("ABM_SARVAM_MAX_CONCURRENCY", 3))


# === Voice catalog =========================================================
# Source: https://docs.sarvam.ai/api/getting-started/models + pipecat source.
#
# bulbul:v2 speakers (support pitch, loudness, pace 0.3-3.0):
#   Female: anushka, manisha, vidya, arya
#   Male: abhilash, karun, hitesh, kabir
#
# bulbul:v3 speakers (NO pitch/loudness, pace 0.5-2.0, supports temperature):
#   Female: aditya, ritu, priya, neha, pooja, simran, kavya, ishita, shreya,
#           roopa, amelia, sophia
#   Male: rahul, rohan, amit, dev, ratan, varun, manan, sumit, kabir,
#         aayan, shubh, ashutosh, advait
#
# NOTE: "kabir" exists in BOTH v2 and v3. We tag it as v3 (wider voice set).
# All speakers work for both hi-IN and en-IN.

SARVAM_VOICES = [
    # --- bulbul:v3 speakers (Hindi) ---
    {"id": "aditya",   "gender": "Female", "lang": "hi-IN", "name": "Aditya",   "model": "v3"},
    {"id": "ritu",     "gender": "Female", "lang": "hi-IN", "name": "Ritu",     "model": "v3"},
    {"id": "priya",    "gender": "Female", "lang": "hi-IN", "name": "Priya",    "model": "v3"},
    {"id": "neha",     "gender": "Female", "lang": "hi-IN", "name": "Neha",     "model": "v3"},
    {"id": "pooja",    "gender": "Female", "lang": "hi-IN", "name": "Pooja",    "model": "v3"},
    {"id": "simran",   "gender": "Female", "lang": "hi-IN", "name": "Simran",   "model": "v3"},
    {"id": "kavya",    "gender": "Female", "lang": "hi-IN", "name": "Kavya",    "model": "v3"},
    {"id": "ishita",   "gender": "Female", "lang": "hi-IN", "name": "Ishita",   "model": "v3"},
    {"id": "rahul",    "gender": "Male",   "lang": "hi-IN", "name": "Rahul",    "model": "v3"},
    {"id": "rohan",    "gender": "Male",   "lang": "hi-IN", "name": "Rohan",    "model": "v3"},
    {"id": "amit",     "gender": "Male",   "lang": "hi-IN", "name": "Amit",     "model": "v3"},
    {"id": "dev",      "gender": "Male",   "lang": "hi-IN", "name": "Dev",      "model": "v3"},
    # --- bulbul:v3 speakers (Indian English) ---
    {"id": "shreya",   "gender": "Female", "lang": "en-IN", "name": "Shreya",   "model": "v3"},
    {"id": "roopa",    "gender": "Female", "lang": "en-IN", "name": "Roopa",    "model": "v3"},
    {"id": "amelia",   "gender": "Female", "lang": "en-IN", "name": "Amelia",   "model": "v3"},
    {"id": "sophia",   "gender": "Female", "lang": "en-IN", "name": "Sophia",   "model": "v3"},
    {"id": "ratan",    "gender": "Male",   "lang": "en-IN", "name": "Ratan",    "model": "v3"},
    {"id": "manan",    "gender": "Male",   "lang": "en-IN", "name": "Manan",    "model": "v3"},
    {"id": "sumit",    "gender": "Male",   "lang": "en-IN", "name": "Sumit",    "model": "v3"},
    {"id": "aayan",    "gender": "Male",   "lang": "en-IN", "name": "Aayan",    "model": "v3"},
    # --- bulbul:v2 speakers (Hindi — support pitch/loudness) ---
    {"id": "manisha",  "gender": "Female", "lang": "hi-IN", "name": "Manisha",  "model": "v2"},
    {"id": "vidya",    "gender": "Female", "lang": "hi-IN", "name": "Vidya",    "model": "v2"},
    {"id": "anushka",  "gender": "Female", "lang": "en-IN", "name": "Anushka",  "model": "v2"},
    {"id": "karun",    "gender": "Male",   "lang": "en-IN", "name": "Karun",    "model": "v2"},
]

# Quick lookup: speaker name → model version
_SPEAKER_MODEL = {v["id"]: v["model"] for v in SARVAM_VOICES}

# v2-only speakers (for conditional pitch/loudness params)
_V2_SPEAKERS = {v["id"] for v in SARVAM_VOICES if v["model"] == "v2"}


def get_voices():
    """Return the Sarvam voice catalog grouped by language.

    Shape: {"hi-IN": [voice_entry, ...], "en-IN": [...]}
    Each entry: {id, name, gender, gender_icon, engine, locale}
    """
    out = {}
    for v in SARVAM_VOICES:
        lang = v["lang"]
        if lang not in out:
            out[lang] = []
        out[lang].append({
            "id": f"sarvam:{v['id']}:{lang}",
            "name": f"{v['name']} (v{v['model'][-1]})",
            "gender": v["gender"],
            "gender_icon": "\u2640" if v["gender"] == "Female" else "\u2642",
            "engine": "sarvam",
            "locale": lang,
        })
    for lang in out:
        out[lang].sort(key=lambda x: (0 if x["gender"] == "Female" else 1, x["name"]))
    return out


# === Voice ID parsing ======================================================

def parse_voice_id(voice_id):
    """Parse 'sarvam:<speaker>:<lang>' → (speaker, lang_code)."""
    if not voice_id or not voice_id.startswith("sarvam:"):
        return None, None
    parts = voice_id.split(":")
    if len(parts) != 3:
        return None, None
    return parts[1], parts[2]


def voice_locale(voice_id):
    _, lang = parse_voice_id(voice_id)
    return lang


def _speaker_model(speaker):
    """Return 'v2' or 'v3' for a speaker name."""
    return _SPEAKER_MODEL.get(speaker.lower(), "v3")


def _max_chars_for_model(model):
    """Max chars per API request for the given model version."""
    return MAX_CHARS_V2 if model == "v2" else MAX_CHARS_V3


# === Text chunking =========================================================

def _split_text(text, max_chars):
    """Split text into sub-chunks of ≤max_chars on sentence boundaries.

    Splits on sentence boundaries (.!?) first, then word boundaries if a
    single sentence exceeds max_chars.
    """
    if len(text) <= max_chars:
        return [text]
    chunks = []
    sentences = re.split(r'(?<=[.!?])\s+', text)
    current = ""
    for sent in sentences:
        if len(current) + len(sent) + 1 <= max_chars:
            current = (current + " " + sent).strip() if current else sent
        else:
            if current:
                chunks.append(current)
            # If a single sentence > max_chars, split on word boundaries
            while len(sent) > max_chars:
                cut = sent.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                chunks.append(sent[:cut].strip())
                sent = sent[cut:].strip()
            current = sent
    if current:
        chunks.append(current)
    return chunks


# === Core API call =========================================================

class SarvamUnavailable(Exception):
    pass


def _call_api(text, speaker, lang_code, pace, model, session):
    """Single Sarvam TTS API call. Returns WAV bytes.

    Raises RuntimeError on any non-200 response. Logs the full response
    body BEFORE raising so schema errors are visible in logs immediately.
    """
    # Build payload — only include fields the API accepts.
    # v3 does NOT support pitch/loudness (docs + pipecat source confirm).
    # v2 supports pitch/loudness but we omit them (default values are fine).
    payload = {
        "inputs": [text],
        "speaker": speaker.lower(),
        "target_language_code": lang_code,
        "pace": pace,
        "model": f"bulbul:{model}",
        "output_audio_codec": "wav",
    }

    # Auth: api-subscription-key is Sarvam's documented primary method.
    # Every official example + pipecat uses this, not Bearer.
    headers = {
        "api-subscription-key": api_key(),
        "Content-Type": "application/json",
    }

    url = API_BASE + TTS_ENDPOINT

    with slot():
        resp = session.post(url, json=payload, headers=headers, timeout=120)

    # ERROR VISIBILITY: log the full response body on ANY non-200 before
    # doing anything else. This was the #1 reason the previous bug went
    # undetected — 4xx errors were silently converted to silence.
    if resp.status_code != 200:
        print(f"[sarvam] HTTP {resp.status_code} body={resp.text[:500]}",
              flush=True)
        raise RuntimeError(
            f"Sarvam TTS HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    audios = data.get("audios") or []
    if not audios:
        print(f"[sarvam] ERROR: empty audios array in 200 response: "
              f"{str(data)[:300]}", flush=True)
        raise RuntimeError("Sarvam TTS returned empty audios array")

    wav = b""
    for b64 in audios:
        if b64:
            wav += base64.b64decode(b64)
    if not wav:
        raise RuntimeError("Sarvam TTS returned empty audio data after decode")

    return wav


# === Synthesis (main entry point) ==========================================

SARVAM_TTS_VERSION = "2024-08-15-rebuild"


def synthesize(text, voice_id, output_path, rate="+0%", max_attempts=3,
               session=None):
    """Synthesize `text` to an MP3 file at `output_path` via Sarvam TTS.

    Pipeline:
      1. Split text into ≤500-char sub-chunks (API limit)
      2. Call API for each sub-chunk → WAV bytes
      3. Convert each WAV → MP3 via ffmpeg (individual encoding)
      4. Concatenate MP3s into the final output file

    Dev mode (ABM_SARVAM_DEV_MODE=1):
      - Synthesize only the FIRST sub-chunk via the real API (1 credit)
      - Generate silence for remaining sub-chunks locally (0 credits)
      - Chapter content is NOT truncated — full text is chunked, but only
        the first chunk gets real audio. The rest is silence so the pipeline
        can be tested end-to-end (duration, concat, playback) for 1 credit.

    Returns dict with: success, bytes_written, billable_chars, voice_name.
    """
    if not is_available():
        raise SarvamUnavailable(
            "Sarvam TTS not available (check ABM_SARVAM_API_KEY)")

    speaker, lang_code = parse_voice_id(voice_id)
    if not speaker or not lang_code:
        raise ValueError(f"Invalid Sarvam voice_id: {voice_id}")

    if session is None:
        import requests
        session = requests.Session()

    pace = _rate_to_pace(rate)
    model = _speaker_model(speaker)
    max_chars = _max_chars_for_model(model)

    # Split text into sub-chunks
    sub_chunks = _split_text(text, max_chars=max_chars)

    # Dev mode: 1 real API call + silence for the rest
    dev_mode = os.environ.get("ABM_SARVAM_DEV_MODE", "0").strip().lower() in (
        "1", "true", "yes")

    if dev_mode:
        # Warn loudly if admin token is not set — dev mode should never ship
        admin_token = os.environ.get("ABM_ADMIN_TOKEN", "").strip()
        if not admin_token:
            print("[sarvam] WARNING: ABM_SARVAM_DEV_MODE=1 but no "
                  "ABM_ADMIN_TOKEN set — dev mode must NOT be used in "
                  "production!", flush=True)
        print(f"[sarvam] DEV MODE: 1 real API call + {len(sub_chunks)-1} "
              f"silent sub-chunks (chapter content preserved, credits=1)",
              flush=True)

    print(f"[sarvam] synthesize v={SARVAM_TTS_VERSION} voice={voice_id} "
          f"text_len={len(text)} sub_chunks={len(sub_chunks)} "
          f"model={model} dev_mode={dev_mode}", flush=True)

    import tempfile
    import shutil
    mp3_files = []
    _tmpdir = tempfile.mkdtemp(prefix="sarvam_")
    try:
        for idx, sub in enumerate(sub_chunks):
            sub_mp3 = os.path.join(_tmpdir, f"sub_{idx:04d}.mp3")
            sub_wav = os.path.join(_tmpdir, f"sub_{idx:04d}.wav")

            if dev_mode and idx > 0:
                # Dev mode: generate silence instead of calling the API.
                # The silence duration is estimated from the text length
                # (~15 chars/sec at pace 1.0) so the total chapter duration
                # is roughly correct for pipeline testing.
                silence_sec = max(1, len(sub) // 15)
                _generate_silence_wav(sub_wav, silence_sec)
            else:
                # Real API call (first chunk in dev mode, all chunks in prod)
                last_error = None
                success = False
                for attempt in range(max_attempts):
                    try:
                        wav = _call_api(sub, speaker, lang_code, pace,
                                        model, session)
                        with open(sub_wav, "wb") as fp:
                            fp.write(wav)
                        success = True
                        break
                    except Exception as e:
                        last_error = e
                        err_str = str(e)
                        # Non-retryable 4xx (except 429) — fail immediately
                        if "HTTP 4" in err_str and "429" not in err_str:
                            raise
                        if attempt < max_attempts - 1:
                            time.sleep(_retry_delay(attempt))
                if not success:
                    raise RuntimeError(
                        f"Sarvam TTS failed on sub-chunk {idx}/"
                        f"{len(sub_chunks)} after {max_attempts} attempts: "
                        f"{last_error}")

            # Convert WAV → MP3 (individual encoding per sub-chunk)
            import subprocess
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", sub_wav,
                 "-codec:a", "libmp3lame", "-b:a", "64k", sub_mp3],
                check=True, timeout=30,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            mp3_files.append(sub_mp3)

        # Concatenate MP3 sub-chunks into the final output
        if len(mp3_files) == 1:
            shutil.copy2(mp3_files[0], output_path)
        else:
            import subprocess
            concat_list = os.path.join(_tmpdir, "concat_list.txt")
            with open(concat_list, "w") as f:
                for mf in mp3_files:
                    f.write(f"file '{mf}'\n")
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                 "-safe", "0", "-i", concat_list, "-c", "copy", output_path],
                check=True, timeout=60,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        try:
            shutil.rmtree(_tmpdir)
        except Exception:
            pass

    # Verify output
    out_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    print(f"[sarvam] output: path={output_path} size={out_size} "
          f"sub_chunks={len(mp3_files)}", flush=True)

    return {
        "success": True,
        "bytes_written": out_size,
        "sample_rate": 24000 if model == "v3" else 22050,
        "channels": 1,
        "billable_chars": len(text),
        "voice_name": speaker,
    }


def _generate_silence_wav(path, duration_sec):
    """Generate a WAV file of silence using ffmpeg."""
    import subprocess
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
         "-t", str(duration_sec), path],
        check=True, timeout=10,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _rate_to_pace(rate):
    """Convert edge-tts rate string ('+10%', '-5%') to Sarvam pace.

    v3: pace 0.5-2.0 (clamped)
    v2: pace 0.3-3.0 (clamped)
    """
    if not rate or not isinstance(rate, str):
        return 1.0
    try:
        pct = float(rate.replace("%", "").replace("+", ""))
        pace = 1.0 + (pct / 100.0)
        return max(0.5, min(2.0, pace))
    except (ValueError, TypeError):
        return 1.0


def _retry_delay(attempt):
    """Exponential backoff: 2s, 5s, 10s."""
    return [2.0, 5.0, 10.0][min(attempt, 2)]


# === Pricing ===============================================================

def per_chapter_usd():
    return PER_CHAPTER_USD


def per_chapter_eur():
    return round(PER_CHAPTER_USD * USD_EUR_RATE, 2)


def free_chapters_per_day():
    return FREE_CHAPTERS_PER_DAY


# === Translation (English → Hindi) =========================================
# Sarvam's translate API — purpose-built for Indian languages.
# Used when the user picks "Translate to Hindi" + a Sarvam Hindi voice.

def translate_text(text, source_lang="en", target_lang="hi-IN",
                   mode="classic-colloquial", session=None):
    """Translate text via Sarvam Translate API.

    Returns translated text string, or None on failure.
    """
    if not is_available():
        return None
    if not text or not text.strip():
        return text
    if len(text) > 2000:
        text = text[:2000]

    if session is None:
        import requests
        session = requests.Session()

    payload = {
        "input": text,
        "source_language_code": source_lang,
        "target_language_code": target_lang,
        "mode": mode,
        "model": "sarvam-translate:v1",
    }
    headers = {
        "api-subscription-key": api_key(),
        "Content-Type": "application/json",
    }

    try:
        resp = session.post(
            API_BASE + TRANSLATE_ENDPOINT,
            json=payload, headers=headers, timeout=60)
        if resp.status_code != 200:
            print(f"[sarvam-translate] HTTP {resp.status_code} "
                  f"body={resp.text[:300]}", flush=True)
            return None
        data = resp.json()
        translated = data.get("translated_text") or data.get("output") or ""
        return translated.strip() if translated else None
    except Exception as e:
        print(f"[sarvam-translate] error: {e}")
        return None


def translate_chunked(text, source_lang="en", target_lang="hi-IN",
                      mode="classic-colloquial", chunk_chars=1800,
                      session=None):
    """Translate long text by splitting into Sarvam-sized chunks."""
    if not text:
        return text
    if len(text) <= chunk_chars:
        return translate_text(text, source_lang, target_lang, mode, session)

    if session is None:
        import requests
        session = requests.Session()

    parts = []
    start = 0
    while start < len(text):
        end = min(start + chunk_chars, len(text))
        if end < len(text):
            for i in range(end, max(start, end - 200), -1):
                if text[i - 1] in ".!?":
                    end = i
                    break
        chunk = text[start:end].strip()
        if chunk:
            translated = translate_text(chunk, source_lang, target_lang,
                                        mode, session)
            parts.append(translated if translated else chunk)
        start = end

    return " ".join(parts)
