#!/usr/bin/env python3
"""
epub_to_audiobook.py — Convert an EPUB file into a full M4B audiobook.

Mimics epub2tts functionality:
1. Parse EPUB using ebooklib — extract chapter titles + text
2. Clean text (strip HTML, page numbers, etc.)
3. Generate speech per chapter using edge-tts CLI (free Microsoft neural voices)
4. Combine all chapter MP3s into a single M4B file using ffmpeg
5. Embed metadata (title, author) into the M4B

Usage:
  python3 epub_to_audiobook.py <input.epub> <output.m4b> [--voice en-US-AriaNeural] [--rate +0%]

Output:
  A single .m4b audiobook file with chapter markers.

Requirements:
  - edge-tts (pip install edge-tts)
  - ebooklib (pip install ebooklib)
  - beautifulsoup4 (pip install beautifulsoup4)
  - ffmpeg (system package)
"""

import sys
import os
import re
import subprocess
import tempfile
import json
import argparse
from pathlib import Path

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup


def clean_text(html_content):
    """Extract clean readable text from HTML content."""
    soup = BeautifulSoup(html_content, 'html.parser')
    # Remove non-content elements
    for tag in soup.find_all(['script', 'style', 'nav', 'header', 'footer', 'aside', 'link', 'meta']):
        tag.decompose()
    text = soup.get_text(separator=' ')
    # Clean up whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    # Remove standalone page numbers
    text = re.sub(r'\b\d{1,4}\b(?=\s|$)', '', text)
    # Clean up double spaces from removals
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def parse_epub(epub_path):
    """Parse an EPUB file and return (title, author, chapters).
    
    chapters is a list of {title, text} dicts in reading order.
    """
    book = epub.read_epub(epub_path)
    
    # Get metadata
    title = book.get_metadata('DC', 'title')
    title = title[0][0] if title else 'Untitled'
    author = book.get_metadata('DC', 'creator')
    author = author[0][0] if author else 'Unknown'
    
    # Build TOC map from the table of contents
    toc_map = {}
    for item in book.toc:
        if isinstance(item, epub.Link):
            href = item.href.split('#')[0]
            toc_map[href] = item.title
        elif isinstance(item, tuple):
            # Section with sub-items
            section, sub_items = item
            if hasattr(section, 'href'):
                href = section.href.split('#')[0]
                toc_map[href] = section.title
            for sub in sub_items:
                if hasattr(sub, 'href'):
                    href = sub.href.split('#')[0]
                    toc_map[href] = sub.title
    
    chapters = []
    order = 0
    
    # Iterate through spine items (reading order)
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        html_content = item.get_content().decode('utf-8', errors='ignore')
        text = clean_text(html_content)
        
        if len(text) < 50:
            continue  # Skip near-empty chapters
        
        # Get chapter title
        href = item.get_name().split('#')[0]
        chapter_title = toc_map.get(href, '')
        
        if not chapter_title:
            # Try to extract from first heading
            soup = BeautifulSoup(html_content, 'html.parser')
            heading = soup.find(['h1', 'h2', 'h3'])
            if heading:
                chapter_title = heading.get_text().strip()[:200]
        
        if not chapter_title:
            chapter_title = f'Chapter {order + 1}'
        
        chapters.append({
            'title': chapter_title[:200],
            'text': text,
            'order': order,
        })
        order += 1
    
    return title, author, chapters


def generate_tts(text, output_path, voice='en-US-AriaNeural', rate='+0%'):
    """Generate TTS audio using edge-tts CLI.
    
    Splits long text into segments to avoid edge-tts limitations.
    """
    # edge-tts CLI can handle moderate-length text directly
    # For very long text (>5000 chars), split into segments
    max_len = 5000
    segments = []
    if len(text) > max_len:
        # Split on paragraph boundaries
        paragraphs = text.split('\n\n')
        current = ''
        for para in paragraphs:
            if len(current) + len(para) > max_len and current:
                segments.append(current)
                current = para
            else:
                current = (current + '\n\n' + para).strip() if current else para
        if current:
            segments.append(current)
    else:
        segments = [text]
    
    if len(segments) == 1:
        # Single segment — generate directly
        cmd = [
            'edge-tts',
            '--voice', voice,
            '--rate', rate,
            '--text', segments[0],
            '--write-media', output_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f'edge-tts failed: {result.stderr}')
        return
    
    # Multiple segments — generate each, then concatenate
    temp_dir = os.path.dirname(output_path)
    temp_files = []
    
    for i, segment in enumerate(segments):
        temp_path = os.path.join(temp_dir, f'seg_{i:04d}.mp3')
        cmd = [
            'edge-tts',
            '--voice', voice,
            '--rate', rate,
            '--text', segment,
            '--write-media', temp_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f'edge-tts failed for segment {i}: {result.stderr}')
        temp_files.append(temp_path)
    
    # Concatenate using ffmpeg
    concat_file = os.path.join(temp_dir, 'concat.txt')
    with open(concat_file, 'w') as f:
        for temp_path in temp_files:
            f.write(f"file '{temp_path}'\n")
    
    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', concat_file,
        '-c', 'copy',
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    
    # Clean up temp files
    for temp_path in temp_files:
        try:
            os.remove(temp_path)
        except:
            pass
    try:
        os.remove(concat_file)
    except:
        pass
    
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg concat failed: {result.stderr}')


def get_audio_duration(audio_path):
    """Get duration of audio file in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'json',
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return 0
    data = json.loads(result.stdout)
    return int(float(data['format']['duration']))


def combine_chapters_to_m4b(chapter_files, output_path, title, author):
    """Combine multiple chapter MP3s into a single M4B with chapter markers.
    
    Uses ffmpeg to concatenate and add metadata.
    """
    temp_dir = os.path.dirname(output_path)
    
    # Create concat list
    concat_file = os.path.join(temp_dir, 'concat_all.txt')
    with open(concat_file, 'w') as f:
        for ch_path in chapter_files:
            f.write(f"file '{ch_path}'\n")
    
    # Build ffmpeg metadata for chapters
    metadata_file = os.path.join(temp_dir, 'metadata.txt')
    current_time = 0
    with open(metadata_file, 'w') as f:
        f.write(';FFMETADATA1\n')
        f.write(f'title={title}\n')
        f.write(f'artist={author}\n')
        for i, (ch_path, ch_title, duration) in enumerate(chapter_files):
            start_time = current_time * 1000000  # microseconds
            end_time = (current_time + duration) * 1000000
            f.write(f'\n[CHAPTER]\n')
            f.write(f'TIMEBASE=1/1000000\n')
            f.write(f'START={start_time}\n')
            f.write(f'END={end_time}\n')
            f.write(f'title={ch_title}\n')
            current_time += duration
    
    # Combine with ffmpeg
    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', concat_file,
        '-i', metadata_file,
        '-map', '0:a',
        '-map_metadata', '1',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-f', 'mp4',
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    
    # Clean up
    try:
        os.remove(concat_file)
        os.remove(metadata_file)
    except:
        pass
    
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg M4B combine failed: {result.stderr}')


def main():
    parser = argparse.ArgumentParser(description='Convert EPUB to M4B audiobook')
    parser.add_argument('input', help='Input EPUB file path')
    parser.add_argument('output', help='Output M4B file path')
    parser.add_argument('--voice', default='en-US-AriaNeural', help='Edge TTS voice')
    parser.add_argument('--rate', default='+0%', help='Speech rate (e.g. +10%, -10%)')
    parser.add_argument('--output-format', default='m4b', choices=['m4b', 'mp3_per_chapter'],
                        help='Output format: single M4B file or MP3 per chapter')
    args = parser.parse_args()
    
    print(f'[epub-to-audiobook] Parsing EPUB: {args.input}')
    title, author, chapters = parse_epub(args.input)
    
    if not chapters:
        print(json.dumps({'error': 'No readable chapters found'}))
        sys.exit(1)
    
    print(f'[epub-to-audiobook] Found: "{title}" by {author}, {len(chapters)} chapters')
    
    temp_dir = tempfile.mkdtemp(prefix='audiobook_')
    
    if args.output_format == 'mp3_per_chapter':
        # Generate one MP3 per chapter
        results = []
        for i, chapter in enumerate(chapters):
            chapter_path = os.path.join(temp_dir, f'chapter_{i:04d}.mp3')
            print(f'[epub-to-audiobook] Generating chapter {i+1}/{len(chapters)}: {chapter["title"]}')
            
            try:
                generate_tts(chapter['text'], chapter_path, args.voice, args.rate)
                duration = get_audio_duration(chapter_path)
                
                # Move to output directory with chapter number
                output_dir = os.path.dirname(args.output)
                final_path = os.path.join(output_dir, f'chapter-{i:04d}.mp3')
                os.rename(chapter_path, final_path)
                
                results.append({
                    'chapter': i,
                    'title': chapter['title'],
                    'file': final_path,
                    'duration': duration,
                })
                print(f'[epub-to-audiobook] Chapter {i+1} done ({duration}s)')
            except Exception as e:
                print(f'[epub-to-audiobook] Chapter {i+1} FAILED: {e}')
                results.append({
                    'chapter': i,
                    'title': chapter['title'],
                    'error': str(e),
                })
        
        # Output results as JSON
        print(json.dumps({
            'title': title,
            'author': author,
            'chapters': results,
            'output_dir': os.path.dirname(args.output),
        }))
    
    else:  # m4b
        # Generate all chapters then combine into M4B
        chapter_files = []
        for i, chapter in enumerate(chapters):
            chapter_path = os.path.join(temp_dir, f'chapter_{i:04d}.mp3')
            print(f'[epub-to-audiobook] Generating chapter {i+1}/{len(chapters)}: {chapter["title"]}')
            
            try:
                generate_tts(chapter['text'], chapter_path, args.voice, args.rate)
                duration = get_audio_duration(chapter_path)
                chapter_files.append((chapter_path, chapter['title'], duration))
                print(f'[epub-to-audiobook] Chapter {i+1} done ({duration}s)')
            except Exception as e:
                print(f'[epub-to-audiobook] Chapter {i+1} FAILED: {e}')
        
        if not chapter_files:
            print(json.dumps({'error': 'All chapters failed to generate'}))
            sys.exit(1)
        
        print(f'[epub-to-audiobook] Combining {len(chapter_files)} chapters into M4B...')
        combine_chapters_to_m4b(chapter_files, args.output, title, author)
        
        total_duration = sum(d for _, _, d in chapter_files)
        print(json.dumps({
            'title': title,
            'author': author,
            'total_chapters': len(chapters),
            'generated_chapters': len(chapter_files),
            'total_duration': total_duration,
            'output': args.output,
        }))
    
    # Clean up temp dir
    import shutil
    try:
        shutil.rmtree(temp_dir)
    except:
        pass


if __name__ == '__main__':
    main()
