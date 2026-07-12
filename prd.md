# ARIA — Product Requirements Document (PRD)

## Overview

ARIA (Autonomous Reasoning Intelligent Assistant) is a literary/philosophical reading companion that reads books, forms opinions, and engages critically with what she's read. Unlike generic AI chatbots, ARIA's core USP is **Feed Knowledge** — users upload books and papers, ARIA reads them, and she becomes a knowledgeable partner who can discuss, critique, and connect ideas across the user's entire library.

## What We've Built

### Core Product
- **Feed Knowledge System**: Upload PDFs (up to 70MB / 3000+ pages), text, or URLs. ARIA parses client-side, chunks the content, generates semantic embeddings, and stores everything in a searchable vector database.
- **Literary/Philosophical Intelligence**: ARIA reads books like a human — forming interpretations, having opinions, praising or criticizing authors, and connecting ideas across multiple books.
- **Smart Model Routing**: Casual chat uses a fast 8B model (2-3s responses); philosophy, literature, and book discussions switch to a 70B model for deeper reasoning.
- **5-Provider Parallel LLM**: Fires OpenRouter + Groq + Gemini + Pollinations simultaneously. First success wins. ARIA never goes offline.
- **Real Streaming**: Tokens stream in real-time from the LLM (first token in 1-3s, not 5-10s).
- **Semantic Search**: Gemini `gemini-embedding-001` embeddings (768-dim) enable meaning-based retrieval — "golden-brown ring" finds the Wilson's Disease chapter.

### Knowledge Features
- **Multi-book comparison**: "Compare Marcus Aurelius and Nietzsche on suffering" → pulls chunks from both books.
- **In-book search**: "In Meditations, where does Marcus talk about death?" → restricts search to that book.
- **Auto-generated summaries**: Every uploaded book gets a 3-sentence summary stored as a searchable entry.
- **Library grouping**: One book = one entry in the library (not 100 chunk rows).
- **Cross-book connections**: ARIA knows who "Marcus" is without the user quoting — she connects ideas across all fed books.

### Memory & Personality
- **Reading journal**: After each book discussion, ARIA writes a private journal reflection. She remembers what she thought about the book last time.
- **Opinion evolution**: Journal entries are updated (not duplicated) — ARIA's opinion literally evolves over time.
- **Book recommendations**: "What should I read next?" → ARIA recommends based on the user's existing library.
- **Persistent memories**: Facts about the user are remembered across all conversations.
- **Anti-sycophancy**: ARIA never agrees with a factual claim she hasn't verified. If the user is wrong, she corrects them.

### Communication Features
- **Green apple mode** (🍏): Type `/green apple` for raw, unfiltered deep analysis. No hedging, no disclaimers, raw opinions. The prefix morphs to 🍏 emoji in the input as you type.
- **Toggleable web search**: Off by default (ARIA thinks from her library first). Click the globe to enable web search with "Found N sources" bar + favicon logos.
- **Source bar**: When web search runs, responses show a "Found N sources" bar with clickable website favicons.

### User Experience
- **Light/Dark theme**: Toggle in settings. Amber accents preserved in both.
- **Keyboard shortcuts**: Ctrl+K (focus input), Ctrl+/ (toggle search), Esc (close modals).
- **Conversation export**: One-click Markdown export from the chat top bar.
- **Dynamic avatar**: Shows the user's name initial (not a hardcoded letter).
- **Admin unlimited credits**: Creator account bypasses daily token limits.

## Targeted Users

### Primary Audience
- **Readers and thinkers** (ages 18-40) who consume books — philosophy, literature, non-fiction — and want to discuss them with an intelligent partner.
- **Students** studying philosophy, literature, or any text-heavy subject who need a reading companion that actually engages with the material.
- **Book club members** who want to explore multiple perspectives on a book before discussing it with their group.

### Secondary Audience
- **Lifelong learners** who feed ARIA research papers, textbooks, and articles to build a personal knowledge base.
- **Writers and researchers** who need to connect ideas across multiple sources and get critical feedback on their interpretations.

### Not Targeted
- Users looking for a medical diagnostician (8B model can't do complex differential diagnosis).
- Users who need real-time voice conversation (TTS removed for now — will return with premium model).
- Users who want image generation (removed — ARIA is a reader, not an image maker).

## Features (Current)

### Feed Knowledge (USP)
- PDF upload (up to 70MB, client-side parsing for any size)
- Text paste + URL fetch
- Automatic chunking (~3000 chars, paragraph boundaries, 200-char overlap)
- Semantic embeddings (Gemini, 768-dim, free)
- Auto-generated book summaries
- Multi-book comparison
- In-book search
- Library management (grouped entries, delete, source indicators)

### Chat
- Real streaming responses
- Smart model routing (8B casual / 70B deep thinking)
- 5-provider parallel fallback (OpenRouter + Groq + Gemini + Pollinations)
- Green apple mode (🍏 raw deep analysis)
- Toggleable web search with source bar
- Anti-sycophancy (corrects wrong claims)
- Reading journal (auto-reflections after book discussions)
- Book recommendations
- Opinion evolution
- Cross-book idea connections

### UI/UX
- Light/dark theme toggle
- Keyboard shortcuts (Ctrl+K, Ctrl+/, Esc)
- Conversation export (Markdown)
- Dynamic user avatar
- Compact Claude-style model selector
- Admin unlimited credits badge
- Sticky footer layout
- Responsive (mobile + desktop)

### Settings
- Tone of voice (Warm & Honest / Direct & Sharp / Reflective & Calm)
- Response length (Concise / Balanced / In-depth)
- Model selection (Llama 3.3 70B default, GPT-OSS 120B, Qwen3 80B, DeepSeek V3)
- Sound effects toggle
- Voice responses toggle
- Light mode toggle

### Infrastructure
- Admin bypass for daily limits (creator account)
- 3-layer LLM fallback (parallel execution)
- Knowledge priority (skip web search if library covers the question)
- Adaptive payload sizing (prevent Groq 413 on long messages)
