#!/usr/bin/env python3
"""
convert_audiobook.py — Convert an EPUB into audiobook chapter MP3s.

Runs on a GitHub Actions runner (45-minute timeout). Downloads the EPUB,
parses it with ebooklib, generates TTS per chapter using Google Cloud
Text-to-Speech Long Audio API (synthesize_long_audio), uploads each MP3
to Vercel Blob concurrently, then calls the app's callback route.

Uses a two-phase approach for maximum speed:
  Phase A: Fire ALL synthesis tasks simultaneously (non-blocking API calls)
  Phase B: Poll, download WAV, convert to MP3, upload to Blob in parallel

Google Cloud TTS produces studio-quality narration via Journey voices.
This is a paid GCP service — estimated cost is ~$0.000016 per character
for Journey voices (check current pricing at cloud.google.com/text-to-speech/pricing).

Environment variables:
  JOB_ID                — The AudiobookJob ID
  EPUB_URL              — URL to download the EPUB file
  AUDIOBOOK_ID          — (optional) The Audiobook ID to update
  BLOB_READ_WRITE_TOKEN — Vercel Blob token for uploads
  APP_BASE_URL          — The app's base URL
  APP_CALLBACK_SECRET   — Shared secret for the callback route
  GCS_AUDIOBOOK_BUCKET  — GCS bucket name for TTS temp output
  GCP_PROJECT_ID        — GCP project ID
"""

import asyncio
import os
import re
import sys
import json
import tempfile
import subprocess
import time
import requests

from google.api_core.exceptions import ResourceExhausted
from google.cloud import texttospeech
from google.cloud import storage
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

GCS_BUCKET         = os.environ["GCS_AUDIOBOOK_BUCKET"]
GCP_PROJECT        = os.environ["GCP_PROJECT_ID"]
GCP_REGION         = "us-central1"   # Long Audio API endpoint region
TTS_VOICE          = "en-US-Journey-D"  # Natural, warm Journey voice — excellent for narration
TTS_LANGUAGE       = "en-US"
MAX_CHARS_PER_TASK = 700_000  # Long Audio API limit (~750K chars)

# Initialize GCP clients once at module level
_tts_client     = texttospeech.TextToSpeechLongAudioSynthesizeClient()
_storage_client = storage.Client()


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


def split_for_tts(text: str, max_len: int = MAX_CHARS_PER_TASK) -> list:
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
        chunk = remaining[:max_len]
        last_break = max(
            chunk.rfind(". "),
            chunk.rfind("! "),
            chunk.rfind("? "),
            chunk.rfind(".\n"),
        )
        if last_break > max_len // 2:
            cut = last_break + 2
        else:
            last_para = chunk.rfind("\n\n")
            cut = last_para + 2 if last_para > max_len // 3 else max_len

        segments.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()

    if remaining:
        segments.append(remaining)

    return segments


# Patterns that identify front/back matter to skip.
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
    Split a single large HTML file on <h1>/<h2>/<h3> boundaries.
    Used when an EPUB stores the whole book in one file.
    Returns a list of chapter dicts with title, text, order.
    """
    soup = BeautifulSoup(html_content, "html.parser")
    headings = soup.find_all(["h1", "h2", "h3"])
    if not headings:
        return []

    chapters = []
    for i, heading in enumerate(headings):
        title = heading.get_text().strip()[:200]
        # Collect all sibling content until the next heading
        content_parts = []
        for sibling in heading.find_next_siblings():
            if sibling.name in ("h1", "h2", "h3"):
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


def _split_on_wordcount(text: str, base_order: int,
                         target_words: int = 3500) -> list:
    """
    Last-resort chapter splitter for EPUBs with no heading structure.
    Splits on paragraph boundaries aiming for ~3500 words per chapter
    (~15–20 minutes of narration). Never cuts mid-paragraph.
    """
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]
    chapters = []
    current_paras = []
    current_words = 0

    for para in paragraphs:
        word_count = len(para.split())
        current_paras.append(para)
        current_words += word_count

        if current_words >= target_words:
            chapter_text = '\n\n'.join(current_paras)
            chapters.append({
                "title": f"Chapter {base_order + len(chapters) + 1}",
                "text": chapter_text,
                "order": base_order + len(chapters),
            })
            current_paras = []
            current_words = 0

    # Don't lose the last partial chunk
    if current_paras:
        chapter_text = '\n\n'.join(current_paras)
        if len(chapter_text) > 200:
            chapters.append({
                "title": f"Chapter {base_order + len(chapters) + 1}",
                "text": chapter_text,
                "order": base_order + len(chapters),
            })

    return chapters


def parse_epub(epub_path: str):
    """Parse EPUB and return (title, author, chapters).

    Uses the spine (reading order) rather than raw manifest iteration,
    filters front/back matter, and splits single-file EPUBs on headings
    (h1/h2/h3) with a word-count fallback for books with no heading structure.
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
        sub_headings = soup.find_all(["h1", "h2", "h3"])
        if len(text) > LARGE_FILE_THRESHOLD and len(sub_headings) > 1:
            print(f"[parse_epub] Large single-file item ({len(text)} chars, "
                  f"{len(sub_headings)} headings) — splitting on headings")
            sub_chapters = _split_on_headings(html_content, order)
            if sub_chapters:
                chapters.extend(sub_chapters)
                order += len(sub_chapters)
                continue
            # Heading split yielded nothing — fall through to word-count split below

        # Word-count fallback for large items with no usable heading structure
        if len(text) > LARGE_FILE_THRESHOLD:
            print(f"[parse_epub] Large item ({len(text)} chars) with no heading "
                  f"structure — splitting on word count (~3500 words/chapter)")
            sub_chapters = _split_on_wordcount(text, order)
            if sub_chapters:
                print(f"[parse_epub] word-count split produced {len(sub_chapters)} chapters")
                chapters.extend(sub_chapters)
                order += len(sub_chapters)
                continue

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


# ── TTS: Phase A — start all synthesis tasks (non-blocking) ──────────────────
def start_synthesis_task(text: str, gcs_output_uri: str, chapter_index: int) -> list:
    """
    Start a Long Audio synthesis task and return the operation handle immediately.
    Does NOT wait for completion — call finish_synthesis_task() for that.
    Returns a list of (gcs_uri, operation) tuples (one per text segment).
    """
    segments = split_for_tts(text, max_len=MAX_CHARS_PER_TASK)
    operations = []
    for i, segment in enumerate(segments):
        if not segment.strip():
            continue
        # Always include chapter_index in the URI — even for single-segment chapters —
        # so concurrent chapters never collide on the same GCS path.
        seg_uri = gcs_output_uri.replace('.wav', f'-ch{chapter_index:04d}-part{i:04d}.wav')
        voice = texttospeech.VoiceSelectionParams(
            language_code=TTS_LANGUAGE,
            name=TTS_VOICE,
        )
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=24000,
        )
        parent = f"projects/{GCP_PROJECT}/locations/{GCP_REGION}"
        operation = _tts_client.synthesize_long_audio(
            request=texttospeech.SynthesizeLongAudioRequest(
                parent=parent,
                input=texttospeech.SynthesisInput(text=segment),
                audio_config=audio_config,
                voice=voice,
                output_gcs_uri=seg_uri,
            )
        )
        operations.append((seg_uri, operation))
    return operations


# ── TTS: Phase B — poll, download WAV, convert to MP3 ────────────────────────
MAX_POLL_RETRIES = 5


def _wait_for_operation(operation, seg_uri, timeout_s):
    """Wait for a Long Audio operation with retry-on-rate-limit backoff."""
    delay = 15  # start with a real gap, not an aggressive retry
    for attempt in range(MAX_POLL_RETRIES):
        try:
            operation.result(timeout=timeout_s)
            return
        except ResourceExhausted as e:
            if attempt == MAX_POLL_RETRIES - 1:
                raise RuntimeError(f"TTS operation still rate-limited after {MAX_POLL_RETRIES} retries for {seg_uri}: {e}")
            print(f"[tts] Rate-limited polling {seg_uri}, waiting {delay}s (attempt {attempt + 1}/{MAX_POLL_RETRIES})", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 60)
        except Exception as e:
            raise RuntimeError(f"TTS operation failed or timed out for {seg_uri}: {e}")


def finish_synthesis_task(
    operations: list,        # from start_synthesis_task()
    output_mp3_path: str,    # final local MP3 path
    timeout_s: int = 600,    # 10 minutes — generous for long chapters
) -> None:
    """
    Poll all operations to completion, download each WAV from GCS,
    convert to MP3 with ffmpeg, clean up GCS objects.
    """
    mp3_parts = []

    for seg_uri, operation in operations:
        _wait_for_operation(operation, seg_uri, timeout_s)

        # Parse bucket + object path from gs:// URI
        bucket_name = GCS_BUCKET
        gcs_object_path = seg_uri.replace(f"gs://{bucket_name}/", "")
        local_wav = output_mp3_path.replace(".mp3", f"-{len(mp3_parts):04d}.wav")
        local_mp3 = output_mp3_path.replace(".mp3", f"-{len(mp3_parts):04d}.mp3")

        bucket = _storage_client.bucket(bucket_name)
        blob = bucket.blob(gcs_object_path)
        blob.download_to_filename(local_wav)
        blob.delete()
        print(f"[tts] Downloaded + cleaned {gcs_object_path} ({os.path.getsize(local_wav)} bytes)")

        # Convert WAV → MP3 with ffmpeg
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", local_wav,
             "-codec:a", "libmp3lame", "-qscale:a", "4", local_mp3],
            capture_output=True, text=True, timeout=300,
        )
        try: os.remove(local_wav)
        except: pass
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[:300]}")
        mp3_parts.append(local_mp3)

    if not mp3_parts:
        raise RuntimeError("No audio produced")

    if len(mp3_parts) == 1:
        os.rename(mp3_parts[0], output_mp3_path)
    else:
        filelist = output_mp3_path.replace(".mp3", "-filelist.txt")
        with open(filelist, "w") as f:
            for p in mp3_parts:
                f.write(f"file '{p}'\n")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", filelist, "-c", "copy", output_mp3_path],
            capture_output=True, text=True, timeout=300, check=True,
        )
        for p in mp3_parts:
            try: os.remove(p)
            except: pass
        try: os.remove(filelist)
        except: pass


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


# ── Two-phase per-chapter pipeline ────────────────────────────────────────────
async def process_chapter_start(chapter, tmp_dir):
    """Phase A: start synthesis, return (chapter, operations, output_path)."""
    i = chapter["order"]
    title = chapter["title"]
    output_path = os.path.join(tmp_dir, f"chapter_{i:04d}.mp3")
    gcs_uri = f"gs://{GCS_BUCKET}/tts-tmp/{JOB_ID}/chapter-{i:04d}.wav"
    print(f"[convert] Starting synthesis: Chapter {i+1} '{title}' ({len(chapter['text'])} chars)")
    loop = asyncio.get_running_loop()
    operations = await loop.run_in_executor(
        None, start_synthesis_task, chapter["text"], gcs_uri, chapter["order"]
    )
    return chapter, operations, output_path


async def process_chapter_finish(chapter, operations, output_path, semaphore):
    """Phase B: poll, download, convert. Semaphore limits concurrent downloads."""
    async with semaphore:
        i = chapter["order"]
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, finish_synthesis_task, operations, output_path)
            blob_path = f"audiobooks/{JOB_ID}/chapter-{i:04d}.mp3"
            url = await upload_to_blob(output_path, blob_path)
            print(f"[convert] Chapter {i+1} done and uploaded")
            return url
        except Exception as e:
            print(f"[convert] Chapter {i+1} FAILED: {e}", file=sys.stderr)
            return None
        finally:
            try: os.remove(output_path)
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

        # Phase A: Fire ALL synthesis tasks simultaneously (non-blocking API calls)
        start_tasks = [process_chapter_start(ch, tmp) for ch in chapters]
        started = await asyncio.gather(*start_tasks)
        print(f"[convert] All {len(started)} synthesis tasks started — waiting for completion...")

        # Phase B: Poll + download + convert in parallel, with limited concurrency on
        # the download/convert side (these are CPU/network bound, not API-quota bound)
        dl_semaphore = asyncio.Semaphore(2)  # keep well under the 100/min operation-status quota
        finish_tasks = [
            process_chapter_finish(ch, ops, path, dl_semaphore)
            for ch, ops, path in started
        ]
        results = await asyncio.gather(*finish_tasks)

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
