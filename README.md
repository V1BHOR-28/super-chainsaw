# ARIA

**Autonomous Reasoning Intelligent Assistant** — an AI partner that helps, reads, and thinks alongside you. ARIA blends three capabilities in one conversation: a thinking partner, a book reader with a library you feed it, and a web searcher for live facts. It also narrates any EPUB into a synchronized audiobook with word-by-word transcripts and adaptive background music.

> **Stable release:** v2.0-backup (commit `425b781`)
> **Live app:** [ariaggn.vercel.app](https://ariaggn.vercel.app)

---

## Table of Contents

1. [What ARIA does](#what-aria-does)
2. [Features](#features)
3. [Tech stack](#tech-stack)
4. [Architecture](#architecture)
5. [Project structure](#project-structure)
6. [Getting started (local dev)](#getting-started-local-dev)
7. [Environment variables](#environment-variables)
8. [Database](#database)
9. [The audiobook pipeline](#the-audiobook-pipeline)
10. [The BGM system](#the-bgm-system)
11. [Memory & knowledge](#memory--knowledge)
12. [Authentication](#authentication)
13. [Deployment](#deployment)
14. [Scripts](#scripts)
15. [License](#license)

---

## What ARIA does

ARIA is one app with two workspaces:

### 1. Chat — your thinking partner

- **Three blended modes**, no visible switching:
  - **Helper** — conversation, advice, brainstorming, opinions. ARIA has takes and pushes back.
  - **Book Reader** — feed it books and papers. It interprets (not summarizes), forms opinions, connects ideas across books, and recommends what to read next based on what you've engaged with.
  - **Web Searcher** — when a question needs live data (scores, news, current events), ARIA searches the web and cites sources inline.
- **Persistent memory** — ARIA remembers facts about you across conversations. You can pin, edit, or delete any memory.
- **Knowledge base** — paste URLs or text, ARIA chunks + embeds them and uses semantic search to answer from your library.
- **Rolling conversation summaries** — long conversations stay coherent without re-sending every message.
- **Daily digest** — a short check-in built from your mood, upcoming reminders, and last conversation.
- **Mood tracking + reminders + quotes** — a light journaling layer.

### 2. Audiobooks — narrate any EPUB

- **Upload an EPUB** → ARIA extracts chapters, narrates them with 10 curated Edge-TTS voices, and serves a per-chapter playlist player.
- **Word-by-word synced transcript** — Spotify-style karaoke highlighting that follows the audio in real time.
- **Adaptive background music (BGM)** — 8 mood loops that duck under narration, with a deterministic heuristic scorer that picks moods from the text.
- **Cover art** — extracted from the EPUB, persisted to R2, cached client-side in IndexedDB.
- **Resume where you left off** — playback position is saved per book.
- **Per-chapter selection** — pick which chapters to narrate; "More chapters" works after the first batch.

---

## Features

### Chat
- Streaming responses (SSE)
- Multi-provider LLM fallback (Groq → Pollinations keyless backstop)
- Gemini for structured JSON tasks (memory detection, extraction)
- Web search via Tavily → Serper cascade with sports matchup reformulation
- Semantic conversation search (pgvector embeddings)
- Memory system with auto-detection + manual pinning
- Knowledge base with URL fetching + text chunking
- Mood logging, reminders, quotes
- Reading streaks + daily digest
- Account export (JSON + Markdown)

### Audiobooks
- EPUB / PDF / TXT / ABM upload
- 10 curated Edge-TTS narration voices (8 female, 2 male)
- Per-chapter MP3 generation (playlist player with gapless transitions)
- Word-level transcript sync (WordBoundary event capture)
- 8-mood BGM system with Web Audio API gain staging
- Cover art extraction + R2 persistence + IndexedDB cache
- Selective chapter conversion ("More chapters" without resetting)
- Resume-where-you-left-off
- Stale-job watchdog + crash-visible errors + retry button
- Download as M4B / MP3 / ZIP

---

## Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS 4 |
| **UI components** | shadcn/ui (New York style) + Lucide icons + Framer Motion |
| **State** | Zustand (client) + React hooks (server state via fetch) |
| **Auth** | NextAuth.js v4 (Google OAuth + email/password credentials) |
| **Database** | PostgreSQL (Neon) + Prisma ORM + pgvector for semantic search |
| **Email** | Resend + Nodemailer (SMTP fallback) |
| **LLM** | Groq (llama-3.3-70b + llama-3.1-8b) + Gemini 2.0 Flash + Pollinations |
| **Embeddings** | Gemini text-embedding-001 (768-dim) |
| **Web search** | Tavily + Serper |
| **Audiobook backend** | Python Flask (mini-service) + Edge-TTS + ffmpeg |
| **Object storage** | Cloudflare R2 (S3-compatible) via boto3 |
| **Deployment** | Vercel (frontend) + Hugging Face Spaces (audiobook backend) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (client)                      │
│  Next.js 16 app — Chat + Audiobooks workspaces           │
│  Zustand state · IndexedDB caches · Web Audio API BGM    │
└────────────┬────────────────────────────┬───────────────┘
             │                            │
             │ /api/* (Next.js routes)    │ /api/abm/* (proxy)
             ▼                            ▼
┌────────────────────────┐   ┌────────────────────────────┐
│   Vercel (Node.js)     │   │  Audiobook Maker (Flask)    │
│  - Auth (NextAuth)     │   │  - EPUB parsing (ebooklib)  │
│  - Chat (streaming)    │   │  - Edge-TTS synthesis       │
│  - Memory + Knowledge  │   │  - ffmpeg post-processing   │
│  - Web search          │   │  - BGM cue generation       │
│  - Cron (digest)       │   │  - R2 upload/download       │
└──────────┬─────────────┘   └──────────┬─────────────────┘
           │                            │
           ▼                            ▼
┌────────────────────────┐   ┌────────────────────────────┐
│  Neon Postgres +       │   │  Cloudflare R2              │
│  pgvector              │   │  (chapter MP3s, covers,     │
│  (users, conversations,│   │   BGM assets, tokens)       │
│   memories, knowledge, │   │                              │
│   audiobooks, moods)   │   │                              │
└────────────────────────┘   └────────────────────────────┘
```

**The frontend** is a single Next.js app with two workspaces (Chat, Audiobooks) toggled in the sidebar. All audiobook API calls go through a catch-all proxy at `/api/abm/[...path]` that forwards to the Flask backend — so the browser only ever talks to Vercel (no CORS, no absolute URLs).

**The audiobook backend** is a Python Flask monolith (`mini-services/audiobook-maker/`) that runs on Hugging Face Spaces (Docker SDK). It parses EPUBs, synthesizes audio via Edge-TTS, mixes BGM, and uploads everything to R2. The frontend never touches R2 directly — it streams chapter MP3s through the Flask backend, which 302-redirects to presigned R2 URLs.

> **Why HF Spaces instead of Render?** Render's free tier sleeps after 15 minutes of inactivity, causing 30-50s cold starts. HF Spaces doesn't sleep, gives 16GB RAM (vs Render's 512MB), 10GB persistent storage, and still doesn't require a credit card. See `mini-services/audiobook-maker/DEPLOY_HF.md` for the migration guide.

**The database** is a single Postgres instance with pgvector for semantic search. Embeddings are 768-dimensional (Gemini text-embedding-001), stored on Message rows (for conversation search) and Memory/Knowledge rows (for retrieval).

---

## Project structure

```
.
├── src/
│   ├── app/
│   │   ├── api/                    # Next.js API routes
│   │   │   ├── abm/[...path]/      # Proxy to Flask audiobook backend
│   │   │   ├── chat/               # Streaming chat (SSE)
│   │   │   ├── memory/             # CRUD + auto-detect
│   │   │   ├── knowledge/          # URL/text ingestion
│   │   │   ├── auth/               # NextAuth + signup + onboarding
│   │   │   ├── search/             # Semantic conversation search
│   │   │   ├── cron/               # Daily digest + auto-destruct
│   │   │   └── ...                 # Mood, reminders, quotes, usage, export
│   │   ├── layout.tsx              # Root layout (fonts, providers, toaster)
│   │   └── page.tsx                # Main app shell (auth gate + workspaces)
│   ├── components/
│   │   ├── aria/                   # All ARIA-specific components
│   │   │   ├── chat-area.tsx       # Chat workspace
│   │   │   ├── library-view.tsx    # Audiobook library + upload
│   │   │   ├── player-view.tsx     # Audiobook player + transcript + BGM
│   │   │   ├── transcript-view.tsx # Word-synced karaoke transcript
│   │   │   ├── chapter-selector.tsx# Pick which chapters to narrate
│   │   │   ├── sidebar.tsx         # Conversation list + workspace switch
│   │   │   ├── landing-page.tsx    # Marketing landing
│   │   │   ├── onboarding-screen.tsx
│   │   │   └── ...
│   │   ├── ui/                     # shadcn/ui primitives
│   │   └── providers.tsx           # Theme + NextAuth providers
│   ├── hooks/                      # use-audio-engine, use-word-sync, use-toast, ...
│   └── lib/                        # Business logic
│       ├── aria.ts                 # System prompt builder
│       ├── abm-api.ts              # Typed Flask API client
│       ├── player-store.ts         # Zustand player state
│       ├── store.ts                # Zustand app state
│       ├── auth.ts                 # NextAuth config
│       ├── db.ts                   # Prisma client
│       ├── embeddings.ts           # Gemini embedding calls
│       ├── llm-fallback.ts         # Groq + Pollinations fallback
│       ├── web-search.ts           # Tavily + Serper cascade
│       ├── cover-cache.ts          # IndexedDB cover cache
│       └── ...
├── prisma/
│   └── schema.prisma               # User, Conversation, Message, Memory,
│                                   # Knowledge, Audiobook, AudiobookJob, ...
├── mini-services/
│   └── audiobook-maker/            # Flask backend (Python)
│       ├── audiobook_app.py        # Main Flask app (~17K lines)
│       ├── generation_engine.py    # TTS orchestration
│       ├── tts_split.py            # Edge-TTS chunk synthesis
│       ├── epub_to_tts.py          # EPUB parsing (ebooklib)
│       ├── bgm_cues.py             # BGM mood scorer
│       ├── bgm_mix.py              # BGM audio mixing
│       ├── bgm_registry.py         # BGM asset registry (8 moods)
│       ├── storage_backend.py      # R2/S3 client
│       ├── storage_tiering.py      # Hot/cold tier management
│       └── requirements.txt
├── public/                         # Static assets (logos, OG images)
├── package.json
├── .env.example
└── README.md
```

---

## Getting started (local dev)

### Prerequisites

- Node.js 18+ and [Bun](https://bun.sh) (package manager + runtime)
- A PostgreSQL database with pgvector (we use [Neon](https://neon.tech) — free tier works)
- A Google OAuth client (for Google sign-in)
- API keys: Groq, Gemini, Resend, Tavily/Serper (see [env vars](#environment-variables))
- For the audiobook backend: Python 3.11+ (runs as a mini-service in dev)

### 1. Install dependencies

```bash
bun install
```

### 2. Set up the database

Create a PostgreSQL database with pgvector enabled. With Neon:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Put the connection string in `.env` as `DATABASE_URL`.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values (see [Environment variables](#environment-variables)).

### 4. Push the schema

```bash
bun run db:push
```

### 5. Start the dev server

```bash
bun run dev
```

The app runs on `http://localhost:3000`.

### 6. (Optional) Start the audiobook backend

The audiobook backend is a Flask app in `mini-services/audiobook-maker/`. In dev it runs on port 5601. The Next.js proxy at `/api/abm/[...path]` forwards to it automatically.

```bash
cd mini-services/audiobook-maker
pip install -r requirements.txt
python audiobook_app.py   # starts on port 5601
```

---

## Environment variables

Copy `.env.example` to `.env` and fill these in. All are required for production unless marked optional.

### Database

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string with `?sslmode=require` |

### Auth

| Variable | Description |
|---|---|
| `NEXTAUTH_SECRET` | Random secret (generate with `openssl rand -hex 32`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

### Email

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Resend API key (transactional email) |
| `EMAIL_FROM` | From address (e.g. `onboarding@resend.dev`) |

### LLM providers

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (primary chat LLM) |
| `GEMINI_API_KEY` | Google Gemini API key (embeddings + LLM fallback + JSON extraction) |
| `GROQ_API_KEY` | Groq API key (fast fallback LLM) |

### Web search

| Variable | Description |
|---|---|
| `TAVILY_API_KEY` | Tavily search API key |
| `SERPER_API_KEY` | Serper search API key (fallback) |

### Audiobook backend

| Variable | Description |
|---|---|
| `ABM_SERVICE_URL` | Flask backend URL (e.g. `https://your-app.onrender.com`) |
| `NEXT_PUBLIC_ABM_DIRECT_URL` | Same as `ABM_SERVICE_URL` (client-side, for large uploads) |
| `ABM_ALLOWED_ORIGINS` | Comma-separated CORS origins (your Vercel domain + localhost) |

### Optional

| Variable | Description |
|---|---|
| `ADMIN_EMAILS` | Comma-separated emails that bypass daily limits |
| `CRON_SECRET` | Secret authorizing Vercel Cron to hit `/api/cron/*` |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS (future voice mode) |

---

## Database

ARIA uses Prisma + PostgreSQL with pgvector for semantic search.

### Schema highlights

- **User** — email/password or Google OAuth, onboarding fields (persona, age, occupation), tier
- **Conversation** → **Message** — messages have 768-dim embeddings for semantic search
- **Memory** — persistent facts about the user (auto-detected or manual), with embeddings
- **Knowledge** — user-fed documents (URL/text), chunked + embedded for RAG
- **MemoryDecision** — logs every Save/Skip so ARIA learns the user's pattern
- **Audiobook** / **AudiobookJob** — tracks EPUB conversion jobs
- **Mood** / **Reminder** / **Quote** — journaling layer
- **DailyDigest** — one per user per day, generated by Vercel Cron
- **Usage** — per-user per-day token + request counts
- **UserSettings** — tone, response length, model preference, streaks

### Commands

```bash
bun run db:push      # Push schema to database (non-destructive)
bun run db:generate  # Regenerate Prisma client
bun run db:migrate   # Create + apply a migration (dev)
bun run db:reset     # Reset database (destructive!)
```

---

## The audiobook pipeline

### How an EPUB becomes an audiobook

1. **Upload** — the browser POSTs the EPUB to `/api/abm/analyze` (proxied to Flask).
2. **Parse** — `epub_to_tts.py` uses `ebooklib` + `beautifulsoup4` to extract chapters, titles, and word counts.
3. **Cover extraction** — the EPUB's cover image is extracted and uploaded to R2 at `covers/{job_id}/cover.jpg`.
4. **Chapter selection** — the user picks which chapters to narrate in the chapter selector UI.
5. **Generate** — `/api/abm/generate` spawns a background thread. For each chapter:
   - The text is split into ~800-word chunks at sentence boundaries.
   - Each chunk is synthesized via Edge-TTS (`edge_tts.Communicate`) with the selected voice + rate.
   - Word-boundary events are captured for transcript sync (start/end timestamps per word).
   - Chunks are concatenated into a per-chapter MP3 via ffmpeg.
   - The MP3 is uploaded to R2 at `chapters/{job_id}/{filename}`.
   - BGM cues are generated (see [BGM system](#the-bgm-system)).
6. **Playback** — the frontend's `useAudioEngine` plays the per-chapter MP3s as a playlist. The transcript view reads word-boundary cues to drive karaoke highlighting. The BGM engine reads cues to mix mood loops via Web Audio API.

### Voices

10 curated Edge-TTS voices (8 female, 2 male), all free:

| Voice | Gender | Style |
|---|---|---|
| `en-US-AriaNeural` | Female | Warm, natural (default) |
| `en-US-JennyNeural` | Female | Friendly, conversational |
| `en-US-AmberNeural` | Female | Soft, expressive |
| `en-US-EmmaNeural` | Female | Calm, measured |
| `en-US-MichelleNeural` | Female | Professional |
| `en-US-SaraNeural` | Female | Bright, young |
| `en-US-NancyNeural` | Female | Mature, steady |
| `en-US-AvaNeural` | Female | Contemporary |
| `en-US-GuyNeural` | Male | Warm, natural |
| `en-US-DavisNeural` | Male | Calm, deep |

### Transcript sync

Edge-TTS emits `WordBoundary` events during synthesis — each event has a start time, duration, and the word being spoken. `tts_split.py` captures these and stores them as `[[startMs, endMs, word], ...]` per chapter. The frontend's `useWordSync` hook runs a `requestAnimationFrame` loop reading `audio.currentTime` and highlights the current word in the transcript view.

### Storage

All generated artifacts go to R2 immediately after generation:

| Artifact | R2 key |
|---|---|
| Chapter MP3 | `chapters/{job_id}/{filename}` |
| Cover image | `covers/{job_id}/cover{ext}` |
| BGM cues | `bgm/{job_id}/{chapter}.bgm.json.gz` |
| Download tokens | `_download_tokens.json` |

The local disk is scratch only — generated content survives backend restarts.

---

## The BGM system

ARIA's background music is an 8-mood system that adapts to the narration:

### Moods

| Mood | Used for |
|---|---|
| `calm_amb` | Default, peaceful passages |
| `tense_amb` | Suspense, conflict |
| `melancholy_amb` | Sadness, loss |
| `mysterious_amb` | Mystery, intrigue |
| `hopeful_amb` | Hope, resolution |
| `romantic_amb` | Love, tenderness |
| `epic_amb` | Grand, heroic moments |
| `dark_amb` | Darkness, danger |

### How it works

1. **Scoring** — `bgm_cues.py` runs a deterministic heuristic scorer over each chapter's text. It picks moods based on keyword density (e.g. "sword", "battle" → `epic_amb`; "tears", "loss" → `melancholy_amb`). No LLM call — fast and reproducible.
2. **Cues** — the scorer produces time cues: when each mood starts/stops and at what gain (dB). Cues are cached to R2 at `bgm/{job_id}/{chapter}.bgm.json.gz`.
3. **Mixing** — the frontend's `useBgmEngine` hook creates one hidden `<audio loop>` element per mood, all routed through Web Audio API `GainNode`s. A rAF sync loop reads the cues and crossfades moods in/out, ducking under narration via a sidechain gain reduction.
4. **Assets** — 8 seamlessly-looping BGM assets, mastered at -20 LUFS, 4+ layers per mood. Stored in `bgm_registry.py`'s asset directory.

### Per-book BGM mode

Each job has a `bgm_mode`:
- `"off"` — no BGM
- `"runtime"` — cues generated, mixed in the browser during playback (default)
- `"prerender"` — BGM baked into the chapter audio at generation time

Existing jobs get backfilled: if `bgm_mode` is missing but transcript cues exist, the cues are generated on demand on first playback.

---

## Memory & knowledge

### Memory

ARIA remembers facts about you across conversations. There are two sources:

1. **Auto-detected** — after each assistant turn, `/api/memory/detect` runs (Groq llama-3.3-70b for precision, Gemini 2.0 Flash for JSON extraction). It identifies candidate facts ("the user mentioned they're a software engineer in Berlin") and asks you to Save/Skip. Each decision is logged in `MemoryDecision` so ARIA learns your patterns.
2. **Manual** — you can add memories directly in the Memory panel.

Memories are embedded (768-dim Gemini) and retrieved via pgvector cosine similarity. The top relevant memories are injected into the system prompt for each chat turn.

### Knowledge base

Feed ARIA articles, papers, player lists, schedules:

- **URL** — fetched server-side, parsed, chunked
- **Text** — pasted directly
- **File** — uploaded

Each document is chunked (~800 words at sentence boundaries), embedded, and stored as `Knowledge` rows with a `documentId` grouping the chunks. At chat time, ARIA extracts keywords from your message, does semantic + keyword search over your knowledge base, and injects the most relevant chunks into the system prompt as `LIBRARY` context.

---

## Authentication

ARIA uses NextAuth.js v4 with two providers:

1. **Google OAuth** — one-click sign-in. Users still go through onboarding (persona, age, occupation) after first login.
2. **Credentials** — email + password. Passwords are hashed with bcrypt. Email verification is required (6-digit code, valid 15 min).

**Session strategy**: JWT (stateless, works on Vercel serverless). The session callback enriches the token with the user's database ID so API routes can scope data by `userId`.

**Onboarding flow**:
1. Sign up (email/password) or sign in (Google)
2. Verify email (credentials only — Google users are pre-verified)
3. Onboarding screen: pick persona, age, occupation
4. Land in the app

---

## Deployment

### Frontend → Vercel

1. Push to GitHub (the `main` branch auto-deploys)
2. In Vercel project settings, add all [environment variables](#environment-variables)
3. The build command (`prisma generate && next build`) compiles the app — Prisma schema sync happens via `prisma migrate deploy` at container start when running in Docker, or via Vercel's build-time `prisma generate` for the serverless deployment
4. The app runs on Vercel's Node.js runtime

### Audiobook backend → Hugging Face Spaces

The Flask backend in `mini-services/audiobook-maker/` deploys to **Hugging Face Spaces** using the Docker SDK. This replaces the previous Render deployment (Render's free tier sleeps after 15 min of inactivity — HF Spaces doesn't).

Full step-by-step guide: **[`mini-services/audiobook-maker/DEPLOY_HF.md`](mini-services/audiobook-maker/DEPLOY_HF.md)**

TL;DR:
1. Create a new Space at https://huggingface.co/new-space — pick **Docker** SDK, **Private** visibility
2. Connect it to your GitHub repo, set root dir to `mini-services/audiobook-maker`
3. Add secrets (`ABM_S3_*`, `ABM_LLM_API_KEY`, `ABM_GEMINI_API_KEY`, `ABM_ALLOWED_ORIGINS`) in Space Settings
4. Set `ABM_SERVICE_URL` on Vercel to your Space's URL (e.g. `https://YOUR_USERNAME-aria-abm.hf.space`)

### Storage → Cloudflare R2

1. Create an R2 bucket
2. Create an API token with Object Read & Write permissions
3. Set `ABM_S3_ENDPOINT`, `ABM_S3_ACCESS_KEY`, `ABM_S3_SECRET_KEY`, `ABM_S3_BUCKET` as secrets on the HF Space

### Database → Neon

1. Create a Neon project (free tier works)
2. Enable pgvector: `CREATE EXTENSION IF NOT EXISTS vector;`
3. Set `DATABASE_URL` on Vercel

---

## Scripts

```bash
bun run dev          # Start dev server (port 3000)
bun run build        # Production build (prisma generate + db push + next build)
bun run start        # Start production server
bun run lint         # ESLint
bun run db:push      # Push schema to database
bun run db:generate  # Regenerate Prisma client
bun run db:migrate   # Create + apply a migration (dev)
bun run db:reset     # Reset database (destructive!)
bun run verify:memory    # Run memory system verification script
bun run db:indexes   # Add vector indexes to pgvector columns
bun run backfill:memory # Backfill embeddings for existing memories
```

---

## License

Private project. All rights reserved.
