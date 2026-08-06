"""Audio post-processing for audiobook MP3s.

Normalizes loudness and applies light compression to even out volume.
Uses ffmpeg directly (no pydub dependency) for maximum compatibility
with Render's free tier.

Pipeline:
1. Normalize loudness to -16 LUFS (EBU R128)
2. Apply 2:1 compression
3. Output the final MP3 in place
"""

import os
import subprocess
import tempfile
import shutil


def post_process_audio(mp3_path: str) -> bool:
    """Post-process an MP3 file in place.

    Runs ffmpeg with:
    - loudnorm filter (EBU R128, target -16 LUFS)
    - acompressor filter (2:1 ratio, soft threshold)

    If ffmpeg fails or the file is too small, the original is kept.

    Args:
        mp3_path: Path to the MP3 file to process (modified in place).

    Returns:
        True if post-processing succeeded, False if it failed (original kept).
    """
    if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) < 1000:
        return False

    # Create a temp file for the output
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp3", dir=os.path.dirname(mp3_path))
    os.close(tmp_fd)

    try:
        # ffmpeg pipeline:
        # - loudnorm: EBU R128 loudness normalization to -16 LUFS
        #   (two-pass would be more accurate but too slow for Render free tier;
        #   single-pass is good enough for audiobook narration)
        # - acompressor: 2:1 ratio, threshold -20dB, soft knee
        #   (evens out sentence-level volume differences)
        cmd = [
            "ffmpeg", "-y",
            "-i", mp3_path,
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,acompressor=threshold=-20dB:ratio=2:attack=5:release=50",
            "-c:a", "libmp3lame",
            "-b:a", "48k",
            "-ar", "24000",
            tmp_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,  # 30s max — don't hang the generation thread
        )

        if result.returncode != 0:
            print(f"[audio-post] ffmpeg failed: {result.stderr[-300:]}")
            return False

        # Verify the output is valid (non-empty, larger than 1KB)
        if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) < 1000:
            print(f"[audio-post] output too small: {os.path.getsize(tmp_path) if os.path.exists(tmp_path) else 0}")
            return False

        # Replace the original with the processed version
        shutil.move(tmp_path, mp3_path)
        print(f"[audio-post] Post-processed: {os.path.getsize(mp3_path)} bytes")
        return True

    except subprocess.TimeoutExpired:
        print(f"[audio-post] ffmpeg timed out (30s) — keeping original")
        return False
    except Exception as e:
        print(f"[audio-post] Error: {e}")
        return False
    finally:
        # Clean up temp file if it still exists
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
