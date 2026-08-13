---
title: ARIA Audiobook Maker
emoji: 📚
colorFrom: indigo
colorTo: amber
sdk: docker
app_port: 7860
pinned: false
license: other
---

# ARIA Audiobook Maker — Flask backend

This Hugging Face Space runs the audiobook generation service for [ARIA](https://github.com/V1BHOR-28/super-chainsaw).

## What it does

- Accepts EPUB / PDF / TXT uploads from the ARIA Next.js frontend
- Synthesizes audio with Edge-TTS (free) or Gemini TTS (premium)
- Generates word-by-word transcripts with timing cues
- Picks adaptive background music moods from a deterministic scorer
- Uploads finished chapter MP3s + BGM cues to Cloudflare R2

## Configuration

All configuration is via Space secrets (Settings → "Variables and secrets"). The following are **required** for the service to start usefully:

| Secret | Purpose |
|---|---|
| `ABM_S3_ENDPOINT` | Cloudflare R2 endpoint URL |
| `ABM_S3_ACCESS_KEY` | R2 access key |
| `ABM_S3_SECRET_KEY` | R2 secret key |
| `ABM_S3_BUCKET` | R2 bucket name |
| `ABM_LLM_API_KEY` | Groq API key (for LLM text optimization) |
| `ABM_GEMINI_API_KEY` | Gemini API key (for premium TTS voices) |

Optional:
| Secret | Purpose |
|---|---|
| `ABM_ALLOWED_ORIGINS` | Comma-separated CORS origins (your Vercel domain) |
| `ABM_JOB_RETENTION_SEC` | Job retention window (default 604800 = 7 days) |

## Persistent storage

HF Spaces provides 10GB of persistent storage at `/data` (free). This Space writes generated audio + job state to `/data/abm-data` so it survives restarts.

R2 is still the primary persistence layer — `/data` is the working/scratch area.

## Architecture

This Space is the **audiobook backend only**. The chat + auth + library UI lives on Vercel as a Next.js app that proxies `/api/abm/*` calls to this Space's URL.

```
Browser → Vercel (Next.js) → /api/abm/* proxy → this HF Space (Flask)
                                                       ↓
                                              Cloudflare R2 (audio files)
```

See the main repo README for the full architecture diagram.
