"""translate.py — Hinglish translation for audiobook chapters.

Converts English chapter text to natural spoken Hinglish (romanized Hindi
with code-mixed English words) using the existing Groq LLM client.

Pipeline:
  1. Split text into ~800-word blocks on sentence boundaries.
  2. Call Groq (via the centralized groq_client) with a strict Hinglish prompt.
  3. Reject any output containing Devanagari (retry once, fall back to English).
  4. Cache to R2 (key: translations/{sha256}.txt) — never re-translate a hit.

Fail-safe: if >50% of blocks fail, raise so the caller can surface an error.
"""

import hashlib
import os
import re
import tempfile

# Devanagari Unicode range — reject any output containing these characters
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")

# System prompt for Hinglish translation
_HINGLISH_SYSTEM_PROMPT = (
    "You are a Hinglish audiobook translator. Convert the user's English text to "
    "natural spoken Hinglish: Hindi grammar and word order, written entirely in "
    "Roman/Latin script. Keep common English nouns and connectors (door, window, "
    "phone, actually, but, so, ok) in English exactly as an urban Indian bilingual "
    "speaker would say them. NEVER output Devanagari characters. NEVER translate "
    "proper nouns, names, or place names. Preserve paragraph breaks. Output ONLY "
    "the translated text, no preamble, no notes, no quotes."
)

# Block size: ~800 words, split on sentence boundaries
_BLOCK_WORDS = 800


def _split_into_blocks(text: str, max_words: int = _BLOCK_WORDS) -> list[str]:
    """Split text into blocks of ~max_words, splitting ONLY on sentence boundaries."""
    if not text or not text.strip():
        return []
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    blocks = []
    current = []
    current_words = 0
    for sent in sentences:
        w = len(sent.split())
        if current_words + w > max_words and current:
            blocks.append(" ".join(current))
            current = [sent]
            current_words = w
        else:
            current.append(sent)
            current_words += w
    if current:
        blocks.append(" ".join(current))
    return blocks


def _call_groq(text: str, client) -> str | None:
    """Call Groq with the Hinglish prompt via the centralized groq_client.

    Returns translated text or None. Never raises.
    """
    try:
        import groq_client as _gc
        result, code = _gc.groq_chat(
            _HINGLISH_SYSTEM_PROMPT, text,
            temperature=0.3, max_tokens=4096,
        )
        if code:
            print(f"[hinglish] Groq call failed: {code}")
        return result or None
    except Exception as e:
        print(f"[hinglish] Groq call failed: {e}")
        return None


def _has_devanagari(text: str) -> bool:
    """True if text contains any Devanagari characters."""
    return bool(_DEVANAGARI_RE.search(text))


def _cache_key(text: str) -> str:
    """R2 cache key for a given text."""
    h = hashlib.sha256((text + "|hinglish").encode("utf-8")).hexdigest()
    return f"translations/{h}.txt"


def _get_cached(text: str) -> str | None:
    """Check R2 for a cached translation. Returns None on miss."""
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return None
        key = _cache_key(text)
        if not storage_backend.object_exists(key):
            return None
        fd, tmp = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            storage_backend.download_file(key, tmp)
            with open(tmp, "r", encoding="utf-8") as f:
                return f.read().strip()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except Exception as e:
        print(f"[hinglish] R2 cache read failed: {e}")
    return None


def _put_cached(text: str, translation: str):
    """Write translation to R2 cache (best-effort)."""
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return
        key = _cache_key(text)
        fd, tmp = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(translation)
            storage_backend.upload_file(tmp, key)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except Exception as e:
        print(f"[hinglish] R2 cache write failed: {e}")


def translate_to_hinglish(text: str, groq_client) -> str:
    """Translate English text to Hinglish using Groq.

    Args:
        text: English chapter text.
        groq_client: An OpenAI-compatible client pointed at Groq.

    Returns:
        Hinglish translation (romanized Hindi, no Devanagari).

    Raises:
        RuntimeError: if >50% of blocks failed.
    """
    if not text or not text.strip():
        return text
    if groq_client is None:
        print("[hinglish] No Groq client available — returning original text")
        return text

    # Check R2 cache for the FULL chapter first
    cached = _get_cached(text)
    if cached:
        print(f"[hinglish] R2 cache hit ({len(cached)} chars)")
        return cached

    blocks = _split_into_blocks(text)
    if not blocks:
        return text

    print(f"[hinglish] Translating {len(blocks)} blocks (~{len(text.split())} words)")

    translated_blocks = []
    failed = 0
    for i, block in enumerate(blocks):
        # Check per-block cache
        block_cached = _get_cached(block)
        if block_cached:
            print(f"[hinglish] Block {i+1}/{len(blocks)}: cache hit")
            translated_blocks.append(block_cached)
            continue

        result = _call_groq(block, groq_client)

        # Reject Devanagari — retry once
        if result and _has_devanagari(result):
            print(f"[hinglish] Block {i+1}: Devanagari detected — retrying")
            result = _call_groq(block, groq_client)
            if result and _has_devanagari(result):
                print(f"[hinglish] Block {i+1}: still Devanagari after retry — falling back to English")
                result = None

        if result:
            translated_blocks.append(result)
            _put_cached(block, result)  # Cache the block
            print(f"[hinglish] Block {i+1}/{len(blocks)}: OK ({len(result)} chars)")
        else:
            translated_blocks.append(block)  # Fall back to English
            failed += 1
            print(f"[hinglish] Block {i+1}/{len(blocks)}: FAILED — using English")

    # Hard fail-safe: if >50% failed, raise
    if failed > len(blocks) * 0.5:
        raise RuntimeError(
            f"Hinglish translation failed: {failed}/{len(blocks)} blocks failed (>50%)"
        )

    translation = "\n\n".join(translated_blocks)

    # Cache the full chapter
    _put_cached(text, translation)
    print(f"[hinglish] Translation complete: {len(translation)} chars, {failed} blocks failed")
    return translation


def get_groq_client():
    """Get the Groq LLM client (reuses ABM_LLM_* env vars)."""
    try:
        import generation_engine as ge
        client = getattr(ge, "_llm_client", None)
        if client is not None:
            return client
    except ImportError:
        pass
    # Fallback: create a standalone client
    api_key = os.environ.get("ABM_LLM_API_KEY", "")
    api_base = os.environ.get("ABM_LLM_API_BASE", "https://api.groq.com/openai/v1")
    if not api_key:
        return None
    try:
        from openai import OpenAI
        return OpenAI(api_key=api_key, base_url=api_base)
    except Exception:
        return None
