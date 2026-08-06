"""BGM mixing — overlay background music beds onto a narration MP3 via ffmpeg.

Single-invocation ffmpeg pipeline (no intermediate WAVs, no Python audio
buffering) to stay within Render's free-tier RAM budget.

Pipeline per chapter::

    voice.mp3 (input 0)
    ├── asplit ──┬── v1 (sidechain key)
    │           └── v2 (clean voice passthrough)
    │
    asset_i.mp3 (looped) ── atrim → volume → afade → adelay ── bed_i
    │
    [bed_0..bed_N] ── amix(normalize=0) ── bedmix
    │
    [bedmix][v1] ── sidechaincompress (ducking) ── ducked
    │
    [ducked][v2] ── amix(normalize=0) ── loudnorm ── libmp3lame 128k ── out.mp3

The sidechain compressor ducks the music bed whenever the narrator speaks,
so dialogue stays intelligible. ``loudnorm`` (EBU R128, -16 LUFS) matches
the existing audiobook loudness target.
"""

import os
import math
import shutil
import subprocess

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Sidechain ducking: the music drops ~8 dB while the narrator speaks.
_DUCK_THRESHOLD = 0.03     # amplitude — fairly sensitive (narration is quiet)
_DUCK_RATIO = 8            # 8:1 compression ratio
_DUCK_ATTACK_MS = 20       # fast attack — music ducks quickly on speech onset
_DUCK_RELEASE_MS = 500     # slow release — music fades back over 0.5s

# Fade durations for each music bed (seconds).
_BED_FADE_SEC = 1.5

# Final loudness target — matches audio_postprocess.py.
_LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"

# Output codec.
_OUTPUT_CODEC = ["-c:a", "libmp3lame", "-b:a", "128k"]

# Subprocess flags — hide Windows console windows (no-op on Linux).
import sys
_SUBPROCESS_FLAGS = {"creationflags": 0x08000000} if sys.platform == "win32" else {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ffprobe_duration_sec(path: str) -> float:
    """Get audio duration in seconds via ffprobe. Returns 30.0 on failure
    (all shipped assets are 30s loops — safe fallback)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return float(r.stdout.strip())
    except Exception:
        pass
    return 30.0


def _gain_to_linear(gain_db: float) -> float:
    """Convert dB to linear amplitude (0 dB = 1.0)."""
    return 10.0 ** (gain_db / 20.0)


# ---------------------------------------------------------------------------
# Core: mix_chapter
# ---------------------------------------------------------------------------

def mix_chapter(voice_mp3_path: str, cues: list[dict], out_path: str) -> bool:
    """Mix BGM cues onto a voice MP3, writing the result to ``out_path``.

    Args:
        voice_mp3_path: Path to the clean narration MP3.
        cues: Time-based cues from ``bgm_cues.get_or_create_bgm_cues`` —
              ``[{"start": float, "end": float, "mood": str, "gain_db": float}, ...]``.
        out_path: Destination MP3 path (overwritten).

    Returns:
        ``True`` if mixing succeeded, ``False`` if it failed (caller keeps
        the clean voice). Fail-soft: never raises.
    """
    try:
        from bgm_registry import asset_path_for, asset_exists
    except ImportError:
        return False

    if not os.path.isfile(voice_mp3_path):
        return False

    # Filter to music cues (skip "silence" and missing assets).
    music_cues: list[dict] = []
    for cue in cues or []:
        mood = cue.get("mood", "silence")
        if mood == "silence":
            continue
        if not asset_exists(mood):
            print(f"[bgm-mix] asset missing for mood '{mood}' — skipping cue")
            continue
        music_cues.append(cue)

    # No music → just copy the voice file (no mixing needed).
    if not music_cues:
        try:
            shutil.copy2(voice_mp3_path, out_path)
            return True
        except Exception as e:
            print(f"[bgm-mix] copy failed: {e}")
            return False

    voice_dur = _ffprobe_duration_sec(voice_mp3_path)

    # Build ffmpeg command.
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    inputs = ["-i", voice_mp3_path]
    filter_parts: list[str] = []
    bed_labels: list[str] = []

    # Add each music cue as a looped input + filtered bed.
    for i, cue in enumerate(music_cues):
        asset = asset_path_for(cue["mood"])
        cue_dur = max(0.5, cue["end"] - cue["start"])
        start_ms = max(0, int(cue["start"] * 1000))
        gain_db = cue.get("gain_db", -20)
        gain_linear = _gain_to_linear(gain_db)

        # Compute finite loop count (avoid -stream_loop -1 infinite hangs on Render).
        asset_dur = _ffprobe_duration_sec(asset)
        loop_count = max(0, int(math.ceil(cue_dur / max(asset_dur, 1.0))) - 1)
        inputs += ["-stream_loop", str(loop_count), "-i", asset]

        fade_out_st = max(0.0, cue_dur - _BED_FADE_SEC)
        # atrim limits the bed to cue_dur; volume sets gain; afade in/out;
        # adelay positions the bed at cue.start.
        filter_parts.append(
            f"[{i + 1}:a]atrim=duration={cue_dur:.3f},"
            f"asetpts=PTS-STARTPTS,"
            f"volume={gain_linear:.6f},"
            f"afade=t=in:st=0:d={_BED_FADE_SEC},"
            f"afade=t=out:st={fade_out_st:.3f}:d={_BED_FADE_SEC},"
            f"adelay={start_ms}|{start_ms}[bed{i}]"
        )
        bed_labels.append(f"[bed{i}]")

    # Mix all beds together.
    n_beds = len(bed_labels)
    beds_concat = "".join(bed_labels)
    filter_parts.append(f"{beds_concat}amix=inputs={n_beds}:normalize=0[bedmix]")

    # Sidechain duck: voice ducks the bed.
    filter_parts.append("[0:a]asplit=2[v1][v2]")
    filter_parts.append(
        f"[bedmix][v1]sidechaincompress="
        f"threshold={_DUCK_THRESHOLD}:ratio={_DUCK_RATIO}:"
        f"attack={_DUCK_ATTACK_MS}:release={_DUCK_RELEASE_MS}[ducked]"
    )

    # Final mix: ducked bed + clean voice, then loudnorm.
    # duration=first with [v2] first → output length = voice length.
    filter_parts.append(
        f"[v2][ducked]amix=inputs=2:normalize=0:duration=first,"
        f"{_LOUDNORM}[out]"
    )

    filter_complex = ";".join(filter_parts)
    cmd += inputs
    cmd += ["-filter_complex", filter_complex, "-map", "[out]"]
    cmd += _OUTPUT_CODEC
    # Cap output at voice duration + 3s tail (safety for crossfade overshoot).
    cmd += ["-t", f"{voice_dur + 3.0:.1f}"]
    cmd += [out_path]

    # Run ffmpeg.
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300, **_SUBPROCESS_FLAGS
        )
        if result.returncode != 0:
            print(f"[bgm-mix] ffmpeg failed: {result.stderr[-500:]}")
            return False
        if not os.path.isfile(out_path) or os.path.getsize(out_path) < 1000:
            print(f"[bgm-mix] output too small — keeping clean voice")
            return False
        return True
    except subprocess.TimeoutExpired:
        print(f"[bgm-mix] ffmpeg timed out (300s) — keeping clean voice")
        return False
    except Exception as e:
        print(f"[bgm-mix] error: {e}")
        return False
