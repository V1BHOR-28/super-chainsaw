"""BGM (Background Music) asset registry.

Defines the canonical set of musical moods available to the AI-driven BGM
cue system. Each mood (except ``silence``) maps to a royalty-free seamless
loop MP3 shipped under ``assets/bgm/``.

Usage::

    from bgm_registry import MOODS, ASSET_DIR, asset_path_for

    for mood in MOODS:
        path = asset_path_for(mood)  # None for "silence"

The registry is the single source of truth for both the cue generator
(``bgm_cues.py`` — the LLM is constrained to this vocabulary) and the
mixer (``bgm_mix.py`` — resolves a mood to its asset file path).
"""

import os

# ---------------------------------------------------------------------------
# Asset directory — resolved relative to this file so it works regardless of
# the current working directory (Render starts the service from various
# locations, and local dev may cd around).
# ---------------------------------------------------------------------------
_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "bgm")

# ---------------------------------------------------------------------------
# Mood vocabulary.
#
# The order is deliberate: it loosely follows an emotional energy gradient
# from calm → tense → dark → active → emotional → triumphant. The LLM prompt
# enumerates these in this exact order so the model sees a natural progression.
#
# "silence" is a synthetic mood — it means "no music here". It has no asset
# file; the mixer skips it and the runtime frontend simply stops all loops.
# The cue generator uses it for intimate dialogue or reflective passages and
# is required to occupy at least 15 % of total runtime.
# ---------------------------------------------------------------------------
_MOOD_ASSET_MAP = {
    "calm_amb":     "calm_amb.mp3",
    "wonder":       "wonder.mp3",
    "tension_low":  "tension_low.mp3",
    "tension_high": "tension_high.mp3",
    "dread":        "dread.mp3",
    "action":       "action.mp3",
    "sorrow":       "sorrow.mp3",
    "resolve":      "resolve.mp3",
}

# Public tuple — includes "silence" as the last entry. This is the canonical
# enumeration used in the LLM system prompt and in Python-side validation.
MOODS = tuple(_MOOD_ASSET_MAP.keys()) + ("silence",)

# The set of moods that have a real audio asset (everything except silence).
MUSIC_MOODS = frozenset(_MOOD_ASSET_MAP.keys())

# Directory containing the loop MP3s.
ASSET_DIR = _ASSET_DIR


def asset_path_for(mood: str) -> str | None:
    """Return the absolute filesystem path to the loop MP3 for ``mood``.

    Returns ``None`` for ``"silence"`` (no asset) or for an unknown mood.
    Does **not** check whether the file exists on disk — callers that need
    a hard guarantee should use :func:`asset_exists`.
    """
    fname = _MOOD_ASSET_MAP.get(mood)
    if fname is None:
        return None
    return os.path.join(_ASSET_DIR, fname)


def asset_exists(mood: str) -> bool:
    """True if the mood has an asset file present on disk."""
    p = asset_path_for(mood)
    return p is not None and os.path.isfile(p)


def is_valid_mood(mood: str) -> bool:
    """True if ``mood`` is in the canonical :data:`MOODS` tuple."""
    return mood in MOODS
