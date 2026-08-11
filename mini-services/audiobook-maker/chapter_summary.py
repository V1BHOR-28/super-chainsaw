"""chapter_summary — single-call English chapter summary for the audiobook app.

One LLM call sends the full chapter text in a single user message. A two-model
Groq ladder (moonshotai/kimi-k2-instruct -> llama-3.3-70b-versatile) is tried in
order; the first model that returns output wins. If both models are unavailable
the summary degrades to an extractive sentence fallback. No chunking, no
map-reduce, no language filters. Fail-soft: always returns text or empty string.

Cache namespace: SUMMARY_CACHE_VERSION = "v15" (bumped from "s1" — the old
windowed map-reduce artifacts are structurally incompatible and must regenerate).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile

SUMMARY_CACHE_VERSION = "v15"

# Over this size the MIDDLE of the chapter is dropped (first 40% + last 40%).
MAX_CHARS = 100_000

# Groq OpenAI-compatible model ladder — first model that returns output wins.
_GROQ_MODELS = ("moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile")

# Sampling parameters (applied to every model in the ladder).
_TEMPERATURE = 0.3
_MAX_TOKENS = 900
_PRESENCE_PENALTY = 0.4
_FREQUENCY_PENALTY = 0.4
_TOP_P = 0.9

# Post-check thresholds.
_MIN_WORDS = 200
_MAX_WORDS = 450
_FORBIDDEN_SUBSTRINGS = ("the speaker", "the narrator", "In this chapter", "Summary:")

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _normalize(text: str) -> str:
    text = (text or "").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _sentences(text: str) -> list[str]:
    return [p.strip() for p in _SENT_SPLIT.split((text or "").strip()) if p.strip()]


def _norm_for_dedup(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", s.lower()).strip()


_SYSTEM_PROMPT = (
    "You summarize chapters of classic literature for an audiobook app.\n\n"
    "CRITICAL RULES ABOUT WHO IS SPEAKING:\n"
    "- Classic texts nest speech several levels deep: the narrator quotes a "
    "character, who quotes another character, who quotes a third.\n"
    "- Before writing, silently identify the narrator and every named speaker.\n"
    "- Never write 'the speaker', 'the narrator', 'a person', or an unanchored "
    "'he'/'she'. Always use the character's name.\n"
    "- When a character merely REPORTS what someone else did or said, write it as "
    "reported speech ('Virgil recounts that Beatrice told him...'). Never write it "
    "as an event the protagonist witnessed or performed.\n"
    "- Do not state that two characters met, travelled together, or spoke to each "
    "other unless the text says so directly.\n\n"
    "OUTPUT FORMAT:\n"
    "- Exactly two paragraphs of plain English prose. No headings, no bullets, no "
    "markdown, no preamble, no 'In this chapter'.\n"
    "- 120-200 words per paragraph.\n"
    "- Paragraph 1: the first half of the chapter's events. Paragraph 2: the second "
    "half, and it MUST cover how the chapter ends.\n"
    "- Name every character who speaks or acts. Include any major simile or image.\n"
    "- Third person, present tense, factual. No interpretation, no moralizing, no "
    "invented detail."
)


def _groq_client():
    """OpenAI-compatible client pointed at Groq.

    Prefers the shared, already-initialized LLM client from generation_engine
    (in production ABM_LLM_API_BASE points at Groq). Falls back to a standalone
    client built from ABM_LLM_API_KEY / ABM_LLM_API_BASE. Returns None if no
    key is available or the openai library is missing.
    """
    try:
        import generation_engine as ge  # type: ignore
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
        return OpenAI(
            api_key=key,
            base_url=os.environ.get("ABM_LLM_API_BASE",
                                    "https://api.groq.com/openai/v1"),
        )
    except Exception:
        return None


def _call_model(client, model: str, system: str, user: str) -> tuple[str | None, str | None]:
    """One non-streaming chat completion. Returns (text, error). Never raises."""
    try:
        r = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            temperature=_TEMPERATURE,
            max_tokens=_MAX_TOKENS,
            presence_penalty=_PRESENCE_PENALTY,
            frequency_penalty=_FREQUENCY_PENALTY,
            top_p=_TOP_P,
        )
        out = (r.choices[0].message.content or "").strip()
        return (out or None), None
    except Exception as e:  # noqa: BLE001 — fail-soft across the ladder
        return None, str(e)


def _maybe_truncate(text: str) -> str:
    """Only if the chapter exceeds MAX_CHARS, drop the middle: keep first 40% and
    last 40% joined by '\\n[...]\\n'."""
    if len(text) <= MAX_CHARS:
        return text
    keep = int(MAX_CHARS * 0.40)
    return text[:keep] + "\n[...]\n" + text[-keep:]


def _clean(raw: str) -> str:
    """Strip common LLM preamble/markdown and collapse to <=2 paragraphs."""
    text = re.sub(r"^\s*(here('|\u2019)s|summary[:\-])\s*.*?\n", "", raw or "",
                  flags=re.I)
    text = re.sub(r"[*#>`]+", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    paras = [" ".join(p.split()) for p in text.split("\n\n") if p.strip()]
    if len(paras) > 2:
        mid = len(paras) // 2 or 1
        paras = [" ".join(paras[:mid]), " ".join(paras[mid:])]
    return "\n\n".join(paras)


def _passes_checks(text: str) -> bool:
    """Cheap deterministic post-checks. See module docstring for the list."""
    if not text:
        return False
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) < 2:
        return False
    low = text.lower()
    for bad in _FORBIDDEN_SUBSTRINGS:
        if bad.lower() in low:
            return False
    norm = [_norm_for_dedup(s) for s in _sentences(text)]
    norm = [s for s in norm if s]
    if len(norm) != len(set(norm)):
        return False
    wc = len(text.split())
    if wc < _MIN_WORDS or wc > _MAX_WORDS:
        return False
    return True


def _extractive_fallback(title: str, text: str) -> str:
    """Deterministic two-paragraph summary built from source sentences.

    Used when no Groq model is reachable. Picks the first 8 + last 6 substantive
    sentences and splits them into two paragraphs at the midpoint.
    """
    sents = [" ".join(s.split()) for s in _sentences(text) if len(s.split()) >= 6]
    if not sents:
        sents = [" ".join(text.split()[:40])]
    if len(sents) > 14:
        sents = sents[:8] + sents[-6:]
    capped = []
    for s in sents:
        s = s.strip().rstrip(".")
        if not s:
            continue
        capped.append(s[0].upper() + s[1:] + ".")
    if not capped:
        return ""
    mid = max(1, len(capped) // 2)
    return " ".join(capped[:mid]) + "\n\n" + " ".join(capped[mid:])


def _summarize_with_meta(title: str, text: str) -> tuple[str, dict]:
    """Run the single-call ladder. Returns (summary_text, meta).

    meta = {model, input_words, output_words, retries, source}.
    """
    clean = _normalize(text)
    if not clean:
        return "", {"model": "none", "input_words": 0, "output_words": 0,
                    "retries": 0, "source": "empty"}
    body = _maybe_truncate(clean)
    user_msg = (f"Chapter title: {title}\n\nFull chapter text:\n{body}\n\n"
                f"Write the two-paragraph summary now.")
    in_words = len(body.split())

    client = _groq_client()
    model_used = "extractive"
    retries = 0
    out: str | None = None

    if client is not None:
        for model in _GROQ_MODELS:
            raw, err = _call_model(client, model, _SYSTEM_PROMPT, user_msg)
            if not raw:
                # API failure on this model -> try the next model in the ladder.
                print(f"[summary] model {model} call failed: {err}")
                continue
            prose = _clean(raw)
            if _passes_checks(prose):
                out = prose
                model_used = model
                retries = 0
                break
            # Checks failed: retry ONCE with the same model.
            raw2, err2 = _call_model(client, model, _SYSTEM_PROMPT, user_msg)
            retries = 1
            if raw2:
                prose2 = _clean(raw2)
                if _passes_checks(prose2):
                    out = prose2
                    model_used = model
                    break
                # Second failure: return the output anyway rather than erroring.
                out = prose2
                model_used = model
                break
            # Retry call itself failed: keep the first attempt's output.
            out = prose
            model_used = model
            break

    if not out:
        out = _extractive_fallback(title, clean)
        model_used = "extractive"
        retries = 0

    out_words = len(out.split())
    meta = {
        "model": model_used,
        "input_words": in_words,
        "output_words": out_words,
        "retries": retries,
        "source": "fallback" if model_used == "extractive" else "llm",
    }
    print(f"[summary] model={model_used} input_words={in_words} "
          f"output_words={out_words} retries={retries} source={meta['source']}")
    return out, meta


def summarize_chapter(title: str, text: str) -> str:
    """Single-call English chapter summary. Returns the summary text (never None)."""
    out, _meta = _summarize_with_meta(title, text)
    return out


def _r2_key(job_id: str, chapter_index: int) -> str:
    return f"summaries/{job_id}/{chapter_index}.{SUMMARY_CACHE_VERSION}.json.gz"


def _r2_get(job_id: str, chapter_index: int) -> dict | None:
    try:
        import storage_backend  # type: ignore
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
        import storage_backend  # type: ignore
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
    """Cache-aware entry point used by the /api/chapter_summary route.

    Returns a dict with: summary, model, input_words, output_words, retries,
    source, cached, text_sha — or None if no summary could be produced.
    """
    cached = _r2_get(job_id, chapter_index)
    if cached and cached.get("summary"):
        cached["cached"] = True
        return cached
    summary, meta = _summarize_with_meta(chapter_title, chapter_text)
    if not summary:
        return None
    result = {
        "summary": summary,
        "model": meta["model"],
        "input_words": meta["input_words"],
        "output_words": meta["output_words"],
        "retries": meta["retries"],
        "source": meta["source"],
        "text_sha": hashlib.sha256(
            (chapter_text or "").encode("utf-8")).hexdigest()[:16],
    }
    _r2_put(job_id, chapter_index, result)
    result["cached"] = False
    return result
