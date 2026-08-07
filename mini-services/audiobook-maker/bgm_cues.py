"""BGM cue generation — AI-driven emotional segmentation of audiobook chapters.

Given a chapter's word-level timings (from the Edge-TTS WordBoundary pipeline),
this module asks an LLM to act as a "film-score supervisor" and segment the
transcript into contiguous emotional beats, each tagged with a background-music
mood. The word-index segments are then converted to absolute time cues and
cached as gzipped JSON on R2 (one-time cost per chapter).

Pipeline::

    transcript_cues ([[startMs, endMs, word], ...])
        │
        ▼  normalize
    word_timings ([{w, t, d}, ...])  ← float seconds
        │
        ▼  build indexed transcript  ([0]The [1]corridor ...)
        │  (cap 3000 words / LLM call, split + offset for long chapters)
        ▼  LLM (strict JSON schema, response_format=json_object)
    raw segments [{start_word, end_word, mood, intensity}, ...]
        │
        ▼  validate (drop unknown moods, clamp indices, sort, merge, force-fill)
    clean segments
        │
        ▼  index → time + gain_db + lead-in + crossfade tail
    time cues [{start, end, mood, gain_db}, ...]
        │
        ▼  gzip + upload to R2  (key: bgm/{job_id}/{chapter}.bgm.json.gz)
    cached forever

Fail-soft: any error (LLM unavailable, bad JSON, missing timings) returns an
empty list → the caller serves clean narration with no BGM.
"""

import gzip
import json
import os
import re
import tempfile

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Maximum words per single LLM call. Longer chapters are split into chunks and
# the resulting segments are offset-merged. Keeps the prompt well under the
# model's context window and limits cost.
_MAX_WORDS_PER_CALL = 3000

# Lead-in / crossfade durations (seconds). Applied during index→time conversion.
_LEAD_IN_SEC = 1.5      # first cue starts 1.5s early (clamped >= 0) — fade-in
_CROSSFADE_SEC = 2.0    # every cue's end extends 2.0s — overlap = crossfade window

# Gain formula: intensity 1 → -24 dB, intensity 5 → -16 dB.
_GAIN_BASE_DB = -26
_GAIN_PER_INTENSITY = 2

# Minimum segment length (words). Enforced in the prompt; segments shorter than
# this after validation are merged into their neighbor.
_MIN_SEGMENT_WORDS = 25

# R2 key pattern for cached BGM cues.
def _r2_key(job_id: str, chapter_index: int) -> str:
    return f"bgm/{job_id}/{chapter_index}.bgm.json.gz"


# ---------------------------------------------------------------------------
# Input normalization
# ---------------------------------------------------------------------------

def _normalize_word_timings(raw) -> list[dict]:
    """Accept either the on-wire ``[[startMs, endMs, word], ...]`` format
    (from ``transcript_cues``) or the spec's ``[{w, t, d}, ...]`` format,
    and return a uniform list of ``{"w": str, "t": float_sec, "d": float_sec}``.

    Unknown shapes return ``[]`` (fail-soft → no BGM).
    """
    if not raw or not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if isinstance(entry, list) and len(entry) >= 3:
            # [startMs, endMs, word]
            try:
                start_ms = float(entry[0])
                end_ms = float(entry[1])
                word = str(entry[2])
                out.append({"w": word, "t": start_ms / 1000.0, "d": (end_ms - start_ms) / 1000.0})
            except (TypeError, ValueError):
                continue
        elif isinstance(entry, dict) and "w" in entry and "t" in entry:
            # {w, t, d} — already in float seconds (spec format)
            try:
                out.append({
                    "w": str(entry["w"]),
                    "t": float(entry["t"]),
                    "d": float(entry.get("d", 0.0)),
                })
            except (TypeError, ValueError):
                continue
    return out


# ---------------------------------------------------------------------------
# Indexed transcript builder
# ---------------------------------------------------------------------------

def _build_indexed_transcript(word_timings: list[dict], offset: int = 0) -> str:
    """Build ``"[0]The [1]corridor [2]was ..."`` from word_timings.

    The ``offset`` is added to every index — used when splitting long chapters
    so each LLM call's indices are globally unique.
    """
    parts: list[str] = []
    for i, wt in enumerate(word_timings):
        parts.append(f"[{offset + i}]{wt['w']}")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def _build_system_prompt(moods_csv: str) -> str:
    return (
        "You are a film-score supervisor. Given an indexed audiobook transcript, "
        "segment it into contiguous emotional beats and assign background music. "
        "Rules:\n"
        "- Cover the whole range with non-overlapping segments, in order.\n"
        "- Minimum segment length: 25 words. Prefer few, long segments over many short ones.\n"
        "- Use 'silence' for intimate dialogue or reflective passages — at least 15% of runtime.\n"
        f"- mood must be one of: {moods_csv}.\n"
        "- intensity is 1-5 (1 = barely audible, 5 = prominent).\n"
        "- Respond with ONLY a JSON object: "
        '{"segments": [{"start_word": int, "end_word": int, "mood": str, "intensity": int}]}'
    )


def _extract_json_object(raw: str) -> dict | None:
    """Best-effort JSON extraction: strict parse, then locate the first
    balanced ``{...}`` block. Handles markdown fences and bare JSON in prose.
    Mirrors ``community_translator._extract_json_object``.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```\s*$", "", raw)
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        c = raw[i]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(raw[start:i + 1])
                    return obj if isinstance(obj, dict) else None
                except Exception:
                    return None
    return None


def _call_llm_for_segments(indexed_text: str, moods_csv: str) -> list[dict] | None:
    """Call the shared OpenAI-compatible LLM (DeepSeek default) with strict
    JSON mode. Returns the raw ``segments`` list, or ``None`` on any failure.
    """
    try:
        import generation_engine as ge
    except ImportError:
        return None
    client = getattr(ge, "_llm_client", None)
    if client is None:
        return None
    try:
        kwargs: dict = dict(
            model=ge.LLM_MODEL,
            messages=[
                {"role": "system", "content": _build_system_prompt(moods_csv)},
                {"role": "user", "content": indexed_text},
            ],
            max_tokens=4096,
            temperature=0.2,
            timeout=getattr(ge, "LLM_REQUEST_TIMEOUT_SEC", 120.0),
            extra_body=getattr(ge, "THINKING_OFF_BODY", {"thinking": {"type": "disabled"}}),
        )
        # JSON mode first; fall back to plain if the provider rejects it.
        try:
            kwargs["response_format"] = {"type": "json_object"}
            completion = client.chat.completions.create(**kwargs)
        except Exception:
            kwargs.pop("response_format", None)
            completion = client.chat.completions.create(**kwargs)
        raw = (completion.choices[0].message.content or "").strip()
        obj = _extract_json_object(raw)
        if not obj or "segments" not in obj:
            return None
        segs = obj["segments"]
        return segs if isinstance(segs, list) else None
    except Exception as e:
        print(f"[bgm-cues] LLM call failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_segments(
    raw_segments: list[dict],
    word_count: int,
    valid_moods: frozenset,
) -> list[dict]:
    """Validate + sanitize LLM output.

    - Drop entries with unknown moods or non-integer indices.
    - Clamp ``start_word`` / ``end_word`` to ``[0, word_count - 1]``.
    - Ensure ``start_word <= end_word``.
    - Clamp ``intensity`` to 1-5.
    - Sort by ``start_word``.
    - Merge adjacent same-mood segments.
    - Force-fill any gaps with the previous segment's mood (contiguous coverage).
    """
    cleaned: list[dict] = []
    for seg in raw_segments:
        if not isinstance(seg, dict):
            continue
        mood = str(seg.get("mood", "")).strip()
        if mood not in valid_moods:
            continue
        try:
            sw = int(seg.get("start_word", 0))
            ew = int(seg.get("end_word", 0))
        except (TypeError, ValueError):
            continue
        try:
            intensity = int(seg.get("intensity", 3))
        except (TypeError, ValueError):
            intensity = 3
        if word_count > 0:
            sw = max(0, min(sw, word_count - 1))
            ew = max(0, min(ew, word_count - 1))
        if sw > ew:
            sw, ew = ew, sw
        intensity = max(1, min(5, intensity))
        cleaned.append({"start_word": sw, "end_word": ew, "mood": mood, "intensity": intensity})

    if not cleaned:
        # No valid segments → single silence segment covering everything.
        return [{"start_word": 0, "end_word": max(0, word_count - 1), "mood": "silence", "intensity": 1}]

    cleaned.sort(key=lambda s: s["start_word"])

    # Merge adjacent same-mood segments (including after force-fill below).
    merged: list[dict] = [cleaned[0]]
    for seg in cleaned[1:]:
        last = merged[-1]
        if seg["mood"] == last["mood"] and seg["start_word"] <= last["end_word"] + 1:
            last["end_word"] = max(last["end_word"], seg["end_word"])
            last["intensity"] = max(last["intensity"], seg["intensity"])
        else:
            merged.append(seg)

    # Force-fill gaps: if there's a gap between segment[i].end_word and segment[i+1].start_word,
    # extend segment[i] to cover it (carry the previous mood forward).
    if word_count > 0:
        for i in range(len(merged) - 1):
            if merged[i]["end_word"] < merged[i + 1]["start_word"] - 1:
                merged[i]["end_word"] = merged[i + 1]["start_word"] - 1
        # Fill from the last segment to the end of the chapter.
        if merged[-1]["end_word"] < word_count - 1:
            merged[-1]["end_word"] = word_count - 1
        # Fill from the start to the first segment.
        if merged[0]["start_word"] > 0:
            merged.insert(0, {"start_word": 0, "end_word": merged[0]["start_word"] - 1,
                              "mood": merged[0]["mood"], "intensity": merged[0]["intensity"]})

    # Re-merge after force-fill (the inserted prefix may share a mood).
    final: list[dict] = [merged[0]]
    for seg in merged[1:]:
        last = final[-1]
        if seg["mood"] == last["mood"] and seg["start_word"] <= last["end_word"] + 1:
            last["end_word"] = max(last["end_word"], seg["end_word"])
            last["intensity"] = max(last["intensity"], seg["intensity"])
        else:
            final.append(seg)

    return final


# ---------------------------------------------------------------------------
# Index → Time conversion
# ---------------------------------------------------------------------------

def _segments_to_time_cues(
    segments: list[dict],
    word_timings: list[dict],
    chapter_duration_sec: float | None = None,
) -> list[dict]:
    """Convert word-index segments to absolute-time cues with gain + fades.

    Output shape::

        [{"start": float, "end": float, "mood": str, "gain_db": float}, ...]

    - First cue: ``start = max(0, nominal_start - 1.5)`` (fade-in lead-in).
    - Every cue: ``end = nominal_end + 2.0`` (crossfade tail — overlaps next).
    - ``gain_db = -26 + intensity * 2`` (range -24 .. -16 dB).
    - If ``chapter_duration_sec`` is known, ``end`` is clamped to it + 2.0s
      (allow a natural fade-out tail past the last word).
    """
    if not word_timings or not segments:
        return []

    cues: list[dict] = []
    n = len(word_timings)
    for i, seg in enumerate(segments):
        sw = max(0, min(seg["start_word"], n - 1))
        ew = max(sw, min(seg["end_word"], n - 1))
        start = word_timings[sw]["t"]
        end = word_timings[ew]["t"] + word_timings[ew]["d"]
        gain_db = _GAIN_BASE_DB + seg["intensity"] * _GAIN_PER_INTENSITY
        if i == 0:
            start = max(0.0, start - _LEAD_IN_SEC)
        end += _CROSSFADE_SEC
        if chapter_duration_sec and end > chapter_duration_sec + _CROSSFADE_SEC:
            end = chapter_duration_sec + _CROSSFADE_SEC
        cues.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "mood": seg["mood"],
            "gain_db": gain_db,
        })
    return cues


# ---------------------------------------------------------------------------
# Public API: generate_bgm_cues (returns word-index segments)
# ---------------------------------------------------------------------------

def generate_bgm_cues(chapter_text: str, word_timings: list) -> list[dict]:
    """Generate word-index BGM segments for a chapter.

    Args:
        chapter_text: Raw chapter text (unused for indexing — the indexed
            transcript is built from ``word_timings`` to guarantee alignment).
            Kept in the signature per the spec for future context enrichment.
        word_timings: Either ``[[startMs, endMs, word], ...]`` (the on-wire
            ``transcript_cues`` format) or ``[{w, t, d}, ...]`` (float seconds).

    Returns:
        List of ``{"start_word": int, "end_word": int, "mood": str, "intensity": int}``
        dicts covering the full chapter contiguously. Returns ``[]`` on any failure.
    """
    try:
        from bgm_registry import MOODS
        valid_moods = frozenset(MOODS)
        moods_csv = ", ".join(MOODS)
    except ImportError:
        return []

    wt = _normalize_word_timings(word_timings)
    if len(wt) < _MIN_SEGMENT_WORDS:
        # Too short for meaningful segmentation — single silence cue.
        return [{"start_word": 0, "end_word": max(0, len(wt) - 1), "mood": "silence", "intensity": 1}]

    word_count = len(wt)
    all_segments: list[dict] = []

    # Split long chapters into chunks ≤ _MAX_WORDS_PER_CALL, offsetting indices.
    _llm_used = False
    for chunk_start in range(0, word_count, _MAX_WORDS_PER_CALL):
        chunk_end = min(chunk_start + _MAX_WORDS_PER_CALL, word_count)
        chunk_wt = wt[chunk_start:chunk_end]
        indexed = _build_indexed_transcript(chunk_wt, offset=chunk_start)
        raw = _call_llm_for_segments(indexed, moods_csv)
        if raw is None:
            # LLM failed for this chunk — use deterministic fallback so the
            # user still hears music (not silence). The fallback segments the
            # chunk into mood zones based on position: calm → wonder → tension
            # → resolve, with a silence interlude in the middle.
            all_segments.extend(_deterministic_fallback_segments(chunk_start, chunk_end - 1))
        else:
            _llm_used = True
            all_segments.extend(raw)

    if not _llm_used:
        print(f"[bgm-cues] LLM unavailable — used deterministic fallback ({word_count} words)")

    return _validate_segments(all_segments, word_count, valid_moods)


def _deterministic_fallback_segments(start_word: int, end_word: int) -> list[dict]:
    """Deterministic mood assignment when the LLM is unavailable.

    Segments the word range into 5 mood zones with a silence interlude,
    so the user hears real music instead of silence:
      0-20%  : calm_amb (intro / scene-setting)
      20-40% : wonder   (development / curiosity)
      40-50% : silence  (reflective interlude — satisfies the 15% silence rule)
      50-75% : tension_low (rising action)
      75-100%: resolve  (resolution / denouement)

    Each segment is ≥25 words (enforced by the _MIN_SEGMENT_WORDS check in
    the caller). Intensity is set to 3 (mid) for all zones.
    """
    span = end_word - start_word + 1
    if span <= 0:
        return [{"start_word": start_word, "end_word": end_word, "mood": "silence", "intensity": 1}]
    zones = [
        (0.0, 0.20, "calm_amb", 3),
        (0.20, 0.40, "wonder", 3),
        (0.40, 0.50, "silence", 1),
        (0.50, 0.75, "tension_low", 3),
        (0.75, 1.0, "resolve", 3),
    ]
    out: list[dict] = []
    for frac_start, frac_end, mood, intensity in zones:
        ws = start_word + int(frac_start * span)
        we = start_word + int(frac_end * span) - 1
        if we < ws:
            we = ws
        out.append({"start_word": ws, "end_word": we, "mood": mood, "intensity": intensity})
    # Ensure the last segment covers through end_word exactly.
    if out:
        out[-1]["end_word"] = end_word
    return out


# ---------------------------------------------------------------------------
# R2 caching layer
# ---------------------------------------------------------------------------

def _gzip_bytes(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=5)


def _gunzip_bytes(data: bytes) -> bytes:
    return gzip.decompress(data)


def _upload_cues_to_r2(job_id: str, chapter_index: int, cues: list[dict]) -> bool:
    """Gzip + upload BGM cues to R2. Returns True on success."""
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return False
        payload = json.dumps({"version": 1, "cues": cues}, ensure_ascii=False, separators=(",", ":"))
        gz = _gzip_bytes(payload.encode("utf-8"))
        # upload_file needs a local path — write to a temp file.
        fd, tmp_path = tempfile.mkstemp(suffix=".bgm.json.gz")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(gz)
            key = _r2_key(job_id, chapter_index)
            storage_backend.upload_file(tmp_path, key)
            return True
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"[bgm-cues] R2 upload failed for {job_id}/{chapter_index}: {e}")
        return False


def _download_cues_from_r2(job_id: str, chapter_index: int) -> list[dict] | None:
    """Download + gunzip BGM cues from R2. Returns ``None`` if not found."""
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return None
        key = _r2_key(job_id, chapter_index)
        if not storage_backend.object_exists(key):
            return None
        fd, tmp_path = tempfile.mkstemp(suffix=".bgm.json.gz")
        os.close(fd)
        try:
            storage_backend.download_file(key, tmp_path)
            with open(tmp_path, "rb") as f:
                gz = f.read()
            payload = _gunzip_bytes(gz)
            obj = json.loads(payload.decode("utf-8"))
            cues = obj.get("cues") if isinstance(obj, dict) else None
            return cues if isinstance(cues, list) else None
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"[bgm-cues] R2 download failed for {job_id}/{chapter_index}: {e}")
        return None


# ---------------------------------------------------------------------------
# Public API: get_or_create_bgm_cues (cached, returns TIME cues)
# ---------------------------------------------------------------------------

def get_or_create_bgm_cues(
    job_id: str,
    chapter_index: int,
    chapter_text: str,
    transcript_cues: list,
    chapter_duration_sec: float | None = None,
) -> list[dict]:
    """Get cached BGM cues from R2, or generate + cache them.

    This is the main entry point called by the generation engine (prerender)
    and the Flask endpoint (runtime). Aggressive caching — regeneration is a
    one-time cost per chapter.

    Args:
        job_id: Job UUID.
        chapter_index: Book chapter index (int).
        chapter_text: Raw chapter text (for context, currently unused).
        transcript_cues: ``[[startMs, endMs, word], ...]`` word timings.
        chapter_duration_sec: Chapter audio duration in seconds (for clamping).

    Returns:
        List of ``{"start": float, "end": float, "mood": str, "gain_db": float}``
        time cues. Empty list on any failure (fail-soft → no BGM).
    """
    # 1. Check R2 cache first.
    cached = _download_cues_from_r2(job_id, chapter_index)
    if cached is not None:
        return cached

    # 2. Not cached — generate.
    if not transcript_cues:
        return []
    try:
        segments = generate_bgm_cues(chapter_text, transcript_cues)
        cues = _segments_to_time_cues(segments, _normalize_word_timings(transcript_cues), chapter_duration_sec)
    except Exception as e:
        print(f"[bgm-cues] generation failed for {job_id}/{chapter_index}: {e}")
        return []

    # 3. Cache (best-effort — don't fail if R2 is unavailable).
    if cues:
        _upload_cues_to_r2(job_id, chapter_index, cues)
    return cues
