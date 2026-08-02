#!/usr/bin/env python3
"""
convert_audiobook.py — Convert an EPUB into audiobook chapter MP3s.

Runs on a GitHub Actions runner (free, 45-minute timeout). Downloads the
EPUB, parses it with ebooklib, generates TTS per chapter using Kokoro
(open-source neural TTS, Apache 2.0), uploads each MP3 to Vercel Blob
concurrently, then calls the app's callback route.

Kokoro produces significantly more natural narration than Edge TTS for
long-form audiobook listening. It runs on CPU (no GPU required).

Environment variables:
  JOB_ID                — The AudiobookJob ID
  EPUB_URL              — URL to download the EPUB file
  AUDIOBOOK_ID          — (optional) The Audiobook ID to update
  BLOB_READ_WRITE_TOKEN — Vercel Blob token for uploads
  APP_BASE_URL          — The app's base URL
  APP_CALLBACK_SECRET   — Shared secret for the callback route
"""

import asyncio
import os
import re
import sys
import json
import tempfile
import subprocess
import requests

import numpy as np
import soundfile as sf
from kokoro import KPipeline
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

# ── Environment ──────────────────────────────────────────────────────────────
JOB_ID           = os.environ["JOB_ID"]
EPUB_URL         = os.environ["EPUB_URL"]
AUDIOBOOK_ID     = os.environ.get("AUDIOBOOK_ID", "")
BLOB_TOKEN       = os.environ["BLOB_READ_WRITE_TOKEN"]
APP_BASE_URL     = os.environ["APP_BASE_URL"]
CALLBACK_SECRET  = os.environ["APP_CALLBACK_SECRET"]

KOKORO_VOICE     = "af_heart"   # warm, natural — one of Kokoro's best voices for narration
MAX_SEGMENT_CHARS = 500         # Kokoro works best with shorter, sentence-aligned segments
MAX_CONCURRENT   = 2            # Kokoro on CPU is heavier than Edge TTS — keep concurrency lower

# Initialise the pipeline once at module level so it's not re-loaded per chapter.
print("[init] Loading Kokoro pipeline (this takes ~30s on first run)...")
_pipeline = KPipeline(lang_code='a')  # 'a' = American English
print("[init] Kokoro pipeline ready.")


# ── Callback ─────────────────────────────────────────────────────────────────
def mark_status(status, chapter_urls=None, error_message=None):
    """Report status back to the app via the callback route (synchronous)."""
    try:
        requests.post(
            f"{APP_BASE_URL}/api/audiobooks/callback",
            headers={"Authorization": f"Bearer {CALLBACK_SECRET}"},
            json={
                "jobId":         JOB_ID,
                "status":        status,
                "chapterUrls":   chapter_urls or [],
                "errorMessage":  error_message,
            },
            timeout=30,
        )
    except Exception as e:
        print(f"[callback] Failed to report status {status}: {e}", file=sys.stderr)


# ── Text helpers ──────────────────────────────────────────────────────────────
def clean_text(html_content: str) -> str:
    """Extract clean readable text from HTML content."""
    soup = BeautifulSoup(html_content, "html.parser")
    for tag in soup.find_all(["script", "style", "nav", "header", "footer",
                               "aside", "link", "meta"]):
        tag.decompose()
    text = soup.get_text(separator=" ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def split_for_tts(text: str, max_len: int = MAX_SEGMENT_CHARS) -> list:
    """
    Split long text into segments for TTS.

    Splits on sentence boundaries (. ! ?) before falling back to paragraph
    breaks, so each segment ends at a natural pause point rather than mid-
    sentence, which eliminates the most audible join artifacts.
    """
    if len(text) <= max_len:
        return [text]

    segments = []
    remaining = text

    while len(remaining) > max_len:
        # Try to break at the last sentence end before the limit
        chunk = remaining[:max_len]
        # Find the last sentence-ending punctuation
        last_break = max(
            chunk.rfind(". "),
            chunk.rfind("! "),
            chunk.rfind("? "),
            chunk.rfind(".\n"),
        )
        if last_break > max_len // 2:
            # Good sentence boundary found in the second half of the chunk
            cut = last_break + 2
        else:
            # Fall back to paragraph break
            last_para = chunk.rfind("\n\n")
            cut = last_para + 2 if last_para > max_len // 3 else max_len

        segments.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()

    if remaining:
        segments.append(remaining)

    return segments


# Patterns that identify front/back matter to skip.
# Matched against the first heading or first 120 chars of text (lowercase).
FRONTMATTER_PATTERNS = [
    r"^copyright",
    r"^all rights reserved",
    r"^published by",
    r"^table of contents",
    r"^contents$",
    r"^dedication",
    r"^this book is dedicated",
    r"^about the author",
    r"^about this book",
    r"^note on the text",
    r"^editor.s note",
    r"^translator.s note",
    r"^preface\s*$",
    r"^foreword\s*$",
    r"^acknowledgements?\s*$",
    r"^this ebook",
    r"^project gutenberg",
    r"^produced by",
    r"gutenberg literary archive",
    r"^title page\s*$",
    r"^half.?title",
    r"^colophon",
]


def _is_frontmatter(text: str, heading: str = "") -> bool:
    """Return True if the text looks like front/back matter, not a real chapter."""
    probe = (heading or text[:120]).lower().strip()
    return any(re.search(pat, probe) for pat in FRONTMATTER_PATTERNS)


def _split_on_headings(html_content: str, base_order: int) -> list:
    """
    Split a single large HTML file on <h2>/<h3> boundaries.
    Used when an EPUB stores the whole book in one file.
    Returns a list of chapter dicts with title, text, order.
    """
    soup = BeautifulSoup(html_content, "html.parser")
    headings = soup.find_all(["h2", "h3"])
    if not headings:
        return []

    chapters = []
    for i, heading in enumerate(headings):
        title = heading.get_text().strip()[:200]
        # Collect all sibling content until the next heading
        content_parts = []
        for sibling in heading.find_next_siblings():
            if sibling.name in ("h2", "h3"):
                break
            content_parts.append(str(sibling))
        chunk_html = str(heading) + "".join(content_parts)
        text = clean_text(chunk_html)
        if len(text) < 50:
            continue
        if _is_frontmatter(text, title):
            continue
        chapters.append({"title": title, "text": text, "order": base_order + len(chapters)})

    return chapters


def parse_epub(epub_path: str):
    """Parse EPUB and return (title, author, chapters).

    Uses the spine (reading order) rather than raw manifest iteration,
    filters front/back matter, and splits single-file EPUBs on headings.
    """
    book = epub.read_epub(epub_path)

    title_meta = book.get_metadata("DC", "title")
    title = title_meta[0][0] if title_meta else "Untitled"
    author_meta = book.get_metadata("DC", "creator")
    author = author_meta[0][0] if author_meta else "Unknown"

    # Build a map from item id → EpubItem for spine lookup
    id_to_item = {item.id: item for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT)}

    # Build TOC map: href (without fragment) → display title
    toc_map = {}
    def _walk_toc(items):
        for item in items:
            if isinstance(item, epub.Link):
                toc_map[item.href.split("#")[0]] = item.title
            elif isinstance(item, tuple):
                section, children = item
                if hasattr(section, "href"):
                    toc_map[section.href.split("#")[0]] = section.title
                _walk_toc(children)
    _walk_toc(book.toc)

    # Get reading order from spine. book.spine is a list of (id, linear) tuples.
    # Fall back to iterating all document items if spine is empty.
    if book.spine:
        spine_ids = [item_id for item_id, _ in book.spine]
        ordered_items = [id_to_item[sid] for sid in spine_ids if sid in id_to_item]
    else:
        ordered_items = list(id_to_item.values())

    chapters = []
    order = 0

    for item in ordered_items:
        html_content = item.get_content().decode("utf-8", errors="ignore")
        text = clean_text(html_content)

        # Skip nearly-empty items (cover images, empty wrappers, etc.)
        if len(text) < 50:
            continue

        href = item.get_name().split("#")[0]

        # Determine candidate title from TOC map or first heading
        soup = BeautifulSoup(html_content, "html.parser")
        heading_tag = soup.find(["h1", "h2", "h3"])
        heading_text = heading_tag.get_text().strip()[:200] if heading_tag else ""
        chapter_title = toc_map.get(href, "") or heading_text or f"Chapter {order + 1}"

        # Skip front/back matter
        if _is_frontmatter(text, chapter_title):
            print(f"[parse_epub] Skipping front/back matter: '{chapter_title[:60]}'")
            continue

        # If this item is very large (> 15,000 chars) and contains multiple headings,
        # it's a single-file EPUB — split it on heading boundaries.
        LARGE_FILE_THRESHOLD = 15_000
        sub_headings = soup.find_all(["h2", "h3"])
        if len(text) > LARGE_FILE_THRESHOLD and len(sub_headings) > 1:
            print(f"[parse_epub] Large single-file item ({len(text)} chars, "
                  f"{len(sub_headings)} headings) — splitting on headings")
            sub_chapters = _split_on_headings(html_content, order)
            if sub_chapters:
                chapters.extend(sub_chapters)
                order += len(sub_chapters)
                continue
            # If splitting yielded nothing, fall through and treat as one chapter

        chapters.append({"title": chapter_title[:200], "text": text, "order": order})
        order += 1

    # If filtering was too aggressive and we ended up with nothing,
    # retry without front-matter filtering (better to have all chapters
    # including front matter than to have an empty audiobook).
    if not chapters:
        print("[parse_epub] All items were filtered as front-matter — retrying without filter")
        order = 0
        for item in ordered_items:
            html_content = item.get_content().decode("utf-8", errors="ignore")
            text = clean_text(html_content)
            if len(text) < 50:
                continue
            href = item.get_name().split("#")[0]
            soup = BeautifulSoup(html_content, "html.parser")
            heading_tag = soup.find(["h1", "h2", "h3"])
            heading_text = heading_tag.get_text().strip()[:200] if heading_tag else ""
            chapter_title = toc_map.get(href, "") or heading_text or f"Chapter {order + 1}"
            chapters.append({"title": chapter_title[:200], "text": text, "order": order})
            order += 1

    print(f"[parse_epub] '{title}' by {author}: {len(chapters)} chapters extracted")
    return title, author, chapters


# ── TTS generation (Kokoro) ──────────────────────────────────────────────────
def generate_chapter_audio_sync(text: str, output_path: str) -> None:
    """
    Generate TTS audio for a chapter using Kokoro.
    Synchronous — called via run_in_executor to avoid blocking the event loop.

    Kokoro returns audio as numpy float32 arrays at 24kHz. We collect all
    segments, concatenate them, then write a single WAV file and convert
    to MP3 via ffmpeg.
    """
    segments = split_for_tts(text)

    all_audio = []
    sample_rate = 24000  # Kokoro's native sample rate

    for i, segment in enumerate(segments):
        if not segment.strip():
            continue
        try:
            # _pipeline() returns a generator of (graphemes, phonemes, audio_array) tuples.
            segment_chunks = []
            for _, _, audio in _pipeline(segment, voice=KOKORO_VOICE, speed=1.0):
                if audio is not None and len(audio) > 0:
                    segment_chunks.append(audio)
            if segment_chunks:
                all_audio.append(np.concatenate(segment_chunks))
        except Exception as e:
            print(f"[tts] Segment {i+1}/{len(segments)} failed: {e}", file=sys.stderr)

    if not all_audio:
        raise RuntimeError("Kokoro produced no audio for this chapter")

    # Add 0.5s of silence between segments for natural paragraph breathing.
    silence = np.zeros(int(sample_rate * 0.5), dtype=np.float32)
    combined = np.concatenate(
        [chunk for pair in zip(all_audio, [silence] * len(all_audio)) for chunk in pair]
    )

    # Write as WAV first (lossless intermediate), then convert to MP3 with ffmpeg.
    wav_path = output_path.replace(".mp3", ".wav")
    sf.write(wav_path, combined, sample_rate)

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame",
         "-qscale:a", "4",   # VBR ~165kbps — good quality, reasonable file size
         output_path],
        capture_output=True, text=True, timeout=120,
    )

    try:
        os.remove(wav_path)
    except:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg MP3 conversion failed: {result.stderr[:500]}")


async def generate_chapter_audio(text: str, output_path: str) -> None:
    """
    Async wrapper around the synchronous Kokoro generation.
    Runs in a thread executor so it doesn't block asyncio.gather().
    """
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, generate_chapter_audio_sync, text, output_path)


# ── Blob upload (async via asyncio executor) ──────────────────────────────────
async def upload_to_blob(file_path: str, blob_pathname: str) -> str:
    """
    Upload a file to Vercel Blob using the REST API.
    Runs the blocking requests.put in an executor so it doesn't block the loop.
    """
    def _upload():
        with open(file_path, "rb") as f:
            file_data = f.read()

        response = requests.put(
            f"https://blob.vercel-storage.com/{blob_pathname}",
            headers={
                "Authorization":  f"Bearer {BLOB_TOKEN}",
                "Content-Type":   "audio/mpeg",
                "x-content-type": "audio/mpeg",
                "x-access":       "public",
            },
            data=file_data,
            timeout=120,
        )

        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"Blob upload failed: {response.status_code} {response.text[:200]}"
            )

        data = response.json()
        url = data.get("url") or data.get("blob", {}).get("url", "")
        if not url:
            raise RuntimeError(f"Blob upload returned no URL: {data}")
        return url

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _upload)


# ── Per-chapter pipeline ──────────────────────────────────────────────────────
async def process_chapter(chapter, tmp_dir, semaphore):
    """
    Generate TTS + upload for a single chapter.
    Returns the Blob URL on success, None on failure.
    Semaphore limits concurrent chapters to MAX_CONCURRENT.
    """
    async with semaphore:
        i = chapter["order"]
        title = chapter["title"]
        print(f"[convert] Chapter {i + 1}: '{title}' ({len(chapter['text'])} chars)")

        chapter_path = os.path.join(tmp_dir, f"chapter_{i:04d}.mp3")
        try:
            await generate_chapter_audio(chapter["text"], chapter_path)
            blob_path = f"audiobooks/{JOB_ID}/chapter-{i:04d}.mp3"
            url = await upload_to_blob(chapter_path, blob_path)
            print(f"[convert] Chapter {i + 1} uploaded")
            return url
        except Exception as e:
            print(f"[convert] Chapter {i + 1} FAILED: {e}", file=sys.stderr)
            return None
        finally:
            try: os.remove(chapter_path)
            except: pass


# ── Main ──────────────────────────────────────────────────────────────────────
async def main_async():
    print(f"[convert] Starting job {JOB_ID}")
    mark_status("running")

    with tempfile.TemporaryDirectory() as tmp:
        # Download the EPUB
        epub_path = os.path.join(tmp, "book.epub")
        print(f"[convert] Downloading EPUB from {EPUB_URL}")
        r = requests.get(EPUB_URL, timeout=120)
        r.raise_for_status()
        with open(epub_path, "wb") as f:
            f.write(r.content)

        # Parse the EPUB
        print("[convert] Parsing EPUB...")
        title, author, chapters = parse_epub(epub_path)
        print(f'[convert] "{title}" by {author} — {len(chapters)} chapters')

        if not chapters:
            mark_status("failed", error_message="No readable chapters found")
            return

        # Generate TTS + upload all chapters concurrently (up to MAX_CONCURRENT at once)
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        tasks = [process_chapter(ch, tmp, semaphore) for ch in chapters]
        results = await asyncio.gather(*tasks)

        # results is ordered by chapter.order (same order as chapters list)
        # Filter out failures and build the URL list in chapter order
        chapter_urls_by_order = {}
        for chapter, url in zip(chapters, results):
            if url:
                chapter_urls_by_order[chapter["order"]] = url

        # Produce a sorted list (gaps = failed chapters, skip them)
        chapter_urls = [chapter_urls_by_order[i]
                        for i in sorted(chapter_urls_by_order.keys())]

        if not chapter_urls:
            mark_status("failed", error_message="All chapters failed to generate")
            return

        print(f"[convert] Done! {len(chapter_urls)}/{len(chapters)} chapters generated")
        mark_status("complete", chapter_urls=chapter_urls)


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[convert] FATAL: {e}", file=sys.stderr)
        mark_status("failed", error_message=str(e))
        sys.exit(1)
