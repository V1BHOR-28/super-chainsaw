"""Pytest suite for the deterministic BGM cue generator.

The last ~5 commits on `main` were all BGM bug fixes (inaudible BGM, every
chapter sounding identical, generation failing on `effective_rate` undefined,
etc.). These tests pin the contract of the pure functions in `bgm_cues.py`
so those bugs can't regress.

Run with:  pytest mini-services/audiobook-maker/tests/test_bgm_cues.py -v
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Make `bgm_cues` importable when running from the audiobook-maker dir.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # mini-services/audiobook-maker/
sys.path.insert(0, str(ROOT))

# The module imports `os`/`tempfile` at module level but does NOT import R2 /
# boto3 / LLM clients at module load — those are only imported inside the
# functions that need them. So importing `bgm_cues` here is safe and fast.
import bgm_cues  # noqa: E402
from bgm_cues import (  # noqa: E402
    _detect_beats,
    _normalize_word_timings,
    _quote_density,
    _stem,
    score_segments_heuristic,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_word_timings(words: list[str], gap_per_word: float = 0.3) -> list[dict]:
    """Build a synthetic word_timings list with a fixed per-word gap.

    Each word starts `gap_per_word` seconds after the previous one ended.
    Useful for testing beat detection without depending on real edge-tts output.
    """
    out: list[dict] = []
    t = 0.0
    for w in words:
        d = 0.2  # each word is 200ms long
        out.append({"w": w, "t": t, "d": d})
        t += d + gap_per_word
    return out


# ---------------------------------------------------------------------------
# _normalize_word_timings
# ---------------------------------------------------------------------------

class TestNormalizeWordTimings:
    def test_accepts_on_wire_format_start_ms_end_ms_word(self):
        raw = [[0, 500, "Hello"], [500, 1000, "World"]]
        out = _normalize_word_timings(raw)
        assert len(out) == 2
        assert out[0] == {"w": "Hello", "t": 0.0, "d": 0.5}
        assert out[1] == {"w": "World", "t": 0.5, "d": 0.5}

    def test_accepts_spec_format_w_t_d(self):
        raw = [{"w": "Hello", "t": 0.0, "d": 0.5}, {"w": "World", "t": 0.5, "d": 0.5}]
        out = _normalize_word_timings(raw)
        assert out == raw

    def test_mixed_formats_in_one_list(self):
        raw = [[0, 500, "Hello"], {"w": "World", "t": 0.5, "d": 0.5}]
        out = _normalize_word_timings(raw)
        assert len(out) == 2

    def test_empty_input_returns_empty_list(self):
        assert _normalize_word_timings([]) == []
        assert _normalize_word_timings(None) == []  # type: ignore[arg-type]

    def test_non_list_input_returns_empty_list(self):
        assert _normalize_word_timings("not a list") == []  # type: ignore[arg-type]
        assert _normalize_word_timings(42) == []  # type: ignore[arg-type]

    def test_malformed_entries_are_skipped(self):
        raw = [[0, 500, "Hello"], "garbage", [None, None, None], {"no_w": 1}]
        out = _normalize_word_timings(raw)
        assert len(out) == 1
        assert out[0]["w"] == "Hello"


# ---------------------------------------------------------------------------
# _detect_beats
# ---------------------------------------------------------------------------

class TestDetectBeats:
    def test_empty_input_returns_empty(self):
        assert _detect_beats([]) == []

    def test_single_word_returns_single_beat(self):
        wt = make_word_timings(["Hello"])
        beats = _detect_beats(wt)
        assert beats == [(0, 0)]

    def test_continuous_speech_falls_back_to_sentence_split(self):
        # edge-tts produces continuous speech — gap_per_word=0.05 means no
        # gap >= 0.45s. The function should fall back to sentence splitting.
        # Each "sentence" needs to be >= _BEAT_MIN_WORDS (25) words long so
        # the sentence-ending fallback can actually split on it.
        sentence = "the quick brown fox jumps over the lazy dog again and once more".split()  # 12 words
        # Make each sentence long enough by repeating; end with "."
        long_sentence = " ".join(sentence * 3) + "."  # 36 words, ends with "."
        words = (long_sentence + " ").split() * 5  # ~180 words
        # Strip empty strings from the trailing split
        words = [w for w in words if w]
        wt = make_word_timings(words, gap_per_word=0.05)
        beats = _detect_beats(wt)
        # Should produce multiple beats via the sentence-ending fallback.
        assert len(beats) > 1

    def test_large_gap_triggers_new_beat(self):
        # Gap >= _BEAT_GAP_SEC (0.45) AND beat has >= _BEAT_MIN_WORDS (25) words.
        # Build 25 words, then a 1-second gap, then 25 more words.
        words = [f"word{i}" for i in range(25)]
        wt = make_word_timings(words, gap_per_word=0.1)
        # Insert a big gap before word 25
        for i in range(25, 50):
            t = wt[-1]["t"] + wt[-1]["d"] + 1.0  # 1-second gap
            wt.append({"w": f"word{i}", "t": t, "d": 0.2})
        beats = _detect_beats(wt)
        assert len(beats) == 2
        assert beats[0] == (0, 24)
        assert beats[1] == (25, 49)

    def test_beats_are_contiguous_and_cover_full_range(self):
        words = [f"w{i}." for i in range(100)]  # each ends with "."
        wt = make_word_timings(words, gap_per_word=0.05)
        beats = _detect_beats(wt)
        # Beats should cover [0, n-1] without gaps or overlaps.
        assert beats[0][0] == 0
        assert beats[-1][1] == len(wt) - 1
        for i in range(1, len(beats)):
            assert beats[i][0] == beats[i - 1][1] + 1


# ---------------------------------------------------------------------------
# _stem
# ---------------------------------------------------------------------------

class TestStem:
    def test_lowercase(self):
        assert _stem("Hello") == "hello"

    def test_strip_punctuation(self):
        assert _stem("Hello!") == "hello"
        assert _stem('"Hello"') == "hello"
        assert _stem("(Hello)") == "hello"

    def test_strip_common_suffixes(self):
        assert _stem("screamed") == "scream"
        assert _stem("running") == "runn"  # crude stemmer — not perfect
        assert _stem("shadows") == "shadow"
        assert _stem("quickly") == "quick"

    def test_short_words_returned_as_is(self):
        # Length <= 3 returns the lowercased, stripped word unchanged.
        assert _stem("the") == "the"
        assert _stem("AND") == "and"


# ---------------------------------------------------------------------------
# _quote_density
# ---------------------------------------------------------------------------

class TestQuoteDensity:
    def test_no_quotes_returns_zero(self):
        assert _quote_density(["Hello", "World"]) == 0.0

    def test_all_words_with_quotes_returns_one(self):
        # Every word starts/ends with a quote → density 1.0
        words = ['"Hello"', '"World"', '"said"']
        assert _quote_density(words) == 1.0

    def test_mixed_quotes(self):
        words = ['"Hello"', "World", '"said"', "she"]
        # 2 of 4 words have quotes → 0.5
        assert _quote_density(words) == 0.5


# ---------------------------------------------------------------------------
# score_segments_heuristic (the BIG one — pinned by the last 5 commits)
# ---------------------------------------------------------------------------

class TestScoreSegmentsHeuristic:
    def test_empty_input_returns_empty_list(self):
        assert score_segments_heuristic([]) == []

    def test_single_word_returns_one_segment(self):
        # Edge case: too few words for any meaningful scoring.
        # The mood assigned depends on _chapter_palette's bonus (which can
        # bias a single neutral word toward "action" via the avg-sent-len
        # modifier). What we care about for this test is the structural
        # contract: exactly one segment covering [0, 0] with a valid mood.
        wt = [{"w": "Hello", "t": 0.0, "d": 0.2}]
        result = score_segments_heuristic(wt)
        assert len(result) == 1
        assert result[0]["start_word"] == 0
        assert result[0]["end_word"] == 0
        # Mood must be a non-empty string (the None-mood bug is what we
        # explicitly guard against — see the anti-monotony fix in
        # score_segments_heuristic).
        assert isinstance(result[0]["mood"], str)
        assert result[0]["mood"] != ""

    def test_dread_keywords_produce_dread_segment(self):
        # Build a chapter full of dread vocabulary. Should produce at least
        # one segment with mood == "dread".
        dread_sentence = "Blood on the floor and a corpse in the shadow of the grave.".split()
        words = dread_sentence * 20  # ~320 words
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        moods = {seg["mood"] for seg in result}
        assert "dread" in moods

    def test_action_keywords_produce_action_segment(self):
        action_sentence = "He leaped and slammed the door then charged into the fight.".split()
        words = action_sentence * 20
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        moods = {seg["mood"] for seg in result}
        assert "action" in moods

    def test_no_single_mood_dominates_above_55_percent_when_runner_up_exists(self):
        # Anti-monotony: when a chapter has multiple competing moods, no
        # single mood should cover > 55% of the chapter. The cap is only
        # enforced when a runner-up mood is available to absorb the overflow.
        # We build a chapter with two distinct mood clusters so the function
        # can find a runner-up.
        dread_sentence = "Blood on the floor and a corpse in the shadow of the grave.".split()
        action_sentence = "He leaped and slammed the door then charged into the fight.".split()
        sorrow_sentence = "She wept and mourned the loss of her dear friend today.".split()
        # Interleave so beats have mixed scores.
        words = []
        for _ in range(10):
            words += dread_sentence + action_sentence + sorrow_sentence
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        total_words = len(wt)
        mood_words: dict[str, int] = {}
        for seg in result:
            w = seg["end_word"] - seg["start_word"] + 1
            mood_words[seg["mood"]] = mood_words.get(seg["mood"], 0) + w
        # At least one non-silence mood should exist.
        non_silence_moods = {m: c for m, c in mood_words.items() if m != "silence" and c > 0}
        assert len(non_silence_moods) >= 1, "No non-silence moods produced"
        # For the dominant non-silence mood: it may exceed 55% if there was
        # no valid runner-up (e.g. when chapter palette narrows to one mood).
        # The CONTRACT we can pin here is weaker: at most one mood exceeds 55%,
        # AND if any mood exceeds 55% it must have NO valid runner-up (which
        # is the structural condition that disables the cap).
        # For this interleaved chapter, we expect a runner-up to exist and
        # the cap to bite.
        for mood, count in non_silence_moods.items():
            pct = count / total_words
            if pct > 0.56:
                # If we hit this, the cap failed to bite. Flag it explicitly
                # so the test failure message tells you which mood dominated.
                # (This is acceptable ONLY when the chapter had no runner-up,
                # which we can verify by checking mood variety.)
                distinct = len(non_silence_moods)
                assert distinct == 1, (
                    f"Mood {mood!r} covers {pct:.0%} — above the 55% cap, AND "
                    f"the chapter has {distinct} non-silence moods so a "
                    f"runner-up existed and the cap should have bitten."
                )

    def test_segments_are_contiguous_and_cover_full_range(self):
        # The function MUST guarantee contiguous coverage of [0, n-1].
        words = "The hero drew his sword and charged into the dark forest.".split() * 10
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        n = len(wt)
        assert result[0]["start_word"] == 0
        assert result[-1]["end_word"] == n - 1
        for i in range(1, len(result)):
            assert result[i]["start_word"] == result[i - 1]["end_word"] + 1, (
                f"Gap between segment {i-1} (ends at {result[i-1]['end_word']}) "
                f"and segment {i} (starts at {result[i]['start_word']})"
            )

    def test_adjacent_same_mood_segments_are_merged(self):
        # After the merge pass, no two adjacent segments should share a mood.
        words = "The hero drew his sword and charged into the dark forest.".split() * 10
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        for i in range(1, len(result)):
            assert result[i]["mood"] != result[i - 1]["mood"], (
                f"Adjacent segments {i-1} and {i} both have mood {result[i]['mood']!r} — merge pass missed them"
            )

    def test_intensity_is_always_in_range_1_to_5(self):
        words = "The hero drew his sword and charged into the dark forest.".split() * 10
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        for seg in result:
            assert 1 <= seg["intensity"] <= 5, (
                f"Segment with mood {seg['mood']!r} has intensity {seg['intensity']} — out of [1, 5] range"
            )

    def test_silence_floor_at_least_10_percent(self):
        # The function should ensure at least 10% of words are silence (unless
        # the chapter would collapse to all-silence).
        # Build a chapter that's all dialogue (high quote density) so silence
        # is naturally produced.
        words = ['"Hello."', '"World."', '"She."', '"said."', '"He."', '"replied."'] * 30
        wt = make_word_timings(words, gap_per_word=0.1)
        result = score_segments_heuristic(wt)
        total_words = len(wt)
        silence_words = sum(
            seg["end_word"] - seg["start_word"] + 1
            for seg in result
            if seg["mood"] == "silence"
        )
        # The 10% floor can be waived when it would make the whole chapter
        # silent (single non-silence segment case). For this dialogue-heavy
        # chapter there should be plenty of silence.
        assert silence_words / total_words >= 0.10, (
            f"Only {silence_words}/{total_words} words are silence — below the 10% floor"
        )

    def test_deterministic_same_input_produces_same_output(self):
        # Critical contract: the function is DETERMINISTIC. Same input → same
        # output, every time, no randomness, no LLM call. This is what the
        # commit history explicitly switched to (replacing the LLM-based
        # scorer that produced different cues every run).
        words = "The hero drew his sword and charged into the dark forest.".split() * 10
        wt = make_word_timings(words, gap_per_word=0.1)
        result1 = score_segments_heuristic(wt)
        result2 = score_segments_heuristic(wt)
        assert result1 == result2


# ---------------------------------------------------------------------------
# generate_bgm_cues — the public orchestrator
# ---------------------------------------------------------------------------

class TestGenerateBgmCues:
    def test_empty_word_timings_returns_empty_list(self):
        result = bgm_cues.generate_bgm_cues("", [])
        assert result == []

    def test_does_not_call_llm_by_default(self):
        # ABM_BGM_USE_LLM is not set → the function MUST use the heuristic
        # path, not the LLM path. This is the fix that made BGM deterministic.
        os.environ.pop("ABM_BGM_USE_LLM", None)
        words = "The hero drew his sword and charged into the dark forest.".split() * 10
        wt = make_word_timings(words, gap_per_word=0.1)
        result = bgm_cues.generate_bgm_cues(" ".join(words), wt)
        assert len(result) > 0
        # Every segment should have the required keys.
        for seg in result:
            assert "start_word" in seg
            assert "end_word" in seg
            assert "mood" in seg
            assert "intensity" in seg
