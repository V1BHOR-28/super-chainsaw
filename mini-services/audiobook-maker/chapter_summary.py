"""chapter_summary — deterministic 3-pass English chapter summary.

Pass A (map)    : each ~400-word window -> plain factual bullets (LLM, parallel)
Pass B (merge)  : deterministic dedupe/ordering into one event ledger (no LLM)
Pass C (reduce) : ledger -> exactly 2 English paragraphs (LLM)

No Hindi, no TTS, no translation. Fail-soft: always returns text or None.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor

CACHE_VERSION = "s1"
WINDOW_WORDS = 400
WINDOW_MIN_WORDS = 150
MAX_WINDOWS = 24
MAX_LEDGER_BULLETS = 40
MAX_WORKERS = 4

_SENT_END = re.compile(r"[.!?;:\u2014]")


def normalize_text(text: str) -> str:
    text = (text or "").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def segment_windows(text: str, window_words: int = WINDOW_WORDS) -> list[str]:
    """Bounded, lossless segmentation. start always advances (no infinite loop),
    every source word appears exactly once, never more than MAX_WINDOWS windows."""
    words = normalize_text(text).split()
    if not words:
        return []
    n = len(words)
    size = max(WINDOW_MIN_WORDS, window_words)
    if n / size > MAX_WINDOWS:
        size = -(-n // MAX_WINDOWS)  # ceil

    windows: list[str] = []
    start = 0
    while start < n:
        target = min(start + size, n)
        end = target
        if target < n:
            slack = max(10, size // 6)
            lo = max(start + size // 2, target - slack)
            hi = min(n, target + slack)
            for i in range(target, lo - 1, -1):
                if _SENT_END.search(words[i - 1]):
                    end = i
                    break
            else:
                for i in range(target + 1, hi + 1):
                    if _SENT_END.search(words[i - 1]):
                        end = i
                        break
        if end <= start:            # hard progress guarantee
            end = min(start + size, n)
        windows.append(" ".join(words[start:end]))
        start = end
    while len(windows) > MAX_WINDOWS:
        tail = windows.pop()
        windows[-1] = windows[-1] + " " + tail
    return windows


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    return [p.strip() for p in parts if p.strip()]


def _norm_bullet(b: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", b.lower()).strip()


def _client():
    try:
        import generation_engine as ge
        c = getattr(ge, "_llm_client", None)
        if c is not None:
            return c
    except Exception:
        pass
    key = os.environ.get("ABM_LLM_API_KEY", "")
    if not key:
        return None
    try:
        from openai import OpenAI
        return OpenAI(api_key=key,
                      base_url=os.environ.get("ABM_LLM_API_BASE",
                                              "https://api.groq.com/openai/v1"))
    except Exception:
        return None


def _models() -> list[str]:
    raw = os.environ.get("ABM_SUMMARY_MODELS", "")
    if raw.strip():
        return [m.strip() for m in raw.split(",") if m.strip()]
    return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]


def llm_chat(system: str, user: str, *, temperature: float = 0.3,
             max_tokens: int = 900) -> str | None:
    client = _client()
    if client is None:
        return None
    for model in _models():
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": user}],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            out = (r.choices[0].message.content or "").strip()
            if out:
                return out
        except Exception as e:
            print(f"[summary] model {model} failed: {e}")
    return None


_MAP_SYSTEM = (
    "You extract facts from one excerpt of a book chapter.\n"
    "Rules:\n"
    "- Output 3 to 6 bullet lines, each starting with '- '.\n"
    "- Each bullet is one short third-person sentence about what actually "
    "happens in THIS excerpt: who acts, what they do or say, where.\n"
    "- Use only names and facts present in the excerpt. Invent nothing.\n"
    "- Never say 'the narrator says' about another character's speech; "
    "attribute speech to the character who speaks it.\n"
    "- No analysis, no themes, no commentary, no preamble."
)


def _extractive_bullets(window: str, limit: int = 3) -> list[str]:
    out = []
    for s in _sentences(window):
        s = " ".join(s.split())
        if len(s.split()) >= 6:
            out.append(s if len(s) <= 240 else s[:237] + "...")
        if len(out) >= limit:
            break
    return out or [" ".join(window.split()[:40])]


def map_window(window: str, idx: int, total: int) -> list[str]:
    raw = llm_chat(
        _MAP_SYSTEM,
        f"Excerpt {idx + 1} of {total}:\n\n{window}",
        temperature=0.2, max_tokens=500,
    )
    bullets: list[str] = []
    for line in (raw or "").splitlines():
        line = line.strip()
        line = re.sub(r"^[-*\u2022]\s*", "", line)
        line = re.sub(r"^\d+[.)]\s*", "", line)
        if len(line.split()) >= 4:
            bullets.append(line)
    if not bullets:
        bullets = _extractive_bullets(window)
    return bullets[:6]


def map_all(windows: list[str]) -> list[list[str]]:
    total = len(windows)
    if total == 0:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, total)) as ex:
        return list(ex.map(lambda p: map_window(p[1], p[0], total),
                           list(enumerate(windows))))


def build_ledger(per_window: list[list[str]]) -> list[str]:
    """Deterministic: reading order, drop near-duplicates, cap size while always
    keeping the first and last window's bullets (protects the chapter ending)."""
    seen: set[str] = set()
    flat: list[tuple[int, str]] = []
    for wi, bullets in enumerate(per_window):
        for b in bullets:
            k = _norm_bullet(b)
            if not k or k in seen:
                continue
            seen.add(k)
            flat.append((wi, b))
    if len(flat) <= MAX_LEDGER_BULLETS:
        return [b for _, b in flat]
    last = len(per_window) - 1
    keep_idx = [i for i, (wi, _) in enumerate(flat) if wi in (0, last)]
    middle = [i for i in range(len(flat)) if i not in set(keep_idx)]
    room = max(0, MAX_LEDGER_BULLETS - len(keep_idx))
    if room and middle:
        step = len(middle) / room
        keep_idx += [middle[int(i * step)] for i in range(room)]
    return [flat[i][1] for i in sorted(set(keep_idx))]


_REDUCE_SYSTEM = (
    "You write a plain English chapter summary for an audiobook app.\n"
    "Input is an ordered list of facts from one chapter, in reading order.\n"
    "Rules:\n"
    "- Write exactly TWO paragraphs separated by one blank line.\n"
    "- Paragraph 1: the first half of the chapter. Paragraph 2: the second "
    "half, and it MUST cover how the chapter ends.\n"
    "- 90 to 160 words per paragraph. Simple, clear, third person, past tense.\n"
    "- Cover every fact given; do not add facts, quotes, themes or opinions.\n"
    "- No headings, no bullets, no markdown, no preamble."
)


def reduce_ledger(ledger: list[str], chapter_title: str = "") -> str | None:
    facts = "\n".join(f"- {b}" for b in ledger)
    head = f"Chapter: {chapter_title}\n\n" if chapter_title else ""
    return llm_chat(_REDUCE_SYSTEM, f"{head}Facts in reading order:\n{facts}",
                    temperature=0.35, max_tokens=800)


def clean_prose(text: str) -> str:
    text = re.sub(r"^\s*(here('|\u2019)s|summary[:\-])\s*.*?\n", "", text or "",
                  flags=re.I)
    text = re.sub(r"[*#`>]+", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    paras = [" ".join(p.split()) for p in text.split("\n\n") if p.strip()]
    if len(paras) > 2:
        mid = len(paras) // 2 or 1
        paras = [" ".join(paras[:mid]), " ".join(paras[mid:])]
    return "\n\n".join(paras)


def is_degenerate(text: str) -> bool:
    sents = [_norm_bullet(s) for s in _sentences(text) if s.strip()]
    if not sents:
        return True
    uniq = len(set(sents))
    return uniq < max(3, int(len(sents) * 0.6))


def covers_tail(text: str, ledger: list[str], tail_n: int = 3) -> bool:
    body = _norm_bullet(text)
    stop = {"the", "and", "was", "were", "with", "that", "then", "from", "his",
            "her", "him", "she", "they", "them", "for", "had", "who", "into"}
    for bullet in ledger[-tail_n:]:
        toks = [w for w in _norm_bullet(bullet).split()
                if len(w) > 3 and w not in stop]
        if toks and any(t in body for t in toks):
            return True
    return not ledger


def ledger_fallback(ledger: list[str]) -> str:
    if len(ledger) > 14:
        ledger = ledger[:8] + ledger[-6:]
    sents = []
    for b in ledger:
        b = b.strip().rstrip(".")
        if b:
            sents.append(b[0].upper() + b[1:] + ".")
    mid = max(1, len(sents) // 2)
    return " ".join(sents[:mid]) + "\n\n" + " ".join(sents[mid:])


def generate_summary(chapter_text: str, chapter_title: str = "") -> dict:
    """Return {'summary': str, 'ledger': [...], 'windows': n, 'source': str}."""
    windows = segment_windows(chapter_text)
    if not windows:
        return {"summary": "", "ledger": [], "windows": 0, "source": "empty"}
    per_window = map_all(windows)
    ledger = build_ledger(per_window)

    for attempt in range(2):
        raw = reduce_ledger(ledger, chapter_title)
        if not raw:
            continue
        prose = clean_prose(raw)
        if (len(prose.split()) >= 80 and not is_degenerate(prose)
                and covers_tail(prose, ledger)):
            return {"summary": prose, "ledger": ledger,
                    "windows": len(windows), "source": f"llm{attempt + 1}"}
    return {"summary": clean_prose(ledger_fallback(ledger)), "ledger": ledger,
            "windows": len(windows), "source": "fallback"}


def _r2_key(job_id: str, chapter_index: int) -> str:
    return f"summaries/{job_id}/{chapter_index}.{CACHE_VERSION}.json.gz"


def _r2_get(job_id: str, chapter_index: int) -> dict | None:
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return None
        key = _r2_key(job_id, chapter_index)
        if not storage_backend.object_exists(key):
            return None
        fd, tmp = tempfile.mkstemp(suffix=".json.gz")
        os.close(fd)
        try:
            storage_backend.download_file(key, tmp)
            with open(tmp, "rb") as f:
                return json.loads(gzip.decompress(f.read()).decode("utf-8"))
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except Exception as e:
        print(f"[summary] R2 get failed {job_id}/{chapter_index}: {e}")
    return None


def _r2_put(job_id: str, chapter_index: int, payload: dict) -> bool:
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return False
        fd, tmp = tempfile.mkstemp(suffix=".json.gz")
        os.close(fd)
        try:
            with open(tmp, "wb") as f:
                f.write(gzip.compress(json.dumps(payload).encode("utf-8")))
            storage_backend.upload_file(tmp, _r2_key(job_id, chapter_index))
            return True
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except Exception as e:
        print(f"[summary] R2 put failed {job_id}/{chapter_index}: {e}")
        return False


def get_or_create_summary(job_id: str, chapter_index: int, chapter_text: str,
                          chapter_title: str = "") -> dict | None:
    cached = _r2_get(job_id, chapter_index)
    if cached and cached.get("summary"):
        cached["cached"] = True
        return cached
    result = generate_summary(chapter_text, chapter_title)
    if not result.get("summary"):
        return None
    result["text_sha"] = hashlib.sha256(
        (chapter_text or "").encode("utf-8")).hexdigest()[:16]
    _r2_put(job_id, chapter_index, result)
    result["cached"] = False
    return result
