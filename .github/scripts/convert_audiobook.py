#!/usr/bin/env python3
"""
convert_audiobook.py — Convert an EPUB into audiobook chapter MP3s.

Runs on a GitHub Actions runner (free, 45-minute timeout). Downloads the
EPUB, parses it with ebooklib, generates TTS per chapter using edge-tts CLI,
uploads each MP3 to Vercel Blob, then calls the app's callback route.

Environment variables:
  JOB_ID              — The AudiobookJob ID
  EPUB_URL            — URL to download the EPUB file
  AUDIOBOOK_ID        — (optional) The Audiobook ID to update
  BLOB_READ_WRITE_TOKEN — Vercel Blob token for uploads
  APP_BASE_URL        — The app's base URL (e.g., https://ariav2-seven.vercel.app)
  APP_CALLBACK_SECRET — Shared secret for the callback route
"""

import os
import re
import sys
import json
import subprocess
import tempfile
import requests

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

JOB_ID = os.environ["JOB_ID"]
EPUB_URL = os.environ["EPUB_URL"]
AUDIOBOOK_ID = os.environ.get("AUDIOBOOK_ID", "")
BLOB_TOKEN = os.environ["BLOB_READ_WRITE_TOKEN"]
APP_BASE_URL = os.environ["APP_BASE_URL"]
CALLBACK_SECRET = os.environ["APP_CALLBACK_SECRET"]

VOICE = "en-US-AriaNeural"  # warm, natural female voice


def mark_status(status, chapter_urls=None, error_message=None):
    """Report status back to the app via the callback route."""
    try:
        requests.post(
            f"{APP_BASE_URL}/api/audiobooks/callback",
            headers={"Authorization": f"Bearer {CALLBACK_SECRET}"},
            json={
                "jobId": JOB_ID,
                "status": status,
                "chapterUrls": chapter_urls or [],
                "errorMessage": error_message,
            },
            timeout=30,
        )
    except Exception as e:
        print(f"[callback] Failed to report status {status}: {e}", file=sys.stderr)


def clean_text(html_content):
    """Extract clean readable text from HTML content."""
    soup = BeautifulSoup(html_content, "html.parser")
    for tag in soup.find_all(["script", "style", "nav", "header", "footer", "aside", "link", "meta"]):
        tag.decompose()
    text = soup.get_text(separator=" ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_epub(epub_path):
    """Parse EPUB and return (title, author, chapters)."""
    book = epub.read_epub(epub_path)

    title_meta = book.get_metadata("DC", "title")
    title = title_meta[0][0] if title_meta else "Untitled"
    author_meta = book.get_metadata("DC", "creator")
    author = author_meta[0][0] if author_meta else "Unknown"

    # Build TOC map
    toc_map = {}
    for item in book.toc:
        if isinstance(item, epub.Link):
            href = item.href.split("#")[0]
            toc_map[href] = item.title
        elif isinstance(item, tuple):
            section, sub_items = item
            if hasattr(section, "href"):
                href = section.href.split("#")[0]
                toc_map[href] = section.title
            for sub in sub_items:
                if hasattr(sub, "href"):
                    href = sub.href.split("#")[0]
                    toc_map[href] = sub.title

    chapters = []
    order = 0
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        html_content = item.get_content().decode("utf-8", errors="ignore")
        text = clean_text(html_content)
        if len(text) < 50:
            continue

        href = item.get_name().split("#")[0]
        chapter_title = toc_map.get(href, "")
        if not chapter_title:
            soup = BeautifulSoup(html_content, "html.parser")
            heading = soup.find(["h1", "h2", "h3"])
            if heading:
                chapter_title = heading.get_text().strip()[:200]
        if not chapter_title:
            chapter_title = f"Chapter {order + 1}"

        chapters.append({"title": chapter_title[:200], "text": text, "order": order})
        order += 1

    return title, author, chapters


def split_for_tts(text, max_len=3000):
    """Split long text into segments for TTS."""
    if len(text) <= max_len:
        return [text]
    paragraphs = text.split("\n\n")
    segments = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) > max_len and current:
            segments.append(current)
            current = para
        else:
            current = (current + "\n\n" + para).strip() if current else para
    if current:
        segments.append(current)
    return segments


def generate_chapter_tts(text, output_path):
    """Generate TTS audio for a chapter using edge-tts CLI."""
    segments = split_for_tts(text)
    temp_dir = os.path.dirname(output_path)

    if len(segments) == 1:
        cmd = ["edge-tts", "--voice", VOICE, "--text", segments[0], "--write-media", output_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"edge-tts failed: {result.stderr}")
        return

    # Multiple segments — generate each, then concatenate with ffmpeg
    temp_files = []
    for i, segment in enumerate(segments):
        seg_path = os.path.join(temp_dir, f"seg_{i:04d}.mp3")
        cmd = ["edge-tts", "--voice", VOICE, "--text", segment, "--write-media", seg_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"edge-tts failed for segment {i}: {result.stderr}")
        temp_files.append(seg_path)

    # Concatenate with ffmpeg
    concat_file = os.path.join(temp_dir, "concat.txt")
    with open(concat_file, "w") as f:
        for path in temp_files:
            f.write(f"file '{path}'\n")

    cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_file, "-c", "copy", output_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    # Cleanup
    for path in temp_files:
        try:
            os.remove(path)
        except:
            pass
    try:
        os.remove(concat_file)
    except:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {result.stderr}")


def upload_to_blob(file_path, blob_pathname):
    """Upload a file to Vercel Blob using the REST API."""
    with open(file_path, "rb") as f:
        file_data = f.read()

    # Vercel Blob REST API: multipart upload
    response = requests.put(
        f"https://blob.vercel-storage.com/{blob_pathname}",
        headers={
            "Authorization": f"Bearer {BLOB_TOKEN}",
            "Content-Type": "audio/mpeg",
            "x-content-type": "audio/mpeg",
            "x-access": "public",
        },
        data=file_data,
        timeout=120,
    )

    if response.status_code not in (200, 201):
        # Try the alternative API format (multipart form data)
        with open(file_path, "rb") as f:
            response = requests.post(
                "https://blob.vercel-storage.com/api/files",
                headers={"Authorization": f"Bearer {BLOB_TOKEN}"},
                files={"file": (blob_pathname, f, "audio/mpeg")},
                data={"pathname": blob_pathname, "access": "public"},
                timeout=120,
            )

    if response.status_code not in (200, 201):
        raise RuntimeError(f"Blob upload failed: {response.status_code} {response.text}")

    data = response.json()
    return data.get("url", data.get("blob", {}).get("url", ""))


def main():
    print(f"[convert] Starting job {JOB_ID} for {EPUB_URL}")
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
        print(f'[convert] Found: "{title}" by {author}, {len(chapters)} chapters')

        if not chapters:
            mark_status("failed", error_message="No readable chapters found")
            return

        # Generate TTS for each chapter and upload
        chapter_urls = []
        for i, chapter in enumerate(chapters):
            chapter_path = os.path.join(tmp, f"chapter_{i:04d}.mp3")
            print(f'[convert] Generating chapter {i+1}/{len(chapters)}: {chapter["title"]}')

            try:
                generate_chapter_tts(chapter["text"], chapter_path)

                # Upload to Vercel Blob
                blob_path = f"audiobooks/{JOB_ID}/chapter-{i:04d}.mp3"
                url = upload_to_blob(chapter_path, blob_path)
                chapter_urls.append(url)
                print(f"[convert] Chapter {i+1} uploaded: {url}")

            except Exception as e:
                print(f"[convert] Chapter {i+1} FAILED: {e}", file=sys.stderr)
                # Continue to next chapter — partial results are better than none

        if not chapter_urls:
            mark_status("failed", error_message="All chapters failed to generate")
            return

        print(f"[convert] Done! {len(chapter_urls)}/{len(chapters)} chapters generated")
        mark_status("complete", chapter_urls=chapter_urls)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[convert] FATAL: {e}", file=sys.stderr)
        mark_status("failed", error_message=str(e))
        sys.exit(1)
