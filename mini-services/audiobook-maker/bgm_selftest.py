#!/usr/bin/env python3
"""bgm_selftest.py — diagnostic self-test for the BGM cue pipeline.

Takes a job_id and chapter index, loads the stored transcript cues from
the Flask app's in-memory job dict (or reconstructs from Storj), runs
the heuristic scorer, and prints a table of
(start, end, mood, intensity, gain_db) plus total runtime coverage %
and silence %.

Usage (from the audiobook-maker directory):
    python3 bgm_selftest.py <job_id> <chapter_index>

Or import as a module:
    from bgm_selftest import run_selftest
    run_selftest(job_id, chapter_index)
"""

import sys
import os


def run_selftest(job_id: str, chapter_index: int):
    """Run the BGM self-test for a specific job + chapter."""
    # Ensure we can import the BGM modules.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    import bgm_cues
    import bgm_registry

    # Try to load the job from the Flask app's in-memory dict.
    # We import audiobook_app lazily so this script can also run standalone
    # (without the Flask app running) if we can access the job data directly.
    transcript_cues = None
    chapter_duration_sec = None

    try:
        import audiobook_app
        from audiobook_app import jobs, _jobs_lock, _reconstruct_job_from_storj

        # Access the job directly from the in-memory dict (no request context needed).
        with _jobs_lock:
            job = jobs.get(job_id)

        if job is None:
            # Try reconstruction from the durable registry + Storj.
            # This requires a fallback_record (download token snapshot).
            try:
                from audiobook_app import _download_tokens
                fallback = None
                for _tok, _tinfo in _download_tokens.items():
                    if isinstance(_tinfo, dict) and _tinfo.get("job_id") == job_id:
                        fallback = _tinfo
                        break
                if fallback:
                    job = _reconstruct_job_from_storj(job_id, fallback_record=fallback)
            except Exception as e:
                print(f"ERROR: reconstruction failed: {e}")
                return

        if job is None:
            print(f"ERROR: job {job_id} not found in memory or registry")
            return

        _tc = job.get("transcript_cues") or {}
        transcript_cues = _tc.get(chapter_index) or _tc.get(str(chapter_index)) or []

        _ch_mp3s = job.get("chapter_mp3s") or []
        for _ce in _ch_mp3s:
            if _ce.get("index") == chapter_index:
                chapter_duration_sec = (_ce.get("duration_ms") or 0) / 1000.0
                break

        bgm_mode = job.get("bgm_mode", "off")
        print(f"Job: {job_id}")
        print(f"Chapter: {chapter_index}")
        print(f"bgm_mode: {bgm_mode}")
        print(f"Transcript cues: {len(transcript_cues)} words")
        print(f"Chapter duration: {chapter_duration_sec}s")
    except ImportError:
        print("ERROR: cannot import audiobook_app — run from the audiobook-maker directory")
        return

    if not transcript_cues:
        print("\nERROR: no transcript cues for this chapter — cannot generate BGM cues")
        return

    # Run the heuristic scorer.
    wt = bgm_cues._normalize_word_timings(transcript_cues)
    segments = bgm_cues.score_segments_heuristic(wt)
    cues = bgm_cues._segments_to_time_cues(segments, wt, chapter_duration_sec)

    # Print the table.
    print(f"\n{'='*80}")
    print(f"{'START':>8}  {'END':>8}  {'MOOD':<15}  {'INT':>3}  {'GAIN_DB':>8}")
    print(f"{'-'*8}  {'-'*8}  {'-'*15}  {'-'*3}  {'-'*8}")
    total_duration = 0.0
    silence_duration = 0.0
    for c in cues:
        dur = c["end"] - c["start"]
        total_duration += max(0, dur)
        if c["mood"] == "silence":
            silence_duration += max(0, dur)
        print(f"{c['start']:8.1f}  {c['end']:8.1f}  {c['mood']:<15}  {'':>3}  {c['gain_db']:8.0f}")

    # Compute intensity for each segment (cues don't carry it, recompute from segments).
    print(f"\n{'='*80}")
    print(f"Total cues: {len(cues)}")
    if chapter_duration_sec and chapter_duration_sec > 0:
        coverage_pct = min(100.0, total_duration / chapter_duration_sec * 100)
        silence_pct = silence_duration / chapter_duration_sec * 100 if chapter_duration_sec > 0 else 0
        print(f"Runtime coverage: {total_duration:.1f}s / {chapter_duration_sec:.1f}s ({coverage_pct:.1f}%)")
        print(f"Silence: {silence_duration:.1f}s ({silence_pct:.1f}%)")
    else:
        print(f"Total cue duration: {total_duration:.1f}s")
        print(f"Silence: {silence_duration:.1f}s ({silence_duration/total_duration*100:.1f}%)")

    # Check assets.
    print(f"\n{'='*80}")
    print("Asset files:")
    for mood in bgm_registry.MUSIC_MOODS:
        path = bgm_registry.asset_path_for(mood)
        exists = bgm_registry.asset_exists(mood)
        size = os.path.getsize(path) if exists else 0
        print(f"  {mood:<15} {'OK' if exists else 'MISSING':>7}  {size:>8} bytes  {path}")

    print(f"\n{'='*80}")
    print("Definition of done check:")
    print(f"  cue_count > 0: {'PASS' if len(cues) > 0 else 'FAIL'}")
    all_assets = all(bgm_registry.asset_exists(m) for m in bgm_registry.MUSIC_MOODS)
    print(f"  all assets present: {'PASS' if all_assets else 'FAIL'}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 bgm_selftest.py <job_id> <chapter_index>")
        sys.exit(1)
    run_selftest(sys.argv[1], int(sys.argv[2]))
