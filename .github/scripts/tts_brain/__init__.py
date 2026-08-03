"""
tts_brain — EPUB → TTS-optimized chapters brain.

Ported from https://github.com/gfrangiamone/audiobook-maker with explicit
permission from the author. This package contains the parser brain only:
spine-based reading order, TOC reconciliation, multi-chapter single-file
splitting, front/back matter filtering, and TTS text cleaning.

Public API:
    parse_epub_for_tts(epub_path) -> (title, author, chapters)
        chapters: list of {"title": str, "text": str, "order": int}
"""
from .epub_parser import parse_epub_for_tts, parse_epub, BookInfo, Chapter, clean_text_for_tts

__all__ = ["parse_epub_for_tts", "parse_epub", "BookInfo", "Chapter", "clean_text_for_tts"]
