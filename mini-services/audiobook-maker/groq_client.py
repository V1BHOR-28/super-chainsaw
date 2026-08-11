"""groq_client.py — Single Groq call site with model fallback.

All Hindi AI features (chapter summary, glossary, explain) route through
`groq_chat()` here instead of calling `client.chat.completions.create()`
directly. This centralizes:

1. Model fallback — if Groq decommissions/restricts one model, we walk a
   list of alternatives instead of dying.
2. Rate-limit handling — 429s get exponential backoff (2s, 5s, 10s) before
   falling back to the next model.
3. Consistent error codes — callers get `(text, error_code)` so the API
   endpoints can return structured `{"error": ..., "code": ...}` instead
   of a single opaque Hindi string.

Never raises. Returns `("", "groq_all_models_failed")` on total exhaustion.
"""

import os
import time

# ── Model fallback list ──
# Order: env override (if set) → primary → fast fallback → large fallback.
# De-duped while preserving order so a repeated env value doesn't double-try.
_MODELS_RAW = [
    os.getenv("GROQ_MODEL"),
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
]
GROQ_MODELS = []
for _m in _MODELS_RAW:
    if _m and _m not in GROQ_MODELS:
        GROQ_MODELS.append(_m)

# Backoff schedule for 429s (seconds). 3 attempts on the same model.
_429_BACKOFFS = [2, 5, 10]


def _get_client():
    """Get the OpenAI-compatible Groq client. Returns None if no API key."""
    try:
        import generation_engine as ge
        client = getattr(ge, "_llm_client", None)
        if client is not None:
            return client
    except ImportError:
        pass
    api_key = os.environ.get("ABM_LLM_API_KEY", "")
    api_base = os.environ.get("ABM_LLM_API_BASE", "https://api.groq.com/openai/v1")
    if not api_key:
        return None
    try:
        from openai import OpenAI
        return OpenAI(api_key=api_key, base_url=api_base)
    except Exception:
        return None


def groq_chat(system, user, *, temperature, max_tokens,
              frequency_penalty=0.0, presence_penalty=0.0) -> tuple:
    """Call Groq with model fallback + rate-limit backoff.

    Returns (text, error_code). Never raises.
    - Success: (text, None)
    - No API key: ("", "groq_no_key")
    - All models failed: ("", "groq_all_models_failed")
    - All models rate-limited: ("", "groq_rate_limited")
    - Empty completion: ("", "groq_empty")
    """
    client = _get_client()
    if client is None:
        print("[groq] no API key (ABM_LLM_API_KEY unset)")
        return ("", "groq_no_key")

    models_tried = []
    last_was_rate_limited = False

    for model_id in GROQ_MODELS:
        models_tried.append(model_id)
        # Try the same model up to len(_429_BACKOFFS)+1 times on 429.
        for attempt in range(len(_429_BACKOFFS) + 1):
            try:
                resp = client.chat.completions.create(
                    model=model_id,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=temperature,
                    max_tokens=max_tokens,
                    frequency_penalty=frequency_penalty,
                    presence_penalty=presence_penalty,
                    top_p=0.9,
                )
                text = (resp.choices[0].message.content or "").strip()
                if not text:
                    print(f"[groq] model={model_id} returned empty completion")
                    # Empty completion — try next model, don't retry same.
                    break
                in_tokens = getattr(getattr(getattr(resp, "usage", None), "prompt_tokens", None), "__int__", lambda: "?")() if hasattr(getattr(resp, "usage", None), "prompt_tokens") else "?"
                print(f"[groq] used model={model_id} in_tokens≈{in_tokens}")
                return (text, None)
            except Exception as e:
                msg = str(e).lower()
                # Rate limit / 429
                if "429" in msg or "rate" in msg or "limit" in msg:
                    last_was_rate_limited = True
                    if attempt < len(_429_BACKOFFS):
                        wait = _429_BACKOFFS[attempt]
                        print(f"[groq] model={model_id} rate-limited (429), "
                              f"backing off {wait}s (attempt {attempt+1}/"
                              f"{len(_429_BACKOFFS)+1})")
                        time.sleep(wait)
                        continue
                    else:
                        print(f"[groq] model={model_id} rate-limited after "
                              f"{len(_429_BACKOFFS)+1} attempts → falling back")
                        break
                # Model missing / decommissioned / 404
                elif "404" in msg or "model" in msg and ("not" in msg or "decommission" in msg or "unavailable" in msg):
                    print(f"[groq] model={model_id} unavailable → falling back: {e}")
                    break  # don't retry same model, move to next
                # SDK rejected penalty params (TypeError / 400)
                elif any(k in msg for k in ("frequency_penalty", "presence_penalty",
                                            "top_p", "unexpected keyword", "400", "invalid")):
                    print(f"[groq] model={model_id} rejected params "
                          f"({type(e).__name__}), retrying plain: {e}")
                    try:
                        resp = client.chat.completions.create(
                            model=model_id,
                            messages=[
                                {"role": "system", "content": system},
                                {"role": "user", "content": user},
                            ],
                            temperature=temperature,
                            max_tokens=max_tokens,
                        )
                        text = (resp.choices[0].message.content or "").strip()
                        if text:
                            print(f"[groq] used model={model_id} (plain) in_tokens≈?")
                            return (text, None)
                        else:
                            print(f"[groq] model={model_id} (plain) returned empty")
                            break
                    except Exception as e2:
                        msg2 = str(e2).lower()
                        if "429" in msg2 or "rate" in msg2:
                            last_was_rate_limited = True
                            break  # move to next model
                        print(f"[groq] model={model_id} plain retry failed: {e2}")
                        break  # move to next model
                else:
                    print(f"[groq] model={model_id} error: {e}")
                    break  # move to next model

    # Exhausted all models
    if last_was_rate_limited:
        print(f"[groq] all models rate-limited (tried: {models_tried})")
        return ("", "groq_rate_limited")
    print(f"[groq] all models failed (tried: {models_tried})")
    return ("", "groq_all_models_failed")


def groq_health():
    """Quick health check — one tiny 5-token completion.

    Returns dict with: groq_key_present, models_tried, working_model, error.
    Used by GET /api/ai/health.
    """
    key_present = bool(os.environ.get("ABM_LLM_API_KEY", ""))
    if not key_present:
        return {
            "groq_key_present": False,
            "models_tried": [],
            "working_model": None,
            "error": "groq_no_key",
        }
    models_tried = []
    for model_id in GROQ_MODELS:
        models_tried.append(model_id)
        text, code = groq_chat(
            "You are a health check. Reply with OK.",
            "ping",
            temperature=0.0,
            max_tokens=5,
        )
        if text and not code:
            return {
                "groq_key_present": True,
                "models_tried": models_tried,
                "working_model": model_id,
                "error": None,
            }
    return {
        "groq_key_present": True,
        "models_tried": models_tried,
        "working_model": None,
        "error": code or "groq_all_models_failed",
    }
