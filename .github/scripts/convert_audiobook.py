#!/usr/bin/env python3
"""
convert_audiobook.py — Convert an EPUB into audiobook chapter MP3s.

Runs on a GitHub Actions runner (45-minute timeout). Downloads the EPUB,
parses it with ebooklib, generates TTS per chapter using Google Cloud
Text-to-Speech Long Audio API (synthesize_long_audio), uploads each MP3
to Vercel Blob concurrently, then calls the app's callback route.

EPUB parsing is delegated to tts_brain.epub_parser — a verbatim port of
the audiobook-maker repo's parser brain
(https://github.com/gfrangiamone/audiobook-maker) with explicit permission
from the author. That brain handles spine↔TOC orphan reconciliation,
multilingual chapter-marker detection, word-boundary frontmatter filtering,
parenthetical/footnote/URL noise stripping, abbreviation expansion, and
LIS-based heading-to-TOC assignment for single-file EPUBs.

Each chapter is a self-contained retryable pipeline: submit → wait →
upload, and on backend failure (InternalServerError/ServiceUnavailable)
the chapter is resubmitted as a FRESH operation rather than re-polling
the dead one. ResourceExhausted (429) is still retried at the poll
level because the operation is alive, just throttled. Concurrency is
governed by a single semaphore so chapters process in parallel while
each owns its full retry cycle independently.

Google Cloud TTS produces high-quality narration via Neural2 voices.
This is a paid GCP service — estimated cost is ~$0.000016 per character
for Neural2 voices (check current pricing at cloud.google.com/text-to-speech/pricing).

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

from google.api_core.exceptions import ResourceExhausted, InternalServerError, ServiceUnavailable
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
TTS_VOICE          = "en-US-Neural2-F"  # Reliable standard-tier voice — Journey's TPU backend has documented overload issues; Neural2 doesn't share that infra
TTS_LANGUAGE       = "en-US"
MAX_CHARS_PER_TASK = 700_000  # Long Audio API limit (~750K chars)

# Initialize GCP clients once at module level
_tts_client     = texttospeech.TextToSpeechLongAudioSynthesizeClient()
_storage_client = storage.Client()

# Log GCS bucket location at startup — if it's not us-central1, cross-region
# writes to it from the TTS backend (us-central1) are slower and fail more often.
# This is diagnostic: the user sees the location in the Actions log and can
# relocate the bucket if needed.
try:
    _bucket_meta = _storage_client.bucket(GCS_BUCKET)
    _bucket_meta.reload(requests_params={"timeout": 10})
    _bucket_location = getattr(_bucket_meta, "location", "unknown") or "unknown"
    if _bucket_location.lower() not in ("us-central1", "us", "unknown"):
        print(f"[gcs] WARNING: bucket {GCS_BUCKET} is in {_bucket_location}, but TTS runs in us-central1. "
              f"Cross-region writes are slower and fail more often. Consider relocating the bucket to us-central1.",
              file=sys.stderr)
    else:
        print(f"[gcs] Bucket {GCS_BUCKET} location: {_bucket_location} (matches TTS region)")
except Exception as _e:
    print(f"[gcs] Could not check bucket location (non-fatal): {_e}", file=sys.stderr)


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


def force_break_long_sentences(text: str, max_sentence_chars: int = 1000) -> str:
    """
    Insert a period+space at the nearest comma, semicolon, or word boundary
    if a 'sentence' (text between real sentence-ending punctuation) exceeds
    max_sentence_chars. This is a safety net for extraction artifacts, not a
    style choice — it only fires on abnormally long runs.
    """
    sentences = re.split(r'(?<=[.!?])\s+', text)
    fixed = []
    for sentence in sentences:
        if len(sentence) <= max_sentence_chars:
            fixed.append(sentence)
            continue
        # Break the oversized "sentence" at the nearest comma/semicolon past
        # the midpoint, repeatedly, until every piece is under the limit.
        remaining = sentence
        while len(remaining) > max_sentence_chars:
            window = remaining[:max_sentence_chars]
            break_point = max(window.rfind(', '), window.rfind('; '))
            if break_point < max_sentence_chars // 3:
                break_point = window.rfind(' ')  # last resort: any word boundary
            if break_point <= 0:
                break_point = max_sentence_chars  # truly no break found — hard cut
            fixed.append(remaining[:break_point].strip() + '.')
            remaining = remaining[break_point:].strip()
        if remaining:
            fixed.append(remaining)
    return ' '.join(fixed)


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

    Delegates to tts_brain.epub_parser — a verbatim port of the audiobook-maker
    repo's parser brain (https://github.com/gfrangiamone/audiobook-maker) with
    explicit permission from the author. That parser is substantially more
    sophisticated than the legacy one below: spine↔TOC orphan reconciliation,
    backnote arrow filtering, multilingual chapter-marker detection, word-
    boundary frontmatter filtering, parenthetical/footnote/URL noise stripping,
    abbreviation expansion, roman-numeral corruption fix, and LIS-based heading-
    to-TOC assignment for single-file EPUBs.

    The legacy implementation is preserved as parse_epub_legacy() below for
    fallback / comparison purposes.
    """
    from tts_brain import parse_epub_for_tts
    return parse_epub_for_tts(epub_path)


def parse_epub_legacy(epub_path: str):
    """Legacy EPUB parser — kept for fallback / comparison.

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
    Does NOT wait for completion — call wait_for_all_operations() for that.
    Returns a list of (gcs_uri, operation) tuples (one per text segment).
    """
    segments = split_for_tts(force_break_long_sentences(text), max_len=MAX_CHARS_PER_TASK)
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


# ── TTS: poll, download WAV, convert to MP3 ─────────────────────────────────
def _wait_for_operation(operation, seg_uri, timeout_s):
    """
    Wait for a single Long Audio operation.

    Retries ResourceExhausted (429) — the operation is still valid, just
    being throttled, so polling the same operation again later is correct.

    Does NOT retry InternalServerError / ServiceUnavailable — those mean
    the operation itself died on Google's backend, and re-polling it will
    forever return the same terminal failure. The caller (synthesize_chapter)
    must submit a FRESH operation instead, which it does one level up.
    """
    delay = 15
    for attempt in range(3):  # only for genuine rate-limit backoff, not backend death
        try:
            operation.result(timeout=timeout_s)
            return
        except ResourceExhausted as e:
            if attempt == 2:
                raise
            print(f"[tts] Rate-limited polling {seg_uri}, waiting {delay}s (attempt {attempt + 1}/3)", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 60)
        except (InternalServerError, ServiceUnavailable) as e:
            # Operation is dead — don't retry polling it, let the caller resubmit fresh.
            raise
        except Exception as e:
            raise RuntimeError(f"TTS operation failed for {seg_uri}: {e}")


from concurrent.futures import ThreadPoolExecutor


def wait_for_all_operations(operations: list, timeout_s: int = 600) -> None:
    """
    Poll ALL operations to completion in PARALLEL.

    For multi-segment chapters (text > 700K chars, split into multiple
    synthesis operations), this polls all segments concurrently instead of
    sequentially. A 3-segment chapter that took 6 min to poll serially now
    takes ~2 min (the slowest segment's duration).
    """
    if not operations:
        return
    with ThreadPoolExecutor(max_workers=max(1, len(operations))) as executor:
        futures = [
            executor.submit(_wait_for_operation, op, seg_uri, timeout_s)
            for seg_uri, op in operations
        ]
        for f in futures:
            f.result()  # raises if any operation failed


def download_and_convert_segment(seg_uri: str, output_mp3_path: str, part_index: int) -> str:
    """
    Download one WAV from GCS, convert to MP3 with ffmpeg, delete GCS object.
    Returns the local MP3 path.
    """
    bucket_name = GCS_BUCKET
    gcs_object_path = seg_uri.replace(f"gs://{bucket_name}/", "")
    local_wav = output_mp3_path.replace(".mp3", f"-{part_index:04d}.wav")
    local_mp3 = output_mp3_path.replace(".mp3", f"-{part_index:04d}.mp3")

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
    return local_mp3


def download_and_convert_all_segments(operations: list, output_mp3_path: str) -> list:
    """
    Download + convert ALL segments in PARALLEL.

    For multi-segment chapters, this downloads and converts all segments
    concurrently instead of sequentially. Download is network-bound, ffmpeg
    is CPU-bound — running them in parallel overlaps I/O with compute.
    """
    if not operations:
        raise RuntimeError("No audio produced")
    with ThreadPoolExecutor(max_workers=max(1, len(operations))) as executor:
        futures = [
            executor.submit(download_and_convert_segment, seg_uri, output_mp3_path, idx)
            for idx, (seg_uri, op) in enumerate(operations)
        ]
        return [f.result() for f in futures]


def concat_mp3_parts(mp3_parts: list, output_mp3_path: str) -> None:
    """Concatenate MP3 parts into final file (or rename if single)."""
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


# ── Retryable per-chapter pipeline ───────────────────────────────────────────
MAX_CHAPTER_ATTEMPTS = 4


async def synthesize_chapter(chapter, tmp_dir, semaphore):
    """
    Fully synthesize one chapter, retrying with a FRESH operation (not
    re-polling a dead one) on backend failure.

    SEMAPHARE SCOPE: covers submit + poll only. Download/convert/upload
    happens OUTSIDE the semaphore so the next chapter can start synthesizing
    while this one is still downloading/converting/uploading. This overlaps
    30-60s of post-synthesis I/O with the next chapter's 2-10min synthesis —
    saving ~30-60s per chapter, ~17-35min on a 35-chapter book.

    Returns {"order": int, "title": str, "url": str | None}.
    """
    i = chapter["order"]
    title = chapter["title"]
    output_path = os.path.join(tmp_dir, f"chapter_{i:04d}.mp3")
    gcs_uri = f"gs://{GCS_BUCKET}/tts-tmp/{JOB_ID}/chapter-{i:04d}.wav"
    loop = asyncio.get_running_loop()
    operations = None

    # ── SEMAPHORE-HELD: submit + poll (hits Google's TTS API) ──
    async with semaphore:
        last_err = None
        for attempt in range(MAX_CHAPTER_ATTEMPTS):
            try:
                print(f"[convert] Chapter {i+1} '{title}': submitting (attempt {attempt+1}/{MAX_CHAPTER_ATTEMPTS})")
                operations = await loop.run_in_executor(
                    None, start_synthesis_task, chapter["text"], gcs_uri, i
                )
                # Poll all operations in parallel (multi-segment chapters)
                await loop.run_in_executor(None, wait_for_all_operations, operations, 600)
                break  # success — exit retry loop, semaphore will release
            except Exception as e:
                last_err = e
                operations = None
                if attempt < MAX_CHAPTER_ATTEMPTS - 1:
                    # Error-specific backoff: different failure modes clear at
                    # different speeds, so a flat 20s wastes time on fast-clearing
                    # errors and is too aggressive on rate limits.
                    err_str = str(e).lower()
                    if "failed to write to gcs" in err_str:
                        wait = 3 * (attempt + 1)    # 3s, 6s, 9s — GCS hiccups clear in seconds
                    elif "resourceexhausted" in type(e).__name__.lower() or "429" in err_str:
                        wait = 15 * (attempt + 1)   # 15s, 30s, 45s — rate limits need real backoff
                    else:
                        wait = 8 * (attempt + 1)    # 8s, 16s, 24s — other backend errors (500/503)
                    print(f"[convert] Chapter {i+1} attempt {attempt+1} failed ({type(e).__name__}: {e}) — submitting a FRESH operation in {wait}s", file=sys.stderr)
                    await asyncio.sleep(wait)
        else:
            # All attempts failed — semaphore releases on return
            print(f"[convert] Chapter {i+1} FAILED permanently after {MAX_CHAPTER_ATTEMPTS} fresh attempts: {last_err}", file=sys.stderr)
            return {"order": i, "title": title, "url": None}

    # ── SEMAPHORE RELEASED: download/convert/upload (no Google API calls) ──
    # These are local/GCS/Blob operations — they don't hit Google's TTS API,
    # so they don't need rate-limiting. Running them outside the semaphore lets
    # the next chapter start synthesizing immediately.
    try:
        mp3_parts = await loop.run_in_executor(
            None, download_and_convert_all_segments, operations, output_path
        )
        await loop.run_in_executor(None, concat_mp3_parts, mp3_parts, output_path)
        blob_path = f"audiobooks/{JOB_ID}/chapter-{i:04d}.mp3"
        url = await upload_to_blob(output_path, blob_path)
        print(f"[convert] Chapter {i+1} done and uploaded")
        return {"order": i, "title": title, "url": url}
    except Exception as e:
        print(f"[convert] Chapter {i+1} FAILED in post-synthesis (download/convert/upload): {e}", file=sys.stderr)
        return {"order": i, "title": title, "url": None}
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

        # Semaphore governs concurrent SYNTHESIS (submit + poll only).
        # Download/convert/upload happens outside the semaphore, so this
        # limits Google API load, not total I/O. Google's project-wide limit
        # is 100 operation-status queries/min; Semaphore(3) = ~3-6 queries/min,
        # well under quota. Each in-flight chapter polls ~1-2 times/min.
        semaphore = asyncio.Semaphore(3)
        tasks = [synthesize_chapter(ch, tmp, semaphore) for ch in chapters]
        chapter_results = await asyncio.gather(*tasks)
        chapter_results.sort(key=lambda c: c["order"])

        succeeded = [c for c in chapter_results if c["url"]]
        if not succeeded:
            mark_status("failed", error_message="All chapters failed to generate")
            return

        print(f"[convert] Done! {len(succeeded)}/{len(chapters)} chapters generated")
        mark_status("complete", chapter_urls=chapter_results)  # full list incl. failures — callback only rows chapters with non-null url


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[convert] FATAL: {e}", file=sys.stderr)
        mark_status("failed", error_message=str(e))
        sys.exit(1)
