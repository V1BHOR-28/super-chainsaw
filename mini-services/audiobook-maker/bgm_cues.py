"""BGM cue generation — deterministic emotional segmentation of audiobook chapters.

The PRIMARY path is a heuristic scorer (``score_segments_heuristic``) that
detects beats from word-timing gaps and scores each beat against a keyword
lexicon. The LLM path is opt-in via ``ABM_BGM_USE_LLM=1`` and only used
when explicitly enabled AND the shared LLM client is available.

Pipeline::

    transcript_cues ([[startMs, endMs, word], ...])
        │
        ▼  normalize
    word_timings ([{w, t, d}, ...])  ← float seconds
        │
        ▼  score_segments_heuristic()   ← PRIMARY (deterministic, offline)
    segments [{start_word, end_word, mood, intensity}, ...]
        │
        ▼  (optional) LLM override if ABM_BGM_USE_LLM=1 + client available
        │
        ▼  validate (drop unknown moods, clamp indices, sort, merge, force-fill)
    clean segments
        │
        ▼  index → time + gain_db + lead-in + crossfade tail
    time cues [{start, end, mood, gain_db}, ...]
        │
        ▼  gzip + upload to R2  (key: bgm/{job_id}/{chapter}.bgm.json.gz)
    cached forever

Fail-soft: any error returns an empty list → the caller serves clean
narration with no BGM. Never writes an empty list to R2 (poisoned cache
self-heals on next request).
"""

import gzip
import json
import math
import os
import re
import tempfile

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Maximum words per single LLM call (only used when ABM_BGM_USE_LLM=1).
_MAX_WORDS_PER_CALL = 3000

# Lead-in / crossfade durations (seconds). Applied during index→time conversion.
_LEAD_IN_SEC = 1.5      # first cue starts 1.5s early (clamped >= 0) — fade-in
_CROSSFADE_SEC = 2.0    # every cue's end extends 2.0s — overlap = crossfade window

# Gain formula: intensity 1 → -1 dB, intensity 5 → +7 dB.
# Assets are now mastered at -20 LUFS, so these are mixing levels on top of
# properly-loud beds. With bgmVolume=70%:
#   intensity 1: 0.70 × 10^(-1/20)  = 0.62  (clearly audible)
#   intensity 3: 0.70 × 10^(3/20)   = 0.99  (prominent)
#   intensity 5: 0.70 × 10^(7/20)   = 1.57  (clamped to 1.0 by Web Audio)
_GAIN_BASE_DB = -3
_GAIN_PER_INTENSITY = 2

# Minimum segment length (words).
_MIN_SEGMENT_WORDS = 25

# Heuristic scorer constants.
_BEAT_GAP_SEC = 0.45        # gap between words that starts a new beat
_BEAT_MIN_WORDS = 25        # minimum words before a gap can split a beat
_BEAT_MAX_WORDS = 400       # hard cap on beat length
_SILENCE_FLOOR_PCT = 0.10   # at least 10% of words must be silence (lowered from 15%)
_QUOTE_DENSITY_THRESHOLD = 0.25  # > 25% quote marks → silence (intimate dialogue)
_DOMINANT_CAP_PCT = 0.55   # no single mood should cover > 55% of the chapter

# R2 key pattern for cached BGM cues.
def _r2_key(job_id: str, chapter_index: int) -> str:
    return f"bgm/{job_id}/{chapter_index}.bgm.json.gz"


# ---------------------------------------------------------------------------
# Keyword lexicon for the heuristic scorer.
# Matched by simple prefix/stem so "screamed" hits "scream".
# ---------------------------------------------------------------------------

_MOOD_KEYWORDS: dict[str, list[str]] = {
    "dread": [
        "dark", "blood", "corpse", "scream", "shadow", "terror", "cold",
        "dead", "whisper", "grave", "fear", "alone", "howl", "rot", "bone",
        "horror", "nightmare", "demon", "ghost", "haunt", "evil", "wicked",
        "doom", "death", "murder", "kill", "slay", "drown", "abyss", "void",
        "black", "midnight", "crypt", "tomb", "coffin", "shroud", "pale",
        "tremble", "shudder", "dread", "appall", "fright", "panic", "despair",
    ],
    "tension_high": [
        "gun", "sword", "strike", "blow", "shout", "burst", "crash",
        "explode", "fight", "blade", "roar", "danger", "blood-curdling", "warn",
        "attack", "charge", "assault", "combat", "battle", "war", "enemy",
        "threat", "menace", "peril", "jeopardy", "crisis", "emergency", "alarm",
        "siren", "blast", "detonate", "shatter", "smash", "clash", "collide",
        "rage", "fury", "wrath", "fierce", "violent", "brutal", "savage",
    ],
    "tension_low": [
        "wait", "watch", "uneasy", "suspect", "hidden", "secret", "quiet",
        "slow", "tense", "listen", "footstep", "doubt", "creep", "shiver",
        "lurk", "prowl", "stealth", "sneak", "crouch", "peer", "glimpse",
        "shadow", "silhouette", "whisper", "murmur", "rumor", "hunch",
        "forebod", "ominous", "eerie", "unsettl", "nervous", "anxious",
        "wary", "cautious", "vigilant", "alert", "dread", "approach",
        "behind", "breath", "heartbeat", "pulse",
    ],
    "action": [
        "leap", "hurl", "slam", "charge", "fire", "dove", "smash", "race",
        "seize", "hurtle", "run", "ran", "chase", "strike", "dash",
        "sprint", "rush", "bolt", "flee", "escape", "dodge", "duck",
        "jump", "spring", "bound", "vault", "climb", "swing", "throw",
        "catch", "grab", "snatch", "wrench", "tear", "rip", "break",
        "crash", "collide", "plunge", "dive", "soar", "fly", "blast",
    ],
    "sorrow": [
        "wept", "tear", "mourn", "loss", "died", "grief", "farewell",
        "broken", "remember", "gone", "sorrow", "sigh", "lament",
        "cry", "cried", "sob", "wail", "anguish", "heartache", "despair",
        "lonely", "alone", "abandon", "forsake", "desert", "leave", "left",
        "miss", "longing", "yearn", "regret", "remorse", "guilt", "shame",
        "empty", "hollow", "fade", "vanish", "depart", "perish", "fade",
    ],
    "wonder": [
        "star", "vast", "beautiful", "gleam", "ancient", "dream", "light",
        "golden", "sky", "marvel", "wonder", "sacred", "dawn", "endless",
        "magnificent", "glorious", "splendid", "radiant", "luminous", "shimmer",
        "glisten", "sparkle", "glow", "shine", "brilliant", "divine", "celestial",
        "ethereal", "transcendent", "sublime", "breathtaking", "awe", "reverence",
        "mystic", "enchanted", "magical", "crystal", "silver", "azure", "prism",
    ],
    "resolve": [
        "finally", "at last", "stood", "decide", "promise", "home",
        "together", "peace", "ended", "vow", "return", "forgave",
        "triumph", "victory", "success", "achieve", "accomplish", "complete",
        "finish", "conclude", "resolve", "settle", "restore", "renew",
        "heal", "mend", "unite", "embrace", "reunion", "welcome",
        "safe", "secure", "certain", "sure", "confident", "ready",
        "determined", "steadfast", "resolute", "committed", "pledge",
    ],
    "calm_amb": [
        "morning", "walk", "sat", "room", "table", "spoke", "said", "day",
        "house", "road", "garden", "window",
        "door", "chair", "fire", "tea", "book", "read", "write", "letter",
        "quiet", "still", "calm", "peaceful", "gentle", "soft", "warm",
        "comfortable", "cozy", "rest", "relax", "breathe", "sigh",
        "slow", "easy", "simple", "ordinary", "everyday", "familiar", "home",
    ],
}

# Precompute a set of all keywords for quick "does any keyword match" checks.
_ALL_KEYWORDS = set()
for _kws in _MOOD_KEYWORDS.values():
    _ALL_KEYWORDS.update(_kws)


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
# Deterministic heuristic scorer (PRIMARY path)
# ---------------------------------------------------------------------------

def _detect_beats(word_timings: list[dict]) -> list[tuple[int, int]]:
    """Split word_timings into beats based on inter-word gaps.

    A new beat starts when the gap between one word's end and the next word's
    start exceeds ``_BEAT_GAP_SEC`` AND the current beat already has at least
    ``_BEAT_MIN_WORDS`` words. Beats are hard-capped at ``_BEAT_MAX_WORDS``.

    FALLBACK: if no gaps are found (edge-tts produces continuous speech),
    split by sentence endings (. ! ?) so we get multiple beats for variety.
    This ensures the chapter doesn't collapse into a single mood.
    """
    n = len(word_timings)
    if n == 0:
        return []
    beats: list[tuple[int, int]] = []
    beat_start = 0
    for i in range(1, n):
        prev_end = word_timings[i - 1]["t"] + word_timings[i - 1]["d"]
        cur_start = word_timings[i]["t"]
        gap = cur_start - prev_end
        beat_len = i - beat_start
        if (gap >= _BEAT_GAP_SEC and beat_len >= _BEAT_MIN_WORDS) or beat_len >= _BEAT_MAX_WORDS:
            beats.append((beat_start, i - 1))
            beat_start = i
    beats.append((beat_start, n - 1))

    # FALLBACK: if we only got 1 beat (no gaps found), split by sentence
    # endings so the chapter has mood variety. This is critical because
    # edge-tts produces continuous speech with no >0.45s gaps.
    # Group sentences into beats of >= _BEAT_MIN_WORDS words, capped at 100
    # words (smaller than _BEAT_MAX_WORDS so we get variety in short chapters).
    _FALLBACK_MAX_WORDS = 100
    if len(beats) <= 1 and n > _BEAT_MIN_WORDS * 2:
        sentence_beats: list[tuple[int, int]] = []
        beat_start = 0
        for i in range(n):
            w = word_timings[i]["w"]
            beat_len = i - beat_start + 1
            # End a beat at a sentence ending IF we have enough words,
            # OR if we've hit the fallback max beat size.
            if ((w.endswith(".") or w.endswith("!") or w.endswith("?")) and beat_len >= _BEAT_MIN_WORDS) or beat_len >= _FALLBACK_MAX_WORDS:
                sentence_beats.append((beat_start, i))
                beat_start = i + 1
        if beat_start < n:
            sentence_beats.append((beat_start, n - 1))
        if len(sentence_beats) > 1:
            beats = sentence_beats

    return beats


def _stem(word: str) -> str:
    """Crude stemmer: lowercase + strip common suffixes so 'screamed' → 'scream'.
    Not a real NLP stemmer — just good enough for keyword matching.
    """
    w = word.lower().strip(".,!?;:\"'()[]—–-")
    if len(w) <= 3:
        return w
    for suffix in ("ing", "ed", "es", "s", "ly", "d"):
        if w.endswith(suffix) and len(w) > len(suffix) + 2:
            return w[: -len(suffix)]
    return w


def _count_sentence_endings(words: list[str]) -> tuple[int, int]:
    """Count sentence-ending punctuation and exclamation/question marks.
    Returns (total_sentence_endings, exclam_count + question_count).
    """
    sent_end = 0
    excl_q = 0
    for w in words:
        if w.endswith(".") or w.endswith("!") or w.endswith("?"):
            sent_end += 1
            if w.endswith("!") or w.endswith("?"):
                excl_q += 1
    return sent_end, excl_q


def _quote_density(words: list[str]) -> float:
    """Fraction of words that contain a quote mark (" or ').
    High density → intimate dialogue → assign silence.
    """
    if not words:
        return 0.0
    q = sum(1 for w in words if '"' in w or "'" in w)
    return q / len(words)


def _score_beat(beat_words: list[str], palette_bonus: dict[str, int] | None = None) -> tuple[str, int, dict[str, int]]:
    """Score a beat's words against the keyword lexicon.

    Args:
        beat_words: List of words in this beat.
        palette_bonus: Chapter-level top-2 mood bonus (+2 each), or None.

    Returns ``(mood, intensity, scores)`` where ``scores`` is the per-mood
    score dict. Keyword hits are weighted by 1/log(1+total_words) so long
    beats don't automatically win on raw counts.
    """
    stems = [_stem(w) for w in beat_words]
    n = len(stems)
    if n == 0:
        return "calm_amb", 2, {}

    # Weight factor: 1/log(1+n) — longer beats get slightly lower per-hit weight
    # so a 400-word beat doesn't auto-win over a 50-word beat with the same density.
    weight = 1.0 / max(1.0, math.log(1 + n) * 0.5)

    # Count keyword hits per mood (weighted).
    scores: dict[str, int] = {m: 0 for m in _MOOD_KEYWORDS}
    for s in stems:
        for mood, keywords in _MOOD_KEYWORDS.items():
            for kw in keywords:
                kw_stem = _stem(kw)
                if len(s) >= 3 and len(kw_stem) >= 3:
                    if s == kw_stem or s.startswith(kw_stem) or kw_stem.startswith(s):
                        scores[mood] += max(1, int(weight))
                        break

    # Apply chapter-level palette bonus.
    if palette_bonus:
        for mood, bonus in palette_bonus.items():
            scores[mood] += bonus

    # Punctuation density modifiers.
    _, excl_q = _count_sentence_endings(beat_words)
    excl_q_pct = excl_q / n if n > 0 else 0
    if excl_q_pct > 0.03:
        scores["tension_high"] += 2
        scores["action"] += 2

    # Sentence length modifiers.
    sent_words: list[list[str]] = []
    cur: list[str] = []
    for w in beat_words:
        cur.append(w)
        if w.endswith(".") or w.endswith("!") or w.endswith("?"):
            sent_words.append(cur)
            cur = []
    if cur:
        sent_words.append(cur)
    avg_sent_len = sum(len(s) for s in sent_words) / len(sent_words) if sent_words else n
    if avg_sent_len < 9:
        scores["action"] += 1
    if avg_sent_len > 22:
        scores["calm_amb"] += 1
        scores["wonder"] += 1

    # Find winner.
    sorted_scores = sorted(scores.items(), key=lambda x: -x[1])
    winner_mood = "calm_amb"
    winner_score = 0
    runner_up = 0
    if sorted_scores and sorted_scores[0][1] > 0:
        winner_mood = sorted_scores[0][0]
        winner_score = sorted_scores[0][1]
        runner_up = sorted_scores[1][1] if len(sorted_scores) > 1 else 0

    # Silence override: high quote density or zero score.
    if winner_score == 0 or _quote_density(beat_words) > _QUOTE_DENSITY_THRESHOLD:
        return "silence", 1, scores

    # Intensity from margin: margin 0 → 2, margin >= 6 → 5.
    margin = winner_score - runner_up
    intensity = max(1, min(5, 2 + int(margin)))
    return winner_mood, intensity, scores


def _chapter_palette(word_timings: list[dict]) -> dict[str, int]:
    """Compute the chapter's top-2 moods and return a bonus dict.

    Scores ALL words in the chapter against the keyword lexicon, picks the
    top 2 moods, and returns {mood: +2} for each. This makes chapter A
    dread-leaning and chapter B wonder-leaning instead of both defaulting
    to calm_amb.
    """
    all_words = [wt["w"] for wt in word_timings]
    _mood, _int, scores = _score_beat(all_words)
    sorted_moods = sorted(scores.items(), key=lambda x: -x[1])
    palette: dict[str, int] = {}
    for mood, score in sorted_moods[:2]:
        if score > 0:
            palette[mood] = 2
    return palette


def score_segments_heuristic(word_timings: list[dict]) -> list[dict]:
    """Deterministic mood segmentation — the PRIMARY cue generator.

    Improvements over the old version:
      1. Chapter-level palette: top-2 moods get +2 bonus per beat.
      2. Anti-monotony: if a mood would cover > 55% of the chapter, the
         2nd-place mood takes over beats where its score is within 2 of
         the winner.
      3. Lower silence floor (10% instead of 15%).
      4. Expanded keyword lexicon (40+ stems per mood).
      5. Keyword hits weighted by 1/log(1+beat_words) so long beats
         don't auto-win.
      6. Zero-score beats inherit the PREVIOUS beat's mood at intensity 1
         instead of defaulting to calm_amb.
    """
    n = len(word_timings)
    if n == 0:
        return []

    # Step 1 — chapter-level palette (top-2 moods get +2 bonus).
    palette = _chapter_palette(word_timings)

    # Step 2 — beat detection.
    beats = _detect_beats(word_timings)

    # Steps 3-4 — score each beat with palette bonus.
    raw_segments: list[dict] = []
    prev_mood = None
    for start_idx, end_idx in beats:
        beat_words = [word_timings[j]["w"] for j in range(start_idx, end_idx + 1)]
        mood, intensity, scores = _score_beat(beat_words, palette)

        # Zero-score beat inherits the previous beat's mood at intensity 1.
        if mood == "silence" and prev_mood and prev_mood != "silence":
            # Check if this was a zero-score beat (not a quote-density silence)
            if _quote_density(beat_words) <= _QUOTE_DENSITY_THRESHOLD:
                mood = prev_mood
                intensity = 1

        raw_segments.append({
            "start_word": start_idx,
            "end_word": end_idx,
            "mood": mood,
            "intensity": intensity,
            "_scores": scores,  # keep for anti-monotony pass
        })
        prev_mood = mood

    # Step 5a — anti-monotony: if a mood covers > 55%, give 2nd-place mood
    # the beats where its score is within 2 of the winner.
    total_words = n
    mood_words: dict[str, int] = {}
    for seg in raw_segments:
        w = seg["end_word"] - seg["start_word"] + 1
        mood_words[seg["mood"]] = mood_words.get(seg["mood"], 0) + w

    dominant_mood = max(mood_words, key=mood_words.get) if mood_words else None
    if dominant_mood and dominant_mood != "silence":
        dominant_pct = mood_words[dominant_mood] / total_words
        if dominant_pct > _DOMINANT_CAP_PCT:
            # Find 2nd-place mood by looking at per-beat runner-up scores
            # (not just the winner histogram, which may only have 1 entry).
            runner_up_totals: dict[str, int] = {}
            for seg in raw_segments:
                scores = seg.get("_scores", {})
                sorted_scores = sorted(scores.items(), key=lambda x: -x[1])
                for m, s in sorted_scores:
                    if m != dominant_mood and m != "silence" and s > 0:
                        runner_up_totals[m] = runner_up_totals.get(m, 0) + s
                        break
            second_mood = max(runner_up_totals, key=runner_up_totals.get) if runner_up_totals else None
            if second_mood:
                # Reassign beats where 2nd mood score is within 2 of winner.
                for seg in raw_segments:
                    if seg["mood"] == dominant_mood:
                        scores = seg.get("_scores", {})
                        winner_score = scores.get(dominant_mood, 0)
                        second_score = scores.get(second_mood, 0)
                        if second_score > 0 and (winner_score - second_score) <= 2:
                            seg["mood"] = second_mood
                            seg["intensity"] = max(1, seg.get("intensity", 2) - 1)

            # Re-check: if still > 55%, reassign beats with the smallest
            # winner margin (even if > 2) until we're under the cap.
            mood_words2: dict[str, int] = {}
            for seg in raw_segments:
                w = seg["end_word"] - seg["start_word"] + 1
                mood_words2[seg["mood"]] = mood_words2.get(seg["mood"], 0) + w
            dom2 = max(mood_words2, key=mood_words2.get) if mood_words2 else None
            if dom2 == dominant_mood and mood_words2.get(dom2, 0) / total_words > _DOMINANT_CAP_PCT:
                # Sort dominant beats by smallest margin and reassign.
                dominant_beats = [(i, seg) for i, seg in enumerate(raw_segments) if seg["mood"] == dominant_mood]
                dominant_beats.sort(key=lambda x: x[1].get("_scores", {}).get(dominant_mood, 0) - x[1].get("_scores", {}).get(second_mood, 0))
                for _, seg in dominant_beats:
                    if mood_words2.get(dominant_mood, 0) / total_words <= _DOMINANT_CAP_PCT:
                        break
                    w = seg["end_word"] - seg["start_word"] + 1
                    seg["mood"] = second_mood
                    seg["intensity"] = max(1, seg.get("intensity", 2) - 1)
                    mood_words2[dominant_mood] -= w
                    mood_words2[second_mood] = mood_words2.get(second_mood, 0) + w

    # Step 5b — merge adjacent same-mood beats.
    merged: list[dict] = []
    for seg in raw_segments:
        clean = {k: v for k, v in seg.items() if not k.startswith("_")}
        if merged and clean["mood"] == merged[-1]["mood"]:
            merged[-1]["end_word"] = clean["end_word"]
            merged[-1]["intensity"] = max(merged[-1]["intensity"], clean["intensity"])
        else:
            merged.append(clean)

    # Step 5c — enforce 10% silence floor.
    # BUT: never convert the ONLY non-silence segment (would make the whole
    # chapter silent). Only convert if there are multiple non-silence segments.
    silence_words = sum(s["end_word"] - s["start_word"] + 1 for s in merged if s["mood"] == "silence")
    non_silence_list = [s for s in merged if s["mood"] != "silence"]
    if total_words > 0 and silence_words < total_words * _SILENCE_FLOOR_PCT and len(non_silence_list) > 1:
        deficit = int(total_words * _SILENCE_FLOOR_PCT) - silence_words
        non_silence_list.sort(key=lambda s: s["end_word"] - s["start_word"] + 1)
        # Convert shortest non-silence segments to silence, but keep at least one.
        for s in non_silence_list[:-1]:
            if deficit <= 0:
                break
            w = s["end_word"] - s["start_word"] + 1
            s["mood"] = "silence"
            s["intensity"] = 1
            deficit -= w
        # Re-merge.
        re_merged: list[dict] = []
        for seg in merged:
            if re_merged and seg["mood"] == re_merged[-1]["mood"]:
                re_merged[-1]["end_word"] = seg["end_word"]
                re_merged[-1]["intensity"] = max(re_merged[-1]["intensity"], seg["intensity"])
            else:
                re_merged.append(dict(seg))
        merged = re_merged

    # Step 5d — guarantee contiguous coverage of 0..n-1.
    if not merged:
        return [{"start_word": 0, "end_word": n - 1, "mood": "silence", "intensity": 1}]
    merged[0]["start_word"] = 0
    merged[-1]["end_word"] = n - 1
    for i in range(len(merged) - 1):
        if merged[i]["end_word"] < merged[i + 1]["start_word"] - 1:
            merged[i]["end_word"] = merged[i + 1]["start_word"] - 1
    # Final re-merge.
    final: list[dict] = [merged[0]]
    for seg in merged[1:]:
        if seg["mood"] == final[-1]["mood"] and seg["start_word"] <= final[-1]["end_word"] + 1:
            final[-1]["end_word"] = max(final[-1]["end_word"], seg["end_word"])
            final[-1]["intensity"] = max(final[-1]["intensity"], seg["intensity"])
        else:
            final.append(seg)

    # Step 6 — verify variety: at least 4 distinct non-silence moods or 6 changes.
    distinct_moods = set(s["mood"] for s in final if s["mood"] != "silence")
    mood_changes = sum(1 for i in range(1, len(final)) if final[i]["mood"] != final[i-1]["mood"])
    if len(distinct_moods) < 4 and mood_changes < 6:
        print(f"[bgm-cues] WARNING: low variety — {len(distinct_moods)} moods, {mood_changes} changes. Histogram: {mood_words}")

    return final


# ---------------------------------------------------------------------------
# Public API: generate_bgm_cues (returns word-index segments)
# ---------------------------------------------------------------------------

def generate_bgm_cues(chapter_text: str, word_timings: list) -> list[dict]:
    """Generate word-index BGM segments for a chapter.

    The PRIMARY path is the deterministic heuristic scorer
    (``score_segments_heuristic``). The LLM path is opt-in via
    ``ABM_BGM_USE_LLM=1`` AND requires the shared LLM client to be available.
    On any LLM failure, the heuristic segments are kept silently.

    Args:
        chapter_text: Raw chapter text (unused by the heuristic — the indexed
            transcript is built from ``word_timings`` to guarantee alignment).
        word_timings: Either ``[[startMs, endMs, word], ...]`` (the on-wire
            ``transcript_cues`` format) or ``[{w, t, d}, ...]`` (float seconds).

    Returns:
        List of ``{"start_word": int, "end_word": int, "mood": str, "intensity": int}``
        dicts covering the full chapter contiguously. Never returns ``[]`` when
        word timings exist.
    """
    try:
        from bgm_registry import MOODS
        valid_moods = frozenset(MOODS)
    except ImportError:
        return []

    wt = _normalize_word_timings(word_timings)
    word_count = len(wt)
    if word_count == 0:
        return []
    if word_count < _MIN_SEGMENT_WORDS:
        # Too short for beat detection — single silence cue.
        return [{"start_word": 0, "end_word": word_count - 1, "mood": "silence", "intensity": 1}]

    # PRIMARY: deterministic heuristic scorer.
    segments = score_segments_heuristic(wt)

    # OPTIONAL: LLM override (only if explicitly enabled + client available).
    if os.environ.get("ABM_BGM_USE_LLM") == "1":
        try:
            import generation_engine as ge
            client = getattr(ge, "_llm_client", None)
            if client is not None:
                moods_csv = ", ".join(MOODS)
                llm_segments: list[dict] = []
                for chunk_start in range(0, word_count, _MAX_WORDS_PER_CALL):
                    chunk_end = min(chunk_start + _MAX_WORDS_PER_CALL, word_count)
                    chunk_wt = wt[chunk_start:chunk_end]
                    indexed = _build_indexed_transcript(chunk_wt, offset=chunk_start)
                    raw = _call_llm_for_segments(indexed, moods_csv)
                    if raw is not None:
                        llm_segments.extend(raw)
                # Only override if the LLM produced valid segments.
                if llm_segments:
                    validated = _validate_segments(llm_segments, word_count, valid_moods)
                    if validated:
                        print(f"[bgm-cues] LLM override used ({word_count} words, {len(validated)} segments)")
                        return validated
        except Exception as e:
            print(f"[bgm-cues] LLM override failed (keeping heuristic): {e}")

    return _validate_segments(segments, word_count, valid_moods)


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

    Diagnostic logging: prints one of "cache hit (n cues)" / "cache miss" /
    "generated n cues" / "returning EMPTY: <reason>" for every call.

    Self-healing: a cached EMPTY list is treated as a cache MISS so poisoned
    cache entries self-heal on the next request. Never writes an empty list
    to R2.

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
    tag = f"[bgm-cues] {job_id}/{chapter_index}:"

    # 1. Check R2 cache first.
    cached = _download_cues_from_r2(job_id, chapter_index)
    if cached is not None and len(cached) > 0:
        print(f"{tag} cache hit ({len(cached)} cues)")
        return cached
    if cached is not None and len(cached) == 0:
        # Poisoned cache entry — treat as MISS so it self-heals.
        print(f"{tag} cache miss (cached empty list ignored — self-healing)")
        cached = None
    else:
        print(f"{tag} cache miss")

    # 2. Not cached — generate.
    if not transcript_cues:
        print(f"{tag} returning EMPTY: no transcript_cues")
        return []
    try:
        segments = generate_bgm_cues(chapter_text, transcript_cues)
        if not segments:
            print(f"{tag} returning EMPTY: generate_bgm_cues returned no segments")
            return []
        cues = _segments_to_time_cues(segments, _normalize_word_timings(transcript_cues), chapter_duration_sec)
        if not cues:
            print(f"{tag} returning EMPTY: _segments_to_time_cues produced no cues")
            return []
        print(f"{tag} generated {len(cues)} cues")
    except Exception as e:
        print(f"{tag} returning EMPTY: generation failed: {e}")
        return []

    # 3. Cache (best-effort — never write an empty list, never fail on R2).
    _upload_cues_to_r2(job_id, chapter_index, cues)
    return cues
