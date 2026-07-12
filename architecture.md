# ARIA — Architecture Document

## App Overview

ARIA is a Next.js 16 full-stack application deployed on Vercel. The frontend is a single-page app with a sidebar + chat area layout. The backend consists of API routes (serverless functions) that handle auth, chat, knowledge management, and memory.

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | Latest React 19, server components, API routes |
| Language | TypeScript 5 | Type safety throughout |
| Styling | Tailwind CSS 4 + CSS variables | Utility-first + custom ARIA design system |
| UI Components | shadcn/ui (New York style) | Accessible, customizable, Lucide icons |
| Database | Prisma ORM + Neon Postgres | Serverless Postgres with pgvector |
| Auth | NextAuth.js v4 (JWT strategy) | Google OAuth + email/password |
| State | Zustand (client) | Lightweight, no boilerplate |
| Server State | TanStack Query (available) | For server data caching |
| Email | Resend | Verification codes |
| LLM | OpenRouter + Groq + Gemini + Pollinations | 5-provider parallel fallback |
| Embeddings | Gemini gemini-embedding-001 (768-dim) | Free, works from Vercel |
| PDF Parsing | pdfjs-dist (client) + unpdf (server fallback) | Client-side = no timeout |
| Text Extraction | cheerio | URL content extraction |
| Animations | Framer Motion | Modal transitions, message entrance |

## Architecture Flow

```
User Browser
    │
    ├── Landing Page (iframe: /public/aria-landing.html)
    │       └── postMessage bridge → Auth Modal
    │
    ├── Auth (NextAuth JWT)
    │       ├── Google OAuth
    │       └── Email + Password (bcrypt + Resend verification)
    │
    ├── Chat Interface
    │       ├── Sidebar (conversations, memories, moods, reminders)
    │       ├── Chat Area (messages, input, tools)
    │       └── Settings Modal
    │
    └── API Routes (Vercel Serverless)
            ├── /api/chat (SSE streaming)
            │       ├── Knowledge search (pgvector semantic + keyword fallback)
            │       ├── Web search (Tavily + Serper + ESPN)
            │       ├── LLM call (stream: true → fallback to parallel Promise.any)
            │       │   ├── OpenRouter (Llama 3.3 70B / GPT-OSS 120B)
            │       │   ├── Groq (Llama 3.1 8B)
            │       │   ├── Gemini (2.0 Flash)
            │       │   └── Pollinations (keyless)
            │       ├── Reading journal (auto-save after book discussions)
            │       └── Memory detection (auto-extract facts)
            │
            ├── /api/knowledge (CRUD)
            │       ├── Upload (text/URL/PDF → chunk → embed → store)
            │       ├── Batch (client-side PDF pipeline)
            │       ├── Auto-summary generation (Pollinations)
            │       └── Library listing (grouped by book title)
            │
            ├── /api/tts (ElevenLabs — for future voice mode)
            ├── /api/search (Tavily + Serper web search)
            ├── /api/memory (CRUD + semantic search)
            ├── /api/conversations (CRUD + export)
            ├── /api/auth/* (NextAuth)
            ├── /api/settings (GET + PATCH)
            ├── /api/usage (daily token meter)
            ├── /api/migrate (one-time DB migration)
            └── /api/diag (environment diagnostics)
```

## LLM Call Flow (Detailed)

```
User sends message
    │
    ├── 1. Knowledge search (if user has fed books)
    │       ├── Generate query embedding (Gemini 768-dim)
    │       ├── In-book search? → filter by book title
    │       ├── Comparison? → group by book, top 2 each
    │       └── Fallback: keyword ILIKE search
    │
    ├── 2. Knowledge priority check
    │       └── If knowledge found → skip web search
    │
    ├── 3. Web search (if enabled by user)
    │       ├── Query reformulation (matchup detection)
    │       ├── Tavily (topic:news, days:14)
    │       ├── Serper fallback (tbs:qdr:w)
    │       └── ESPN (3-day range, multi-league)
    │
    ├── 4. Smart model routing
    │       ├── Deep thinking keywords? → 70B model
    │       └── Casual chat? → 8B model (selectedModel)
    │
    ├── 5. Real streaming (try first)
    │       ├── OpenRouter stream:true
    │       ├── Parse SSE delta tokens → forward to client
    │       └── If fails → fall to step 6
    │
    ├── 6. Parallel fallback (if streaming fails)
    │       ├── Promise.any([
    │       │   OpenRouter(effectiveSelectedModel),
    │       │   OpenRouter(freeFallback),
    │       │   Pollinations,
    │       │   Groq (if key),
    │       │   Gemini (if key)
    │       │ ])
    │       └── First success wins → fake typewriter to client
    │
    ├── 7. Post-response
    │       ├── Save to DB
    │       ├── Record usage
    │       ├── Auto-title conversation (first exchange)
    │       ├── Reading journal (if book discussion)
    │       └── Memory detection (async)
    │
    └── Client receives SSE stream
            ├── type: 'sources' (web search results)
            ├── type: 'token' (streamed text)
            ├── type: 'done' (message saved)
            └── type: 'error' / 'limit'
```

## PDF Upload Flow (Client-Side Pipeline)

```
User selects PDF (up to 70MB)
    │
    ├── Browser parses PDF (pdfjs-dist)
    │       ├── Page-by-page text extraction
    │       ├── Progress callback (page X of Y)
    │       └── No server timeout (runs in browser)
    │
    ├── Chunk text (~3000 chars, paragraph boundaries)
    │
    ├── Send batches of 10 to /api/knowledge/batch
    │       ├── Generate embeddings (Gemini, parallel)
    │       ├── Store as "[Book Title] — Part N/M"
    │       └── Index in pgvector
    │
    └── Auto-generate summary (Pollinations, free)
            └── Store as source='summary' (hidden from library)
```

## Folder Structure

```
src/
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── [...nextauth]/route.ts      # NextAuth config
│   │   │   ├── signup/route.ts             # Email signup + verification
│   │   │   ├── verify/route.ts             # 6-digit code verification
│   │   │   ├── onboard/route.ts            # Post-signup onboarding
│   │   │   ├── resend/route.ts             # Resend verification code
│   │   │   ├── check-status/route.ts       # Auth status check
│   │   │   └── session/route.ts            # Session info
│   │   ├── chat/route.ts                   # Main chat endpoint (SSE streaming)
│   │   ├── knowledge/
│   │   │   ├── route.ts                    # GET (list) + POST (upload text/URL)
│   │   │   ├── [id]/route.ts               # DELETE (by ID or book title)
│   │   │   └── batch/route.ts              # POST (batch chunk storage)
│   │   ├── conversations/
│   │   │   ├── route.ts                    # GET (list) + POST (create)
│   │   │   ├── [id]/route.ts               # GET (messages) + DELETE
│   │   │   ├── [id]/export/route.ts        # GET (Markdown/JSON export)
│   │   │   └── search/route.ts             # GET (search conversations)
│   │   ├── memory/
│   │   │   ├── route.ts                    # GET + POST + semantic search
│   │   │   ├── [id]/route.ts               # DELETE
│   │   │   ├── detect/route.ts             # POST (auto-extract memories)
│   │   │   └── decision/route.ts           # POST (save/skip decisions)
│   │   ├── mood/
│   │   │   ├── route.ts                    # GET + POST
│   │   │   └── [id]/route.ts               # DELETE
│   │   ├── reminders/
│   │   │   ├── route.ts                    # GET + POST
│   │   │   └── [id]/route.ts               # DELETE
│   │   ├── search/route.ts                 # Web search (Tavily + Serper)
│   │   ├── settings/route.ts               # GET + PATCH
│   │   ├── usage/route.ts                  # GET (daily token meter)
│   │   ├── tts/route.ts                    # POST (ElevenLabs TTS — future)
│   │   ├── image-gen/route.ts              # POST (Pollinations — removed)
│   │   ├── diag/route.ts                   # GET (env diagnostics)
│   │   ├── embed-test/route.ts             # GET (embedding API test)
│   │   └── migrate/route.ts                # GET (one-time DB migration)
│   ├── globals.css                         # ARIA design system + animations
│   ├── layout.tsx                          # Root layout (fonts, providers)
│   └── page.tsx                            # Main app entry (auth gate)
│
├── components/
│   ├── aria/
│   │   ├── chat-area.tsx                   # Main chat interface
│   │   ├── message-bubble.tsx              # Single message rendering
│   │   ├── sidebar.tsx                     # Conversations + nav
│   │   ├── side-panels.tsx                 # Memory/mood/reminders panels
│   │   ├── settings-modal.tsx              # Settings (tabs: general/account)
│   │   ├── feed-aria-modal.tsx             # Upload books (text/URL/PDF)
│   │   ├── auth-modal.tsx                  # Sign in / sign up
│   │   ├── onboarding-screen.tsx           # First-time user setup
│   │   ├── landing-page.tsx                # iframe wrapper for landing HTML
│   │   ├── markdown.tsx                    # Markdown renderer
│   │   ├── memory-ask-card.tsx             # Memory candidate prompt
│   │   ├── usage-meter.tsx                 # Daily token meter pill
│   │   └── voice-window.tsx                # Voice mode (STT+TTS — disabled)
│   ├── ui/                                 # shadcn/ui components (30+ files)
│   └── providers.tsx                       # NextAuth + Sonner providers
│
├── hooks/
│   ├── use-aria-chat.ts                    # Chat hook (sendMessage + SSE parsing)
│   └── use-mobile.ts                       # Mobile detection
│
├── lib/
│   ├── aria.ts                             # System prompt builder
│   ├── auth.ts                             # NextAuth options
│   ├── db.ts                               # Prisma client singleton
│   ├── embeddings.ts                       # Gemini embeddings + model list
│   ├── chunk-text.ts                       # Shared chunking logic
│   ├── client-pdf.ts                       # Browser PDF parser (pdfjs-dist)
│   ├── store.ts                            # Zustand store
│   ├── types.ts                            # TypeScript types
│   ├── usage.ts                            # Daily token limits + admin bypass
│   ├── user.ts                             # Auth helpers
│   ├── utils.ts                            # cn() utility
│   └── email.ts                            # Resend email service
│
├── prisma/
│   └── schema.prisma                       # Database schema (10 models)
│
└── public/
    ├── aria-landing.html                   # 1439-line landing page
    ├── logo.svg
    └── robots.txt
```

## Database Schema (Prisma)

```
User          → settings, conversations, memories, knowledge, moods, reminders, usage
Conversation  → messages
Message       → (role, content, toolUsed, attachmentsJson)
Knowledge     → (title, content, source, embedding[768])
Memory        → (content, category, pinned, embedding[768])
MemoryDecision → (candidateText, category, accepted)
Mood          → (mood, note)
Reminder      → (content, dueAt, completed)
UserSettings  → (tone, responseLength, modelPreference, voiceEnabled, ...)
Usage         → (tokensUsed, requestCount, date)
```

## Environment Variables

```
DATABASE_URL          — Neon Postgres connection string
OPENROUTER_API_KEY    — OpenRouter API key (free models)
GROQ_API_KEY          — Groq API key (free, 30K TPM)
GEMINI_API_KEY        — Google Gemini API key (free, chat + embeddings)
TAVILY_API_KEY        — Tavily search API key
SERPER_API_KEY        — Serper (Google) search API key
ELEVENLABS_API_KEY    — ElevenLabs TTS (for future voice mode)
NEXTAUTH_SECRET       — NextAuth JWT secret
GOOGLE_CLIENT_ID      — Google OAuth (optional)
GOOGLE_CLIENT_SECRET  — Google OAuth (optional)
RESEND_API_KEY        — Resend email service
ADMIN_EMAILS          — Comma-separated admin emails (optional)
```

## Deployment

- **Platform**: Vercel (Hobby plan)
- **Build**: `prisma generate && next build`
- **Runtime**: Node.js (Turbopack)
- **Max Duration**: 60s for /api/chat, 30s for others
- **Auto-deploy**: GitHub push → Vercel build → live
- **Custom domain**: ariav2-seven.vercel.app
