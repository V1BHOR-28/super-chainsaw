#!/usr/bin/env python3
"""
parse_epub.py — Quick EPUB parse-only script.

Downloads the EPUB, runs tts_brain.parse_epub_for_tts (the same parser used
for conversion), and calls back with the chapter list. This ensures the
chapter list the user sees in the selector is IDENTICAL to what the
conversion script will produce — no TS/Python parser mismatch.

Runs on a GitHub Actions runner (~20-30 seconds including EPUB download).
Much faster than the full conversion script — no TTS, no GCS, no ffmpeg.

Environment variables:
  JOB_ID                — The AudiobookJob ID
  EPUB_URL              — URL to download the EPUB file
  APP_BASE_URL          — The app's base URL
  APP_CALLBACK_SECRET   — Shared secret for the callback route
"""

import os
import sys
import json
import tempfile
import requests

# Add the scripts directory to the path so tts_brain is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tts_brain import parse_epub_for_tts

# ── Environment ──────────────────────────────────────────────────────────────
JOB_ID          = os.environ["JOB_ID"]
EPUB_URL        = os.environ["EPUB_URL"]
APP_BASE_URL    = os.environ["APP_BASE_URL"]
CALLBACK_SECRET = os.environ["APP_CALLBACK_SECRET"]


def mark_parsed(chapters, title="", author=""):
    """Report parsed chapters back to the app via the callback route."""
    try:
        requests.post(
            f"{APP_BASE_URL}/api/audiobooks/callback",
            headers={"Authorization": f"Bearer {CALLBACK_SECRET}"},
            json={
                "jobId":        JOB_ID,
                "status":       "parse_complete",
                "bookTitle":    title,
                "bookAuthor":   author,
                "chapters":     chapters,  # [{title, text, order}]
            },
            timeout=60,
        )
    except Exception as e:
        print(f"[parse] Failed to report parse results: {e}", file=sys.stderr)


def mark_failed(error_message):
    """Report a parse failure."""
    try:
        requests.post(
            f"{APP_BASE_URL}/api/audiobooks/callback",
            headers={"Authorization": f"Bearer {CALLBACK_SECRET}"},
            json={
                "jobId":        JOB_ID,
                "status":       "parse_failed",
                "errorMessage": error_message,
            },
            timeout=30,
        )
    except Exception as e:
        print(f"[parse] Failed to report failure: {e}", file=sys.stderr)


def main():
    print(f"[parse] Starting parse job {JOB_ID}")
    with tempfile.TemporaryDirectory() as tmp:
        epub_path = os.path.join(tmp, "book.epub")
        print(f"[parse] Downloading EPUB from {EPUB_URL}")
        r = requests.get(EPUB_URL, timeout=120)
        r.raise_for_status()
        with open(epub_path, "wb") as f:
            f.write(r.content)

        print("[parse] Parsing EPUB with tts_brain...")
        title, author, chapters = parse_epub_for_tts(epub_path)
        print(f'[parse] "{title}" by {author} — {len(chapters)} chapters')

        if not chapters:
            mark_failed("No readable chapters found")
            return

        # Truncate text to avoid exceeding callback body size limits.
        # 200K chars per chapter is ~1MB — plenty for the selector's
        # char-count display and cost estimate. Full text is re-extracted
        # during conversion by the Python parser (which runs on the full EPUB).
        for ch in chapters:
            if len(ch["text"]) > 200_000:
                ch["text"] = ch["text"][:200_000]

        print(f"[parse] Calling back with {len(chapters)} chapters")
        mark_parsed(chapters, title, author)
        print("[parse] Done!")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[parse] FATAL: {e}", file=sys.stderr)
        mark_failed(str(e))
        sys.exit(1)
