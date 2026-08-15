---
Task ID: 1
Agent: main (ARIA audiobook retry refactor)
Task: Replace the two-phase "submit everything then wait for everything" TTS architecture with self-contained per-chapter retryable units that resubmit a FRESH operation on backend failure (instead of re-polling the dead operation).

Work Log:
- Read `.github/scripts/convert_audiobook.py` (664 lines) to understand current Phase A/B structure: `process_chapter_start` + `process_chapter_start_with_retry` (Phase A) and `process_chapter_finish` (Phase B), with `_wait_for_operation` retrying ResourceExhausted + InternalServerError + ServiceUnavailable at the poll level.
- Confirmed via grep that all references to `MAX_SUBMIT_RETRIES`, `MAX_POLL_RETRIES`, and the three `process_chapter_*` helpers are confined to `convert_audiobook.py` (no external callers).
- Confirmed the callback route (`src/app/api/audiobooks/callback/route.ts`) already consumes the structured `{order, title, url}` shape from the previous fix — no TS-side changes needed in this brief.
- Edited `.github/scripts/convert_audiobook.py` with a single atomic MultiEdit applying 4 changes:
  1. Module docstring: replaced "two-phase approach for maximum speed / Phase A / Phase B" wording with a description of the new self-contained per-chapter pipeline + fresh-resubmission semantics.
  2. `_wait_for_operation`: rewrote to retry ONLY `ResourceExhausted` (operation is alive, just throttled — polling the same op later is correct) using `range(3)` with delay starting at 15s and `delay = min(delay * 2, 60)`. `InternalServerError`/`ServiceUnavailable` now `raise` immediately so the caller can submit a fresh operation. Removed the `MAX_POLL_RETRIES = 5` constant (no longer needed).
  3. Replaced `MAX_SUBMIT_RETRIES = 3` + `process_chapter_start` + `process_chapter_start_with_retry` + `process_chapter_finish` with a single `MAX_CHAPTER_ATTEMPTS = 4` constant + `synthesize_chapter(chapter, tmp_dir, semaphore)` async function. Each attempt calls `start_synthesis_task` → `finish_synthesis_task` → `upload_to_blob`; on any exception it removes the partial output, waits `20 * (attempt + 1)` seconds, and submits a FRESH operation (reusing the same gcs_uri is safe — a fresh synthesis overwrites the previous failed/incomplete object). Returns `{"order": int, "title": str, "url": str | None}` — `None` after all 4 attempts fail.
  4. `main_async()`: replaced the Phase A `start_semaphore` + `process_chapter_start_throttled` + `asyncio.gather` and Phase B `dl_semaphore` + `process_chapter_finish` blocks with a single `semaphore = asyncio.Semaphore(2)` governing total concurrent chapter pipelines, calling `synthesize_chapter` for each chapter via `asyncio.gather`. The structured `chapter_results` list is still sorted by `order` and passed to `mark_status("complete", chapter_urls=chapter_results)` (chapter-identity preservation from the previous fix is preserved verbatim).
- Verified no stale references to removed symbols remain (`MAX_SUBMIT_RETRIES`, `MAX_POLL_RETRIES`, `process_chapter_*`, `start_semaphore`, `dl_semaphore`) via grep — zero matches.
- Ran `python3 -m py_compile .github/scripts/convert_audiobook.py` → PY_COMPILE_OK.
- Ran `npx tsc --noEmit` → no audiobook-related errors (all reported errors are pre-existing in unrelated areas: chat route, daily-digest cron, export route, settings modal, side-panels, auth config, and skills/ folder SDK imports).
- Ran `bun run lint` → clean, no errors.
- No dev.log present yet (server not started in this session) — not relevant since the changed file is a GitHub Actions Python script that the Next.js dev server never loads.

Stage Summary:
- Retry mechanism fundamentally fixed: backend-dead operations (`InternalServerError` / `ServiceUnavailable`) are no longer re-polled (which would forever return the same terminal failure); they propagate up to `synthesize_chapter` which submits a brand-new `synthesize_long_audio()` call. Rate-limit errors (`ResourceExhausted`) still benefit from same-operation polling and remain retried at the `_wait_for_operation` level.
- Architecture simplified: three orchestration helpers (`process_chapter_start`, `process_chapter_start_with_retry`, `process_chapter_finish`) collapsed into one (`synthesize_chapter`). Two semaphores (`start_semaphore`, `dl_semaphore`) collapsed into one (`semaphore = asyncio.Semaphore(2)`).
- Chapter-identity preservation from the previous fix is intact: `mark_status("complete", chapter_urls=chapter_results)` still sends the full structured list (including failed chapters with `url: None`), and the callback route still only creates `AudiobookChapter` rows for chapters with non-null `url` using their real `order` and `title`.
- Verification checklist status: py_compile passes, tsc passes (no audiobook errors), lint passes. The runtime verification items (re-run Wuthering Heights conversion, confirm "submitting a FRESH operation" log pattern, confirm improved success rate) require a live GitHub Actions run triggered from the deployed app — outside the scope of this local edit session.
- Next lever if failures persist after deploy: drop `asyncio.Semaphore(2)` → `asyncio.Semaphore(1)` (fully sequential) per Step 4 of the brief.

---
Task ID: 2
Agent: main (ARIA audiobook parser brain transplant)
Task: Port the EPUB parser brain from https://github.com/gfrangiamone/audiobook-maker (with explicit author permission) into the ARIA audiobook pipeline. Replace the legacy 110-line parse_epub with the repo's production-hardened 1700+ line parser that handles spine↔TOC orphan reconciliation, multilingual chapter-marker detection, word-boundary frontmatter filtering, footnote/URL/abbreviation noise stripping, and LIS-based heading-to-TOC assignment.

Work Log:
- Shallow-cloned the audiobook-maker repo to /tmp/audiobook-maker-research and mapped its structure: 6 brain files totaling 13K+ lines (epub_to_tts.py, tts_split.py, generation_engine.py, audio_utils.py, google_tts.py, gemini_tts.py) + secure_archive.py (zip-bomb guard).
- Dispatched a general-purpose subagent to research all 6 brain files and produce a structured inventory + comparison table + ranked harvest list. Confirmed the user's intent: port ONLY the parser brain (epub_to_tts.py), not the payment/email/audit/orchestration infrastructure.
- Read epub_to_tts.py end-to-end (2288 lines): constants (TAGS_TO_REMOVE_WITH_CONTENT, CLASSES_TO_SKIP, EPUB_TYPES_TO_SKIP, NON_CONTENT_FILENAMES, NON_CONTENT_TITLE_PHRASES, LINE_SKIP_PATTERNS, NOISE_PATTERNS, ABBREVIATIONS, multilingual _DIVIDER_NUMBER/_DIVIDER_KEYWORD/_DIVIDER_STANDALONE regexes), dataclasses (Chapter, BookInfo), HTML→text extraction (should_skip_element, extract_text_from_element, html_to_text with note-href filtering), 9-step TTS text cleaner (clean_text_for_tts), heading detection (detect_chapter_title, _derive_chapter_title, is_chapter_marker_line, is_content_chapter), resegmentation (_resegment_chapters_by_markers), main parser (parse_epub with spine↔TOC orphan reconciliation + pending_toc_title carry-forward + multi-chapter file splitting + salvage fallback), TOC walkers (_build_toc_map, _build_toc_fragments with backnote arrow filtering), 3-tier heading splitter (_split_html_by_headings with LIS dynamic programming + Tier-1/Tier-2 styled-paragraph fallback + most-common-level fallback + sibling-walk vs DOM-walk strategies), auto-splitter (_split_html_by_headings_auto with mini-TOC detection), and duplicate-heading remover (_remove_duplicate_heading).
- Read secure_archive.py (103 lines): pure-stdlib zip-slip + zip-bomb + XXE guard. No external deps. Ported verbatim.
- Created .github/scripts/tts_brain/ package:
  - __init__.py — exports parse_epub_for_tts, parse_epub, BookInfo, Chapter, clean_text_for_tts
  - secure_archive.py — verbatim port (pure stdlib, no changes)
  - epub_parser.py — verbatim port of epub_to_tts.py lines 1-2042 (parser brain only; CLI main() and output formatters intentionally skipped). Two adaptations: (1) relative import for secure_archive (`from .secure_archive import ...`), (2) added parse_epub_for_tts() adapter at the end that returns the host pipeline's dict shape `{"title", "text", "order"}` with 0-indexed order to match the host's convention.
- Rewired convert_audiobook.py: replaced parse_epub() body with a one-line delegation `from tts_brain import parse_epub_for_tts; return parse_epub_for_tts(epub_path)`. Preserved the legacy implementation as parse_epub_legacy() for fallback/comparison. Updated module docstring to credit the brain source. No other changes to convert_audiobook.py — the audio pipeline (start_synthesis_task, _wait_for_operation, finish_synthesis_task, synthesize_chapter, main_async) is untouched.
- Updated .github/workflows/audiobook-convert.yml: added `lxml` to the pip install line (the brain uses `BeautifulSoup(html, "lxml")` for speed and better XML handling, whereas the legacy code used `"html.parser"`).
- Verified with python3 -m py_compile on all 4 Python files (convert_audiobook.py + 3 tts_brain modules) → PY_COMPILE_OK.
- Installed ebooklib + beautifulsoup4 + lxml into the venv and ran a smoke test:
  - `clean_text_for_tts('See [1] the daggers † ‡ and § ¶ symbols. Visit https://example.com. Mr. Smith met Mrs. Jones. Cap. IV was great.')` → `'See the daggers and symbols. Visit Mister Smith met Missis Jones. capitolo IV was great.'` — footnote markers, URLs, daggers, section signs all stripped; abbreviations expanded; roman numeral preserved in correct order. ALL_ASSERTIONS_PASSED.
  - End-to-end test with Pride and Prejudice EPUB (gutenberg.org/ebooks/1342.epub.images): extracted 63 chapters with proper "Chapter I" / "Chapter II" / etc. labeling. The multilingual chapter-marker detector correctly found "CHAPTER II." inside body text when semantic headings weren't present, and merged image captions with the next chapter heading. Clean text output confirmed.
- Verified npx tsc --noEmit → no audiobook-related errors (all reported errors pre-existing in unrelated files).
- Verified bun run lint → clean, no errors.
- Cleaned up test artifacts: removed /tmp/audiobook-maker-research clone, test EPUBs, and __pycache__ directories.

Stage Summary:
- New file: .github/scripts/tts_brain/__init__.py (677 bytes)
- New file: .github/scripts/tts_brain/secure_archive.py (4.3 KB, verbatim port)
- New file: .github/scripts/tts_brain/epub_parser.py (88.8 KB, verbatim port of epub_to_tts.py lines 1-2042 + adapter function)
- Modified: .github/scripts/convert_audiobook.py (+27 lines: new parse_epub delegation + docstring update; legacy parser preserved as parse_epub_legacy)
- Modified: .github/workflows/audiobook-convert.yml (+1 word: `lxml` added to pip install)
- The brain transplant is text-in, text-out — it sits between EPUB download and TTS submission. The entire audio pipeline downstream (Long Audio API, fresh-operation retry, Vercel Blob upload, callback route, Prisma schema) is untouched.
- Quality gains vs legacy parser: (1) spine↔TOC orphan reconciliation fixes phantom "Chapter N" entries from light-novel/Word-export EPUBs, (2) word-boundary frontmatter filtering fixes "note" matching "Notevole" (legitimate chapters no longer dropped), (3) 9-step text cleaner strips footnote markers [1], URLs, ISBN, DOI, daggers, section signs, page numbers, expands 40+ abbreviations, fixes roman-numeral corruption, (4) LIS-based heading-to-TOC assignment handles single-file EPUBs and duplicate heading text, (5) multilingual chapter-marker detection (en/it/fr/es/de/pt/ru/hi/zh + Chinese 第N章) for books with no semantic headings, (6) backnote arrow filtering for Word-export TOCs.
- Runtime verification: smoke test of clean_text_for_tts + end-to-end parse of Pride and Prejudice EPUB both pass. The next live GitHub Actions run (triggered from the deployed app) will exercise the new parser on the user's actual library.

---
Task ID: 3
Agent: main (ARIA selective chapter conversion feature)
Task: Implement selective chapter conversion — users pick which chapters to narrate instead of auto-converting the whole book. Modeled on audiobook-maker.com's UX. User decisions: Q1=A (READY_TO_SELECT on upload, user picks), Q2=A (separate "Add Chapters" button on COMPLETED books), Q3=A (show both cost + minutes estimate), Q4=A (fix only what the feature needs).

Work Log:
- Dispatched a general-purpose subagent to research the current audiobook pipeline. Findings: upload-epub route already calls parseEpub() and gets chapters back but DISCARDS them (only persists title/author/fullText). AudiobookChapter.status field already exists with pending/generating/ready/failed values but only ready/failed were used. Callback does deleteMany+createMany which wipes unselected chapters — incompatible with partial conversion. Workflow accepts only job_id/epub_url/audiobook_id — no chapter list.
- Re-cloned audiobook-maker repo to study their chapter selection UX: checkboxes per chapter, Select All/None/Invert, live cost estimate, selected_chapters parameter threaded through their entire stack (app.js → audiobook_app.py → generation_engine.run_generation).
- Schema change: added `chapterIndices Int[] @default([])` to AudiobookJob. Backward-compatible (empty array = legacy whole-book conversion). Ran prisma generate to update the TypeScript client.
- Upload route rewrite: removed the GitHub Actions dispatch entirely. Now creates Audiobook + ALL AudiobookChapter rows upfront with status='pending' and cleanedText populated from the parser. Book lands as READY_TO_SELECT. Fixed a type bug along the way: EpubChapter uses `rawText` not `text`.
- New route POST /api/audiobooks/[id]/convert: accepts { chapterIds }, validates ownership, filters out already-ready chapters, marks selected as 'generating', looks up epubUrl from the most recent job, creates AudiobookJob with chapterIndices, dispatches GH Actions with chapter_indices input. On dispatch failure, reverts chapter statuses to 'pending' so they're not stuck at 'generating'.
- Callback route rewrite: if job.chapterIndices is non-empty, UPDATE existing chapter rows (not delete+recreate) — only chapters in the job's scope are touched. Aggregate audiobook status derived from all chapter statuses: COMPLETED (all ready) / COMPLETED_WITH_ERRORS (some failed/pending) / FAILED (none ready). Falls back to legacy delete+recreate for jobs without chapterIndices (backward compat). On job failure, reverts in-scope 'generating' chapters to 'failed' and only flips audiobook to FAILED if NO chapters are ready (otherwise COMPLETED_WITH_ERRORS so user can still play what's there).
- Workflow: added chapter_indices input (comma-separated string, optional, default ''). Passed to the Python script as CHAPTER_INDICES env var.
- Python script: reads CHAPTER_INDICES, parses comma-separated ints into a set, filters parsed chapters to only those in the set AFTER full-EPUB parsing (so spine/TOC reconciliation still works correctly). Logs the selection: "Selective conversion: N/M chapters selected (indices: [0, 1, 2])".
- New component src/components/aria/chapter-selector.tsx (~260 lines): modal with chapter list, checkboxes per chapter, status pills (ready=green check, generating=spinner, failed=red badge), Select All Pending / Clear buttons, live estimate (selected count + total chars + est minutes @ 750 chars/min + est cost @ $0.000016/char), Convert button. Polls every 5s while any chapter is generating. Shows "Listen now" button when showListenNow=true and readyCount>0. Styled to match the existing ARIA design language (AmbientGlow, GradientText, font-serif headings, var(--aria-*) colors).
- Library view wiring: READY_TO_SELECT status opens chapter selector on click (instead of player). COMPLETED/COMPLETED_WITH_ERRORS books get a "Chapters" button (top-right, hover-only) to add more chapters. FAILED books get a "Select chapters" button (replaces the old "Retry generation" button — retry now goes through the selector so the user picks which failed chapters to re-convert, not blind retry of the whole book). Polling now includes READY_TO_SELECT status so the library refreshes when conversion starts. Added selectorBook state + ChapterSelector modal at the end of the component.
- Verification: python -m py_compile OK. prisma generate OK (chapterIndices in client). npx tsc --noEmit: no audiobook-related errors (initial run flagged 2 issues: chapterIndices not in Prisma client — fixed by prisma generate; EpubChapter.text → EpubChapter.rawText — fixed). bun run lint: clean. agent-browser: landing page renders without console errors. db:push couldn't run locally (production Neon not reachable from sandbox) — schema is backward-compatible so production deploy will apply it via prisma migrate.

Stage Summary:
- 8 files changed, 820 insertions, 135 deletions
- New: src/app/api/audiobooks/[id]/convert/route.ts (convert route)
- New: src/components/aria/chapter-selector.tsx (modal UI)
- Modified: prisma/schema.prisma (+chapterIndices field)
- Modified: src/app/api/audiobooks/upload-epub/route.ts (persist chapters upfront, no auto-dispatch)
- Modified: src/app/api/audiobooks/callback/route.ts (update-not-recreate for partial completion)
- Modified: .github/workflows/audiobook-convert.yml (+chapter_indices input)
- Modified: .github/scripts/convert_audiobook.py (read CHAPTER_INDICES, filter chapters)
- Modified: src/components/aria/library-view.tsx (READY_TO_SELECT handling, Chapters button, selector modal)
- Commit 811adbc pushed to origin/main
- Feature is backward-compatible: legacy jobs (chapterIndices=[]) use the old delete+recreate callback path. Existing COMPLETED books get the "Chapters" button to add more chapters incrementally.
- db:push still needed on production (schema change is additive — new field defaults to empty array, no migration required).

---
Task ID: 4
Agent: main (ARIA parser fix + concurrent job guard + voice selection)
Task: Fix 3 bugs: (1) broken TS parser producing wrong/inconsistent chapters, (2) previous conversion command running alongside new one, (3) add audiobook-maker feature parity (voice selection, Select All/None/Invert).

Work Log:
- Read src/lib/epub-parser.ts (195 lines) and identified 6 critical missing features vs the Python tts_brain parser: no frontmatter filtering, no spine↔TOC reconciliation, no single-file splitting, no content heuristics, no backnote arrow filtering, no multilingual chapter markers. This explained the user's broken output ("Chapter 8, Chapter 17, Chapter 22, About the Author, Document Outline").
- Created .github/scripts/parse_epub.py — lightweight parse-only script that downloads EPUB, runs tts_brain.parse_epub_for_tts (the SAME parser used for conversion), and calls back with {status: 'parse_complete', chapters: [{title, text, order}]}. No TTS/GCS/ffmpeg — runs in ~20-30s.
- Created .github/workflows/audiobook-parse.yml — quick parse workflow (5-min timeout, installs only ebooklib+beautifulsoup4+lxml+requests, no GCP credentials needed).
- Rewrote src/app/api/audiobooks/upload-epub/route.ts — no longer parses in TS. Creates Audiobook as PARSING, uploads EPUB to Blob, dispatches parse job. Removed epub2/cheerio dependency from the upload flow entirely. Title is temporarily set from filename; parse callback updates with real EPUB metadata title.
- Updated src/app/api/audiobooks/callback/route.ts — handles parse_complete (creates AudiobookChapter rows, sets READY_TO_SELECT, updates title/author from EPUB metadata) and parse_failed (sets FAILED). Convert callbacks unchanged.
- Added concurrent job guard to src/app/api/audiobooks/[id]/convert/route.ts — checks for any job with status 'queued' or 'running' for this audiobook. If found, returns 409 Conflict. Also filters out 'generating' chapters from selection (can't re-convert a chapter already in flight).
- Added voice selection: convert route accepts {voice} in body (validated against en-US-Neural2-{A-I}), passes to workflow as 'voice' input, workflow passes as TTS_VOICE env var, Python script reads it with fallback to en-US-Neural2-F. Updated .github/workflows/audiobook-convert.yml with voice input.
- Enhanced src/components/aria/chapter-selector.tsx — added Select All / None / Invert buttons (matching audiobook-maker), voice dropdown with 9 Neural2 voices (A-I, labeled with gender), voice is sent with the convert request. selectableChapters now filters out 'generating' too (not just 'ready').
- Updated src/components/aria/library-view.tsx — handles PARSING status (shows "Parsing chapters on GitHub Actions…" spinner, toast on click), polls include PARSING status.
- Verified: python -m py_compile OK (both scripts), npx tsc --noEmit clean for audiobook code, bun run lint clean, agent-browser landing page renders without errors.

Stage Summary:
- 9 files changed, 472 insertions, 126 deletions
- New: .github/scripts/parse_epub.py (parse-only script)
- New: .github/workflows/audiobook-parse.yml (parse workflow)
- Modified: upload-epub route (dispatch parse job, not convert job)
- Modified: callback route (handle parse_complete/parse_failed)
- Modified: convert route (concurrent job guard + voice parameter)
- Modified: convert_audiobook.py (read TTS_VOICE env var)
- Modified: audiobook-convert.yml (voice input)
- Modified: chapter-selector.tsx (Select All/None/Invert + voice dropdown)
- Modified: library-view.tsx (PARSING status handling)
- Commit 94a9250 pushed to origin/main
- Bug #1 (parser) FIXED: same Python parser now used for both upload-time parsing and conversion — no more TS/Python mismatch
- Bug #2 (concurrent jobs) FIXED: 409 guard prevents parallel jobs for the same audiobook
- Bug #3 (feature parity) PARTIAL: voice selection + Select All/None/Invert added. Rate selection not supported by Long Audio API. M4B download + AI optimization deferred.

---
Task ID: 7-frontend-rewrite
Agent: frontend-rewrite-agent
Task: Rewrite ARIA's audiobook frontend to call the audiobook-maker Flask API directly via XTransformPort=5601

Work Log:
- Read worklog.md to understand prior agent work (Tasks 1-4: retry refactor, parser brain transplant, selective chapter conversion, voice selection + concurrent job guard).
- Read the existing ARIA frontend files (player-store.ts, use-audio-engine.ts, library-view.tsx, chapter-selector.tsx, player-view.tsx, audiobook-workspace.tsx, use-keyboard-shortcuts.ts) to understand the legacy Next.js + Prisma + GitHub Actions architecture that I was replacing.
- Probed the live Flask API at http://localhost:5601 to verify response shapes: /api/voices (returns ~30 language groups keyed by language code, each with edge-tts voices), /api/my_jobs (returns {jobs: [{job_id, status, title, output_format, created_at, ...}]}).
- Read the Flask app source (audiobook_app.py) for the exact response shapes of /api/analyze, /api/generate, /api/job_status, /api/my_jobs, /api/download, /api/cover to define accurate TypeScript types.
- CREATED src/lib/abm-api.ts (210 lines): typed wrapper module exporting analyzeEpub, generate, getJobStatus, getVoices, getMyJobs, getDownloadUrl, getCoverUrl + types (AnalyzeResponse, AnalyzeChapter, JobStatus, JobStatusResponse, GenerateResponse, AbmVoice, AbmLanguageGroup, VoicesResponse, MyJob, MyJobFormats, MyJobsResponse) + isPollingStatus helper. All fetches use relative paths with `?XTransformPort=5601` query param and `credentials: "include"` so the abm_cid cookie is automatically carried.
- REWROTE src/lib/player-store.ts: replaced the 308-line legacy store with a 159-line simplified store. Removed: Bookmark interface, CurrentAudiobook, PlayerChapter, chapters/chapterIndex/narrating/usingLiveNarration/updateChapterStatus/nextChapter/prevChapter/goToChapter/jumpToBookmark/bookmarks/showChapterList/showBookmarks/addBookmark/removeBookmark. Added: PlayingJob ({jobId, title, author, accent, downloadUrl}). openPlayer now takes (job: PlayingJob) instead of (audiobook, chapters, chapterIndex). Persisted state reduced to just playbackRate + volume (no more bookmarks to persist).
- REWROTE src/hooks/use-audio-engine.ts (512 → 175 lines): removed all chapter-by-chapter playback logic, the live-narration speechSynthesis fallback (splitIntoParagraphs, cleanForSpeech, getPreferredVoice, startLiveNarration), the per-chapter generateChapterAudio + preGenerateNextChapter functions, the 'generating' status poll loop, the PATCH /api/audiobooks/[id] progress save, and the virtual RAF clock for live narration. Kept: <audio> element creation, src loading from currentJob.downloadUrl, play/pause control, timeupdate/loadedmetadata/ended listeners, playbackRate/volume/muted sync, the SEEK_THRESHOLD store-subscription seek mechanism, sleep timer watcher, Media Session API (with seekbackward/seekforward handlers but no more previoustrack/nexttrack since there are no chapters).
- REWROTE src/hooks/use-keyboard-shortcuts.ts (87 → 73 lines): removed ArrowUp/ArrowDown (next/prev chapter), b (add bookmark), and the showChapterList/showBookmarks branches in the Escape handler. Kept: Space/k (toggle), ArrowLeft/Right (±5s), j/l (±15s), m (mute), Escape (close settings or back to library).
- REWROTE src/components/aria/library-view.tsx (419 → 327 lines): removed AudiobookListItem interface, handleDelete/confirmDelete, all references to /api/audiobooks Next.js routes, chapter fetch on open, audiobook.openPlayer with chapters. New flow: fetchJobs() calls getMyJobs() and maps MyJob → LibraryCard (with deterministic accent color from title hash since Flask doesn't return accent). Upload button (hidden file input) calls analyzeEpub(file) and stores the AnalyzeResponse in state, opening the chapter selector with chapter data. Click handlers: "done" → openPlayer({jobId, title, author, accent, downloadUrl: getDownloadUrl(jobId)}); "analyzed"/"optimized" → open chapter selector in whole-book mode (we don't have the chapter list anymore); generating/optimizing/translating → toast "Still generating"; error/cancelled/interrupted → toast "Generation failed". Polls every 5s while any job is in a polling status. Kept ARIA visual design (AmbientGlow, GradientText, ScrollReveal, BookCover, font-serif, var(--aria-*) colors, Back to chat button).
- REWROTE src/components/aria/chapter-selector.tsx (440 → 430 lines): replaced the hardcoded NEURAL2_VOICES list with a getVoices() fetch that loads the edge-tts catalog grouped by language (English first via sort). Voice dropdown uses <optgroup> per language with format "Name (Gender) — id". Removed fetchChapters (no more /api/audiobooks/[id]/chapters call) — the chapter list now comes from the analyzeResponse prop. The component supports TWO modes: (1) with analyzeResponse (post-upload) shows full chapter list with Select All/None/Invert, per-chapter checkbox, char count, estimated minutes; (2) without analyzeResponse (re-clicking an analyzed job from the library) shows a "Convert whole book" mode that calls generate() with an empty selected_chapters array (the Flask app treats that as "all chapters"). Cost estimate replaced: removed $0.000016/char calculation, now shows "$0.00 — edge-tts is free" with a green check icon. Convert button calls generate(jobId, voice, selectedArr, "mp3") with output_format="mp3" for browser-playable single-file output, then fires onConvertStarted which optimistically flips the job to "generating" in the library and triggers a fetch.
- REWROTE src/components/aria/player-view.tsx (959 → 641 lines): removed the chapter list drawer (ChapterListPanel), the bookmarks drawer (BookmarksPanel), the BookmarkButton, the SkipBack/SkipForward chapter buttons, all references to chapters/chapterIndex/nextChapter/prevChapter/goToChapter/jumpToBookmark/narrating/usingLiveNarration. The player now reads currentJob from the store and plays the single downloadUrl. Kept: cover + book meta, play/pause/skip ±15s transport, draggable progress bar with current/remaining time, SpeedControl, SleepTimerControl, VolumeControl, SettingsPanel (playback rate, volume, keyboard shortcut reference). Removed keyboard shortcuts for next/prev chapter and add bookmark from the SettingsPanel reference list.
- UPDATED src/components/aria/audiobook-workspace.tsx: simplified the docstring (the old explanation about "landing" vs "library grid" still applies). The component still mounts useAudioEngine + useKeyboardShortcuts at the root so playback survives view switches, then renders PlayerView or LibraryView based on view state.
- UPDATED eslint.config.mjs: added "mini-services/**" to the ignores list so the verbatim Flask app's static/js/app.js and templates/_fragments/seo_data.js (which have pre-existing parsing errors) don't fail `bun run lint`. Did NOT modify any files in mini-services/audiobook-maker/ — only the project-root eslint config.
- VERIFICATION: npx tsc --noEmit passes for all 7 files I touched (no audiobook-related errors; only pre-existing errors in unrelated files like chat route, daily-digest, export route, settings-modal, side-panels, auth, skills). bun run lint passes (exit 0). dev.log shows the dev server compiling cleanly with no errors after my changes.

Stage Summary:
- NEW file: src/lib/abm-api.ts (210 lines) — typed Flask API wrapper
- REWRITTEN: src/lib/player-store.ts (308 → 159 lines) — simplified to PlayingJob
- REWRITTEN: src/hooks/use-audio-engine.ts (512 → 175 lines) — single-MP3 playback
- REWRITTEN: src/hooks/use-keyboard-shortcuts.ts (87 → 73 lines) — removed chapter/bookmark shortcuts
- REWRITTEN: src/components/aria/library-view.tsx (419 → 327 lines) — calls getMyJobs/analyzeEpub
- REWRITTEN: src/components/aria/chapter-selector.tsx (440 → 430 lines) — accepts analyzeResponse prop, edge-tts voice catalog
- REWRITTEN: src/components/aria/player-view.tsx (959 → 641 lines) — single MP3 player, no chapter drawer
- UPDATED: src/components/aria/audiobook-workspace.tsx — docstring refresh
- UPDATED: eslint.config.mjs — added mini-services/** to ignores
- All Flask API calls use relative paths with ?XTransformPort=5601 query param and credentials:"include" (never http://localhost:5601).
- The abm_cid cookie (HttpOnly, SameSite=Lax, set by the Flask /api/voices response) is automatically carried on all same-origin requests through the Caddy gateway, so the Flask app can identify the client across analyze → generate → my_jobs → download calls.
- Edge cases handled: re-clicking an analyzed job (no chapter data) opens the selector in "whole-book" mode; polling stops when no jobs are in a polling status; upload errors show a toast; convert errors show a toast; the player gracefully handles missing currentJob (returns null).
- Not tested end-to-end (no agent-browser run per task instructions): the analyze → generate → poll → play flow was verified by reading the Flask source for response shapes, but a real EPUB upload + generation + playback cycle would require manual verification through the Preview Panel.

---
Task ID: 5
Agent: main (ARIA Audit Remediation — Items 1–6)
Task: Fix exactly 6 confirmed audit issues — orphaned Audiobook rows, dead files, dead exports, orphaned Prisma columns, sensitive logging. Plus re-apply TTS prosody fix from stuck commit.

Work Log:

ITEM 1 — Orphaned Audiobook rows on upload
- Grep evidence: `rg -rn "AUTO-CREATE AUDIOBOOK|audiobook.*create|prep-batch|prepStatus" src/app/api --include="*.ts"` → only `knowledge/route.ts:396` + `chat/route.ts:457` (read-only, not touched)
- Grep evidence: `rg -rn "status.*PENDING|prepStatus|prep-batch" src --include="*.ts"` → only `knowledge/route.ts` (the bug) + `audiobook-prep-agent.ts` (dead file, deleted in Item 2)
- Deleted the entire `// === AUTO-CREATE AUDIOBOOK for book-length content ===` block (lines 396–429) from `knowledge/route.ts`
- No replacement — the Flask service has no "create job from already-uploaded text" endpoint; EPUB upload goes through `analyzeEpub()` which calls the Flask `/api/analyze` endpoint
- `npx tsc --noEmit` clean for knowledge/route.ts

ITEM 2 — Delete confirmed-dead files
- Grep: `rg -rn "epub-parser" src --include="*.ts" --include="*.tsx"` → only `src/lib/epub-parser.ts` itself
- Grep: `rg -rn "audiobook-prep-agent" src --include="*.ts" --include="*.tsx"` → `src/lib/audiobook-prep-agent.ts` + comment in `src/lib/narration-clean.ts:23`
- Deleted: `src/lib/epub-parser.ts`, `src/lib/audiobook-prep-agent.ts`
- Updated comment in `narration-clean.ts:23` → "handled by the Flask audiobook-maker service"
- Grep: `rg -rn "epub2" src --include="*.ts" --include="*.tsx"` → only stale comments in `feed-aria-modal.tsx` (lines 52, 165)
- Updated both comments in `feed-aria-modal.tsx` to reflect Flask service
- Removed `epub2` from `package.json`
- `bun install` succeeded (1 package removed)
- `npx tsc --noEmit` clean

ITEM 3 — Remove dead exports
- `src/lib/user.ts`: Grep `requireUserId|getAuthenticatedUser\b` → only in user.ts. Deleted both. Kept `getAuthenticatedUserId()`. tsc clean.
- `src/components/aria/waveform.tsx`: Grep `Waveform|DecorativeWaveform` → only in waveform.tsx. Deleted both. Kept `NowPlayingBars`. tsc clean.
- `src/components/aria/primitives.tsx`: Grep `TypingDots` → only in primitives.tsx. Deleted. tsc clean.
- `src/lib/abm-api.ts`: Grep `getJobStatus|getCoverUrl|GenerateResponse` → only in abm-api.ts. Deleted all three. tsc clean.
- `src/lib/audiobooks.ts`: Grep `formatDuration` → only in audiobooks.ts. Deleted. Kept `formatTime`. tsc clean.
- `src/lib/types.ts`: Grep `from.*@/lib/types` → 7 importers, none import `Message`. Deleted `Message` type. tsc clean.

ITEM 4 — Orphaned Prisma columns/model
- Grep: `chapterBoundaries|prepChaptersCleaned|progressChapter|progressCharOffset|chapterUrls|AudiobookChapter` across src → only stale comment in `feed-aria-modal.tsx:161`
- Updated the stale comment (removed AudiobookChapter reference)
- Removed from `prisma/schema.prisma`: `Audiobook.chapterBoundaries`, `Audiobook.prepChaptersCleaned`, `Audiobook.progressChapter`, `Audiobook.progressCharOffset`, `AudiobookJob.chapterUrls`, entire `AudiobookChapter` model, `Audiobook.chapters` relation
- `npx prisma generate` succeeded
- `npx tsc --noEmit` clean (no downstream references to removed fields)
- Created migration: `prisma/migrations/20260803000000_drop_orphaned_audiobook_fields/migration.sql`
  Contents: DROP TABLE AudiobookChapter; ALTER TABLE Audiobook DROP COLUMN chapterBoundaries, prepChaptersCleaned, progressChapter, progressCharOffset; ALTER TABLE AudiobookJob DROP COLUMN chapterUrls;

ITEM 5 — Skipped (covered by Items 2 and 4)

ITEM 6 — Sensitive logging cleanup
- Fixed `src/app/api/memory/detect/route.ts` lines 204 + 206
- Before: logged `userMessage.slice(0, 80)` and `c.text.slice(0, 40)` (raw user content + memory text)
- After: logs only `userMessage.length` and `candidates.map(c => c.category/c.confidence)`
- Grep verification: `rg "console\.log.*slice" src/app/api/memory/detect/route.ts` → No matches found

BONUS — Re-applied TTS prosody fix from stuck commit 28b568f
- `tts_split.py`: edge-tts Communicate now uses `pitch="+2Hz"` + default rate `"-5%"` (warmer, slower, more natural)
- `render.yaml`: switched LLM from Gemini (region-blocked) to Groq (free, global) + added Google Cloud TTS config

Stage Summary:
Files changed:
- src/app/api/knowledge/route.ts (deleted auto-create-audiobook block)
- src/app/api/memory/detect/route.ts (fixed sensitive logging)
- src/components/aria/feed-aria-modal.tsx (updated stale comments)
- src/components/aria/primitives.tsx (deleted TypingDots)
- src/components/aria/waveform.tsx (deleted Waveform + DecorativeWaveform)
- src/lib/abm-api.ts (deleted getJobStatus, getCoverUrl, GenerateResponse)
- src/lib/audiobooks.ts (deleted formatDuration)
- src/lib/narration-clean.ts (updated stale comment)
- src/lib/types.ts (deleted Message type)
- src/lib/user.ts (deleted requireUserId, getAuthenticatedUser)
- prisma/schema.prisma (removed orphaned fields + AudiobookChapter model)
- package.json (removed epub2 dependency)
- bun.lock (updated after epub2 removal)
- mini-services/audiobook-maker/tts_split.py (edge-tts prosody: pitch +2Hz, rate -5%)
- render.yaml (Groq LLM + Google Cloud TTS config)

Files deleted:
- src/lib/epub-parser.ts
- src/lib/audiobook-prep-agent.ts

Migration file:
- prisma/migrations/20260803000000_drop_orphaned_audiobook_fields/migration.sql

---
Task ID: 6
Agent: main (ARIA Durable Job Registry — survives Render cold starts)
Task: Fix the underlying persistence gap that causes (1) duplicate library entries when the same EPUB is re-uploaded after a Render cold start, and (2) /api/job_chapters returning a degraded reconstruction (author lost, total_chapters wrong) when the in-memory job is gone. Add a durable job registry persisted to disk + R2/Storj (mirroring the _save_tokens/_load_tokens pattern), keyed by file_hash → job_id, and extract the inline Storj EPUB reconstruction logic (duplicated in api_generate and api_reset_to_chapters) into a shared _reconstruct_job_from_storj(job_id) helper used by api_generate, api_job_chapters, and api_reset_to_chapters.

Work Log:
- READ audiobook_app.py (15,381 lines) to map the existing persistence:
  - _save_tokens()/_load_tokens() at lines 1638/1703 — the pattern to copy (atomic JSON write via community_store.atomic_write_json + R2 sync, all failure paths non-fatal try/except).
  - _TOKENS_FILE = UPLOAD_DIR / "_download_tokens.json" (line 1096).
  - api_analyze() at line 7978 — duplicate detection at line 8048-8099 only checks the live `jobs` dict, NOT any durable store.
  - api_generate() at line 8785 — inline "ARIA: reconstruct in-memory job from token + Storj EPUB" block at line 8815-8860.
  - api_job_chapters() at line 9823 — weak chapter_mp3s-only fallback at line 9839-9864 (author="", total_chapters=len(chapter_mp3s) which is often 1).
  - api_reset_to_chapters() at line 9977 — second copy of the inline Storj reconstruction at line 9984-10020.
  - _check_job_owner() at line 690 — already returns the download-token snapshot as a dict when the job is missing from `jobs` (the source of `fallback_record` for the new helper).
  - Startup sequence at line 15246 — where to add _load_job_registry().
  - _parse_book(path) at line 890 — existing extension-dispatched parser (epub/pdf/txt/abm), reused by the new helper.

- ADDED _job_registry dict + _job_registry_lock + _JOB_REGISTRY_FILE (line 1099-1114), placed right after _download_tokens/_TOKENS_FILE/_tokens_lock. Maps job_id → {job_id, client_id, file_hash, title, author, total_chapters, epub_s3_key, selected_chapters, chapter_mp3s, updated_at}.

- ADDED 6 helper functions (lines 1775-1973), placed right after _load_tokens():
  - _save_job_registry() — atomic local JSON write via community_store.atomic_write_json + R2 sync. Mirrors _save_tokens() exactly. All failure paths non-fatal (try/except + print, never raises).
  - _load_job_registry() — restores from disk on startup, with R2 fallback if the local file is missing (same fallback as _load_tokens()).
  - _register_job(job_id, **fields) — updates a single job's registry entry IN MEMORY (no flush). Used by _save_tokens() to batch-update many entries from token snapshots and flush once.
  - _register_job_and_flush(job_id, **fields) — updates + persists immediately. Used by one-off mutation points (api_analyze, api_reset_to_chapters).
  - _lookup_job_by_file_hash(client_id, file_hash) — scans the registry for an entry matching (client_id, file_hash). Defensive: matches if either side has empty client_id (backward-compat with legacy entries).
  - _reconstruct_job_from_storj(job_id, fallback_record=None) — the shared helper. Resolution order: (1) durable registry, (2) fallback_record (download-token snapshot) for fields the registry misses. Downloads the EPUB from Storj, re-parses via _parse_book() (extension-dispatched), inserts a fresh 'analyzed' job into `jobs`. Raises Exception on failure (caller translates to 400/404 or falls back to weaker path).

- HOOKED _save_tokens() (line 1655) to sync the registry from token snapshots AFTER the token file is written. Hoisted `data = {}` outside the _tokens_lock block so it's accessible after the lock releases. Iterates over all token snapshots and calls _register_job() for each (batch), then a single _save_job_registry() flush. This is the "any time chapter_mp3s/selected_chapters change" write-through — tokens are saved at every generation milestone.

- UPDATED api_analyze() (line 8224):
  - Added durable-registry dedup check (lines 8347-8414) AFTER the existing in-memory check, BEFORE minting a new job_id. Looks up _lookup_job_by_file_hash(client_id, file_hash); on hit, calls _reconstruct_job_from_storj() and returns the existing job_id with the full analyze response (identical shape to the in-memory reuse path). Reconstruction failures are non-fatal — falls through to minting a fresh job_id.
  - Added _register_job_and_flush() call (lines 8475-8489) AFTER the Storj EPUB upload, recording client_id, file_hash, title, author, total_chapters, epub_s3_key, selected_chapters=[], chapter_mp3s=[]. The epub_s3_key is captured from the upload result (empty string if the upload failed, so the registry still has the metadata).

- REPLACED the inline reconstruction block in api_generate() (was lines 8815-8860) with a 6-line call to _reconstruct_job_from_storj(job_id, fallback_record=job). Same error handling (logs failure, returns 400 "Session expired. Re-upload file.").

- REPLACED the inline reconstruction block in api_reset_to_chapters() (was lines 9984-10020) with a 5-line call to _reconstruct_job_from_storj(job_id, fallback_record=_job). Same error handling (logs failure, returns 404).

- ADDED _register_job_and_flush(job_id, selected_chapters=[], chapter_mp3s=[]) call (lines 10346-10354) in api_reset_to_chapters() AFTER the in-memory reset clears those keys, so the registry mirrors the reset state (book metadata preserved, only per-generation output cleared).

- UPDATED api_job_chapters() (line 10124):
  - When `info` is missing, FIRST tries _reconstruct_job_from_storj(job_id, fallback_record=job) (the PRIMARY path, lines 10141-10158). This restores title, author, and total_chapters from the re-parsed EPUB.
  - Only if Storj reconstruction fails (e.g. epub_s3_key missing, storage backend disabled) does it fall through to the weak chapter_mp3s-only response (lines 10160-10189). The weak fallback now reads title from both "book_title" and "title" keys (defensive against different snapshot sources).
  - The response shape is unchanged — both paths return the same JSON keys.

- ADDED _load_job_registry() to the startup sequence (line 15570), placed AFTER _load_tokens() so the registry is consistent with the token snapshots (the two are kept in sync on every _save_tokens() call).

- VERIFIED end-to-end with a real Flask subprocess (port 5701) using a fake storage_backend module backed by local filesystem (so no real Storj credentials needed). Built a 3-chapter test EPUB programmatically with ebooklib. Test script: spawn Flask → POST /api/analyze → SIGKILL Flask → spawn fresh Flask → POST /api/analyze with the SAME EPUB → assert same job_id → populate chapter_mp3s in registry (simulating partial conversion) → SIGKILL Flask again → spawn fresh Flask → GET /api/job_chapters/<job_id> → assert full title, author, total_chapters=3 (NOT 1, NOT empty author).

- VERIFICATION RESULTS (actual curl-equivalent output, NOT summarized):
  - file_hash (md5 of EPUB bytes): 69bccd685ce8ce92c75e80df7bc93c8f
  - POST /api/analyze #1 → job_id=aXUoR0xU520zu7Cz3vodgQ, title="Pride and Prejudice", author="Jane Austen", total_chapters=3
  - [Flask killed — simulating Render cold-start]
  - POST /api/analyze #2 (re-upload after restart) → job_id=aXUoR0xU520zu7Cz3vodgQ (SAME), title="Pride and Prejudice", author="Jane Austen", total_chapters=3
  - [Populated 2 chapter_mp3s in registry — simulating partial conversion]
  - [Flask killed AGAIN — second cold-start]
  - GET /api/job_chapters/aXUoR0xU520zu7Cz3vodgQ → 200 OK with:
    - title: "Pride and Prejudice" (NOT empty)
    - author: "Jane Austen" (NOT empty)
    - total_chapters: 3 (NOT 1)
    - chapters: full 3-chapter list with words/chars/estimated_minutes (NOT just the 2 chapter_mp3s)
    - chapter_mp3s: the 2 partial-conversion entries preserved
    - selected_chapters: [1, 2] preserved

- CLEANED UP: removed fake storage_backend.py (restored real one from git checkout), removed test EPUB + verify scripts, restarted the dev environment (Next.js on :3000 + audiobook-maker on :5601, both returning HTTP 200).

- LINT: `bun run lint` passes (exit 0). `python3 -m py_compile audiobook_app.py` passes.

Stage Summary:
Files changed:
- mini-services/audiobook-maker/audiobook_app.py (+~290 lines net):
  - _job_registry data structures (line 1099-1114)
  - 6 helper functions: _save_job_registry, _load_job_registry, _register_job, _register_job_and_flush, _lookup_job_by_file_hash, _reconstruct_job_from_storj (lines 1775-1973)
  - _save_tokens() now syncs the registry from token snapshots (lines 1718-1738)
  - api_analyze() durable-registry dedup check + write-through (lines 8347-8414, 8475-8489)
  - api_generate() reconstruction delegated to helper (lines 9148-9161)
  - api_reset_to_chapters() reconstruction delegated to helper + registry clear on reset (lines 10285-10294, 10346-10354)
  - api_job_chapters() PRIMARY path = _reconstruct_job_from_storj, weak fallback only if Storj fails (lines 10139-10189)
  - Startup: _load_job_registry() added (line 15570)

API response shapes: UNCHANGED. All endpoints return the same JSON keys as before; only the internal reconstruction path changed.

Constraints honored:
- Did NOT touch payment, Gemini budget, or translation code paths.
- Did NOT change any endpoint's response shape.
- All persistence write-throughs are non-blocking / best-effort (try/except + print, matching the existing storage_backend call style).
- The shared _reconstruct_job_from_storj() helper is used by ALL THREE endpoints (api_generate, api_job_chapters, api_reset_to_chapters) — no duplicated reconstruction logic remains.

---
Task ID: 7
Agent: main (Fix: deleted books reappear in library on re-upload)
Task: Fix the bug where uploading an EPUB causes all previously-deleted books to reappear in the library. Test in sandbox, commit only if tests pass.

Work Log:
- ROOT CAUSE: /api/delete/<job_id> (line 10093) called _cleanup_job(job_id, reason="user_delete"). _cleanup_job is the retention-based background cleanup helper — it has an early-return guard at line 15230 that says "if _email_marker_protects(work_dir, now) or _has_active_download_tokens(job_id, now): return". For any completed job (which always has an active download token), this guard triggered and _cleanup_job returned WITHOUT deleting: (a) the download tokens, (b) the durable _job_registry entry, (c) the EPUB on Storj (epubs/<job_id>/), (d) the chapter MP3s on Storj (chapters/<job_id>/). Only the in-memory jobs[job_id] entry was popped. Result: on the next /api/my_jobs call, the deleted job reappeared (from the surviving token), AND re-uploading the same EPUB resurrected the deleted job via the registry's file_hash dedup check.

- ADDED _purge_job_completely(job_id) helper (lines 10093-10185) — a hard delete that forcefully removes EVERYTHING, bypassing the retention/email-marker/active-token guards:
  1. All download tokens for the job_id (force, ignore retention) + _save_tokens()
  2. The durable _job_registry entry + _save_job_registry()
  3. In-memory jobs[job_id] (also sets cancelled=True + status="cancelled" so a generating worker stops)
  4. Local work_dir (shutil.rmtree with ignore_errors)
  5. Cold (R2/Storj) objects under THREE prefixes: <job_id>/ (outputs), epubs/<job_id>/ (original EPUB), chapters/<job_id>/ (per-chapter MP3s). The existing _delete_cold_for_job only handles <job_id>/ — the EPUB + chapter prefixes were never purged before.
  Each step is best-effort, non-fatal (try/except + print, matching the existing storage_backend call style). _cleanup_job is NOT modified — it remains the right tool for the background retention cleanup loop.

- UPDATED api_delete_job (lines 10188-10245) to call _purge_job_completely instead of _cleanup_job. Also added a registry-cleanup branch in the 404 path (idempotent delete): if the job is already gone from in-memory + tokens but a previous delete crashed mid-purge leaving a lingering registry entry, this branch purges it so a re-upload doesn't resurrect it.

- VERIFIED end-to-end with a real Flask subprocess (port 5705) + fake local-filesystem storage_backend. Test scenario: upload EPUB A + B, delete A, re-upload A, restart Flask, check /api/my_jobs at each step. Also verified the durable registry, the Storj EPUB, and the download tokens are all gone after delete.

- VERIFICATION RESULTS (actual curl-equivalent output):
  STEP 1: Upload A + B → job_id_A=W5OhsyZDs8TpHlNdF1CbAw (Pride and Prejudice), job_id_B=SRZ1ZEbqXO2YouJYSaQuww (Frankenstein). Both in /api/my_jobs + registry + Storj.
  STEP 2: DELETE /api/delete/W5OhsyZDs8TpHlNdF1CbAw → 200 {"status":"deleted"}
  STEP 3: /api/my_jobs after delete → jobs=['SRZ1ZEbqXO2YouJYSaQuww'] (A is GONE, B remains) ✓
  STEP 4: Registry after delete → keys=['SRZ1ZEbqXO2YouJYSaQuww'] (A's entry GONE, B preserved) ✓
  STEP 5: Storj after delete → epubs/W5OhsyZDs8TpHlNdF1CbAw/ has no objects (EPUB A purged) ✓
  STEP 6: Re-upload EPUB A → job_id_new=Odvr1Gu9GVyjEJtqNGpRRQ (NEW job_id, NOT the deleted one — no resurrection) ✓
  STEP 7: Kill + restart Flask, /api/my_jobs → jobs=['Odvr1Gu9GVyjEJtqNGpRRQ', 'SRZ1ZEbqXO2YouJYSaQuww'] (deleted A stays gone, B + new A survive via tokens) ✓

- NEGATIVE TEST: temporarily reverted api_delete_job to use _cleanup_job (the old behavior), re-ran the test. It FAILED at STEP 4: "job_id_A still in durable registry after delete!" — confirming the test catches the bug. Then restored the fixed version.

- CLEANUP: removed fake storage_backend.py (restored real one from git), removed test EPUBs + verify script + test data. `bun run lint` passes. `python3 -m py_compile audiobook_app.py` passes. Next.js (port 3000) + audiobook-maker (port 5601) both returning HTTP 200.

Stage Summary:
Files changed:
- mini-services/audiobook-maker/audiobook_app.py (+135 / -10 lines):
  - NEW: _purge_job_completely(job_id) helper (lines 10093-10185)
  - UPDATED: api_delete_job now calls _purge_job_completely + handles lingering registry cleanup in the 404 path (lines 10188-10245)
  - _cleanup_job is UNMODIFIED (still used by the background retention cleanup loop)

Commit: 84aadbf "fix: deleted books no longer reappear in library on re-upload" (pushed to origin/main)

---
Task ID: 8
Agent: main (Frontend fix: deleted books reappear from localStorage on every poll)
Task: User reports deleted books STILL appear in the library. The backend fix (Task 7) wasn't enough — the frontend has its own bug.

Work Log:
- ANALYZED the screenshot (pasted_image_1785862127172.png) with VLM: shows the ARIA library at ariav2.seven.vercel.app (PRODUCTION) with 3 books visible. The user says these were deleted in the past but reappeared.

- ROOT CAUSE (frontend): fetchJobs in library-view.tsx had a merge logic (lines 150-157):
    setCards((prev) => {
      const apiIds = new Set(apiCards.map((c) => c.jobId));
      const staleCards = prev.filter((c) => !apiIds.has(c.jobId));
      return [...apiCards, ...staleCards];
    });
  This deliberately kept localStorage cards that weren't in the API response (intended for expired-but-still-on-disk books). BUT it also resurrected user-deleted books on every poll (every 5s while any job is generating). Even after the backend fix (_purge_job_completely, Task 7), the frontend's staleCards merge brought deleted cards back from localStorage.

  Two scenarios that caused the bug:
  1. Old localStorage: user had books from before the fix, "deleted" some (which didn't actually delete on the old backend). Those deleted books are STILL in localStorage. On page load, they appear.
  2. Polling resurrection: user deletes a book → setCards removes it → 5s later fetchJobs runs → backend returns the current list (without the deleted book) → BUT staleCards keeps the deleted card from localStorage → it reappears.

- FIX: Added a deletedJobIds set persisted to localStorage ('aria-audiobook-deleted' key). Three layers of filtering:

  1. On mount (useState initializer for 'cards'): filters out any job_id in the deleted set — so old localStorage entries from before the fix don't reappear on page load.

  2. In fetchJobs: both apiCards AND staleCards are filtered by deletedIds — so the merge logic can NEVER resurrect a deleted card, whether from the backend response or from localStorage.

  3. On re-upload (handleFileSelected): if analyzeEpub returns a job_id that's in the deleted set (happens when the old backend resurrects it via file_hash dedup), the job_id is removed from the deleted set — so the user can re-add a book they previously deleted.

  handleDelete now adds the job_id to the deleted set BEFORE removing it from cards state.

- VERIFIED with Agent Browser (agent-browser CLI):
  - Set up localStorage with 2 cards: 'xVd7tyb--jcyjETVKRAN2g' (live) + 'OLD_DELETED_JOB' (deleted), and deletedIds=['OLD_DELETED_JOB'].
  - Simulated the mount-time filter: 2 cards in storage → 1 after filter (deleted one removed) ✓
  - Simulated the fetchJobs merge: backend returns 2 jobs (live + deleted) → apiCards filtered to 1, staleCards filtered to 0, final result has only the live card ✓
  - Negative test (old buggy logic without deletedIds filter): both cards appear — confirmed the test catches the bug ✓
  - Re-upload test: deletedIds.has('OLD_DELETED_JOB') → true → remove from set → book shows again ✓

- VERIFIED backend E2E with curl:
  - Upload EPUB → job_id=xVd7tyb--jcyjETVKRAN2g
  - /api/my_jobs → includes the job ✓
  - POST /api/delete/xVd7tyb--jcyjETVKRAN2g → {"status":"deleted"}
  - /api/my_jobs → [] (job is GONE) ✓
  - POST /api/delete/xVd7tyb--jcyjETVKRAN2g again → {"status":"deleted"} (idempotent) ✓

- This frontend fix works EVEN IF the production backend (ariav2.seven.vercel.app → Render) hasn't been redeployed yet — the filtering happens client-side.

Stage Summary:
Files changed:
- src/components/aria/library-view.tsx (+60 / -5 lines):
  - NEW: DELETED_KEY constant + deletedIds state (loaded from localStorage on mount)
  - NEW: useEffect to persist deletedIds to localStorage
  - UPDATED: useState initializer for 'cards' filters by deletedIds on mount
  - UPDATED: fetchJobs filters BOTH apiCards AND staleCards by deletedIds
  - UPDATED: handleDelete adds job_id to deletedIds before removing from cards
  - UPDATED: handleFileSelected removes job_id from deletedIds on re-upload

Commit: 24d5ed5 "fix: deleted books no longer reappear from localStorage on every poll" (pushed to origin/main)

IMPORTANT NOTE FOR USER: The production deployment at ariav2.seven.vercel.app needs a Vercel rebuild to pick up this frontend fix. The backend on Render also needs a redeploy to pick up _purge_job_completely (Task 7). But even without the backend redeploy, this frontend fix alone will stop deleted books from appearing.

---
Task ID: 9
Agent: main (Fix: 'More chapters' doesn't generate — stale token masks live status)
Task: User reports: "after creating a chapter, clicking 'More chapters' for another one — first it doesn't get created at all, next it shows as a green tick in the chapters list but doesn't even get created at all."

Work Log:
- REPRODUCED the bug with a real Flask subprocess on port 5700. Built a 3-chapter test EPUB, generated chapter 1 (succeeded), then clicked "More chapters" → generated chapter 2. The poll returned `ok=True status=done` IMMEDIATELY (no progress shown), and chapter 2 MP3 was never created. chapter_mp3s stayed at [1] instead of [1, 2].

- ROOT CAUSE: /api/my_jobs (line 10691) iterates over `_download_tokens` AFTER the in-memory `jobs` loop. For each token, it UNCONDITIONALLY did `entry.update({"status": "done", ...})`. When the user clicks "More chapters" to generate chapter 2:
  1. First generation completes → creates a download token with status='done' + chapter_mp3s=[ch1]
  2. Second generation starts → in-memory job has status='generating'
  3. /api/my_jobs is called (by the 5s frontend poll):
     - in-memory loop sets status='generating' ✓
     - token loop OVERWRITES with status='done' + chapter_mp3s=[ch1] ✗
  4. Frontend sees status='done' → stops polling immediately
  5. Generation completes in the background, but the frontend never sees the progress or the new chapter_mp3s (the stale token's [ch1] clobbers the in-memory job's freshly-merged [ch1, ch2])

  This explains the user's exact symptoms: "doesn't get created at all" (the generation runs but the frontend never sees it) + "shows as a green tick" (the stale token says 'done').

- FIX: Added `_MY_JOBS_LIVE_ACTIVE_STATUSES = frozenset({'generating', 'optimizing', 'translating'})` (line 10634). In the token loop (line 10707-10737), if the in-memory job already has one of these active statuses, the token does NOT override the status or chapter_mp3s — it only updates download-token-only fields (download_token, expires_at, downloaded_at, formats). The token's status='done' + chapter_mp3s are only used when the job is NOT in memory (e.g. after a Flask restart).

- VERIFIED end-to-end with the same Flask subprocess:
  STEP 1-4: Upload EPUB (3 chapters), generate ch1 → chapter_mp3s=[ch1] ✓
  STEP 5: 'More chapters' → /api/job_chapters returns full 3-chapter list ✓
  STEP 6: Generate ch2 → status correctly shows 'generating' with progress ('Cap. 2/1: Chapter 2... — chunk 2/5') instead of immediately returning 'done' ✓
  STEP 7-9: chapter_mp3s=[ch1, ch2] — BOTH chapters present, both MP3 files accessible (output_1/001_Chapter_1.mp3 + output_2/001_Chapter_2.mp3) ✓

  Before the fix, STEP 7 returned `ok=True status=done` immediately (the stale token masked the running generation), and STEP 8 showed `chapter_mp3s count: 1` (only ch1, ch2 was never created).

- CLEANUP: removed test script + EPUB. `bun run lint` passes. `python3 -m py_compile` passes. Next.js (port 3000) + audiobook-maker (port 5601) both returning HTTP 200.

Stage Summary:
Files changed:
- mini-services/audiobook-maker/audiobook_app.py (+44 lines):
  - NEW: _MY_JOBS_LIVE_ACTIVE_STATUSES constant (line 10634)
  - UPDATED: /api/my_jobs token loop — preserves live 'generating'/'optimizing'/'translating' status + in-memory chapter_mp3s instead of letting a stale token override them with 'done' (lines 10707-10737)

Commit: 8216e61 "fix: 'More chapters' doesn't generate — stale token masks live status" (pushed to origin/main)

IMPORTANT NOTE FOR USER: The production deployment at ariav2.seven.vercel.app (backend on Render) needs a redeploy to pick up this backend fix. The frontend doesn't need changes — once the backend stops returning stale 'done' status, the frontend's existing polling logic will correctly track the second generation to completion.

---
Task ID: 10
Agent: main (Fix: chapter count wrong + already-converted chapters missing green tick)
Task: User reports: "after creating chapters the frontend doesn't update itself — even after 3 chapters it shows 2/34, and when creating again it shows chapters 1-2 as not in the audiobook even though they are."

Work Log:
- ROOT CAUSE: `selected_chapters` was OVERWRITTEN per generation (only had the latest batch — e.g. [3] after generating ch3), while `chapter_mp3s` was correctly MERGED ([ch1,ch2,ch3]). The frontend used `selected_chapters` for BOTH the chapter count badge AND the `alreadyConverted` set in the chapter selector. So:
  - Library card showed "1/34" or "2/34" instead of "3/34"
  - Chapter selector showed ch1+ch2 as "not in audiobook" (no green tick) because `alreadyConverted` only had [3]

- FIVE fixes applied across 3 files:

  FIX 1 (generation_engine.py, commit 266a0da): `_create_download_token` now REFRESHES the existing token's fields (chapter_mp3s, selected_chapters, output paths) instead of returning the stale snapshot from the FIRST generation. Previously the token kept chapter_mp3s=[ch1] forever.

  FIX 2 (audiobook_app.py /api/my_jobs): the in-memory jobs loop now includes `chapter_mp3s` (was missing — came ONLY from the stale token). The token loop no longer overrides `chapter_mp3s` when the in-memory job already provided it.

  FIX 3 (audiobook_app.py /api/my_jobs + /api/job_chapters): `selected_chapters` is now DERIVED from `chapter_mp3s` (the merged, authoritative source) via `sorted({ch['index'] for ch in chapter_mp3s})`. This ensures the complete set of chapters across ALL "More chapters" runs is returned, not just the latest batch.

  FIX 4 (library-view.tsx): the chapter count badge now prefers `chapterMp3s.length` (merged) over `selectedChapters.length` (per-gen).

  FIX 5 (chapter-selector.tsx): `alreadyConverted` now derives from BOTH `chapter_mp3s` (merged) AND `selected_chapters` (fallback), so chapters from previous generations correctly show the green tick.

- VERIFIED end-to-end with a real Flask subprocess on port 5700:
  - After ch1: selected_chapters=[1], chapter_mp3s_count=1 ✓
  - After ch2: selected_chapters=[1,2], chapter_mp3s_count=2 ✓ (was [2] before fix)
  - After ch3: selected_chapters=[1,2,3], chapter_mp3s_count=3 ✓ (was [3] before fix)
  - /api/job_chapters returns selected_chapters=[1,2,3] ✓
  - Library card shows "3/3 chapters" (not "2/3" or "1/3") ✓
  - All 3 chapters would show green tick in selector ✓

Stage Summary:
Files changed (this commit d07955e):
- mini-services/audiobook-maker/audiobook_app.py (+38 / -20 lines): selected_chapters derived from chapter_mp3s in /api/my_jobs + /api/job_chapters; in-memory loop includes chapter_mp3s; token loop doesn't override it
- src/components/aria/library-view.tsx (+14 / -5 lines): chapter count badge prefers chapterMp3s.length
- src/components/aria/chapter-selector.tsx (+10 / -4 lines): alreadyConverted derives from chapter_mp3s + selected_chapters

Files changed (previous commit 266a0da):
- mini-services/audiobook-maker/generation_engine.py: _create_download_token refreshes existing token fields

Commit: d07955e (pushed to origin/main)

---
Task ID: TRANSCRIPT-2-5
Agent: main (Spotify-style word-by-word synced transcript — Parts 2-5)
Task: Build Parts 2-5 of the synced-transcript feature. Part 1 (edge-tts WordBoundary capture → job["transcript_cues"]) is already done; this task exposes the cues through the Flask API, persists them across restarts, and builds the frontend store + rAF-driven highlight hook + karaoke-style transcript panel.

Work Log:

- READ context first:
  - worklog.md prior entries (Tasks 1-10) for the ARIA audiobook architecture.
  - player-view.tsx, player-store.ts, use-audio-engine.ts, abm-api.ts, library-view.tsx — frontend integration points.
  - audiobook_app.py /api/job_chapters (lines 10258-10394), /api/my_jobs (lines 10660-10903), _save_tokens (lines 1655-1738), _reconstruct_job_from_storj (lines 1916-2007).
  - generation_engine.py _create_download_token (lines 1395-1466) and the cue-finalization block (lines 4763-4788) that Part 1 added.

PART 2 — Backend (audiobook_app.py + generation_engine.py):

- _save_tokens() (audiobook_app.py ~line 1714): added `"transcript_cues": info.get("transcript_cues", {}) or {}` to the per-token snapshot dict so cues survive Flask restarts via the on-disk tokens file (+ R2/S3 sync).

- _create_download_token() (generation_engine.py ~line 1446): added `"transcript_cues": job.get("transcript_cues", {}) or {}` to _refresh_fields so the token snapshot is refreshed with the latest in-memory cues every time the token is created/updated (mirrors the existing chapter_mp3s refresh).

- _reconstruct_job_from_storj() (audiobook_app.py ~line 1959 + ~line 2000): added "transcript_cues" to the fallback_record field-copy list AND to the reconstructed in-memory job dict, so a job that's been evicted from memory (after a cold start) gets its cues restored from the token snapshot.

- Added two module-level helpers in audiobook_app.py (~lines 10672-10715) just before /api/my_jobs:
  - `_chapter_has_transcript(transcript_cues, chapter_index)`: handles BOTH int keys (in-memory job dict) AND string keys (JSON-serialized token snapshot on disk). JSON object keys are always strings on the wire, so the helper normalizes back to int for lookup.
  - `_annotate_chapter_mp3s_with_transcript(chapter_mp3s, transcript_cues)`: returns shallow copies of each chapter_mp3s entry annotated with a `has_transcript` boolean. Does NOT mutate the originals (which may be shared with the in-memory job dict or the persisted token snapshot).

- /api/job_chapters (audiobook_app.py): added `"transcript_cues": job.get("transcript_cues", {}) or {}` to BOTH response branches — the primary path (info.chapters available, line ~10388) AND the weak-fallback path (chapter_mp3s-only, line ~10345). The frontend transcript-store fetches this endpoint and extracts the cues for the current chapter.

- /api/my_jobs (audiobook_app.py): annotated chapter_mp3s with `has_transcript` in BOTH loops:
  - In-memory loop (~line 10764): uses `_tc_live = job.get("transcript_cues")` (int keys) + `_annotate_chapter_mp3s_with_transcript()`. Replaces the raw `_chapter_mp3s` list in the entry with the annotated copy.
  - Token loop (~line 10897): uses `_tc_tok = tinfo.get("transcript_cues")` (string keys) + `_annotate_chapter_mp3s_with_transcript()`. The live-active branch (line 10779-10800) is skipped via `continue`, so live in-memory jobs keep their fresher in-memory annotation. Jobs NOT in memory (or done in memory) get the token-based annotation.
  - This means /api/my_jobs NEVER ships the (large) transcript_cues payload — only the small `has_transcript` boolean per chapter. The frontend uses the flag to show a synced-transcript affordance in the library; the actual cues are fetched on-demand via /api/job_chapters.

PART 3 — Frontend types (abm-api.ts):

- Added `transcript_cues?: number[][]` to `AnalyzeChapter` (each cue is `[startMs, endMs, word]`).
- Added `transcript_cues?: Record<string, number[][]>` to `AnalyzeResponse` (keyed by stringified chapter index — JSON object keys are always strings on the wire).
- Added `has_transcript?: boolean` to `ChapterMp3Info` (returned by /api/my_jobs; the actual cues are NOT in /api/my_jobs — fetched on-demand via /api/job_chapters).

PART 4 — transcript-store.ts + use-word-sync.ts:

- Created src/lib/transcript-store.ts (zustand):
  - Per-chapter cache: `Map<string, TranscriptEntry>` keyed by `${jobId}:${chapterIdx}` (chapterIdx is the BOOK chapter number from `chapterMp3s[idx].index`, NOT the playlist position).
  - `fetchTranscript(jobId, chapterIdx)` calls `getJobChapters(jobId)` (existing abm-api helper) and extracts `transcript_cues[String(chapterIdx)]` from the response. Caches as `{ cues: number[][], words: string[] }` — words pre-extracted once so the render loop doesn't allocate per-frame.
  - Inflight request dedup: a second call for the same chapter while the first is in flight awaits the same promise.
  - States: idle / loading / ready / error / unavailable (no cues for this chapter).
  - NO localStorage persistence (cues are too large — re-fetching from /api/job_chapters is cheap).

- Created src/hooks/use-word-sync.ts:
  - Takes `cues: number[][] | null`, returns `{ activeWordIdx }`.
  - Uses `requestAnimationFrame` loop (NOT the timeupdate event — only ~4×/sec, visibly laggy). At 60fps the highlight tracks the narrator's voice tightly.
  - Reads `audio.currentTime` directly from the audio element via the module-level singleton (src/lib/audio-element-registry.ts) — bypasses the player store entirely during the rAF loop (the store only updates ~4×/sec from timeupdate).
  - `audio.currentTime` is already CHAPTER-RELATIVE (each chapter is its own MP3); cues are chapter-relative ms (3s silence prefix baked in per Part 1). Comparison is direct: `audio.currentTime * 1000` against `cue[0]` (startMs).
  - Binary search (`binarySearchActiveCue`) for the rightmost cue with `startMs <= targetMs`. Returns -1 when before the first cue (e.g. the 3s silence prefix at chapter start). Keeps the previous word highlighted during inter-word silences (no flicker).
  - setState only when the index actually changes (functional update with `(prev) => prev === idx ? prev : idx`) — the React tree isn't re-rendered 60×/sec, only when the active word changes.
  - rAF loop runs while `isPlaying` is true; cancelled on pause + unmount (per the task spec).
  - On pause, schedules a single rAF update so the highlight matches the paused position.
  - While paused, subscribes to the player store's `currentTime` as a SEEK TRIGGER — when the user scrubs the progress bar while paused, the rAF loop is cancelled, so a single rAF update is scheduled to catch the jump.
  - "No cues" reset is handled via a derived value during render (`!cues || cues.length === 0 ? -1 : internalIdx`) — no setState-in-effect needed for the reset path (lint rule compliance).

PART 5 — UI:

- Created src/lib/audio-element-registry.ts: module-level singleton (`setAudioElement` / `getAudioElement`). Module-level (not React context, not zustand) because the audio element is a true singleton per browser tab, and reading `audio.currentTime` from a 60fps rAF loop requires zero React re-renders.

- Modified src/hooks/use-audio-engine.ts: in the audio-element-creation effect, calls `setAudioElement(a)` after creating the Audio() and `setAudioElement(null)` on cleanup. The audio element is now accessible to use-word-sync.ts without going through the player store (which only updates ~4×/sec).

- Created src/components/aria/transcript-view.tsx:
  - Renders chapter text as clickable `<span>` words with `data-cue-index={i}` attribute (used by the auto-scroll querySelector).
  - Active word: `text-[var(--aria-accent-glow)]` + `bg-[rgba(245,158,11,0.14)]` (accent gold tint, matching the existing ARIA player UI).
  - Past words: `text-[var(--aria-fg)]` (full opacity).
  - Upcoming words: `text-[var(--aria-fg-muted)] opacity-55` (dimmed).
  - Active word auto-scrolls into view with `scrollIntoView({ block: "center", behavior: "smooth" })` (or `"auto"` if prefers-reduced-motion).
  - Manual scroll detection: a `scroll` listener on the container records `Date.now()` in a ref; auto-scroll is suppressed for 4s afterwards so the user can browse freely.
  - Click/tap a word → `seek(chapterStartSec + cue.startMs / 1000)` — converts chapter-relative cue ms to global seek seconds (chapterStartSec = sum of previous chapters' duration_ms / 1000).
  - Loading state → 6-line skeleton with `animate-pulse`.
  - Unavailable state → "Transcript not available for this chapter." + a hint about edge-tts voices.
  - Error state → "Couldn't load transcript." + a "Try again" button that re-invokes fetchTranscript.
  - Wrapped in a `TranscriptFrame` that matches the existing player UI style (var(--aria-bg-soft) bg, var(--aria-border) hairline, rounded-2xl, header bar with "Transcript" label + "Click any word to jump there" hint).
  - `prefers-reduced-motion` is read via `useSyncExternalStore` (React 18+ idiomatic pattern for external state subscriptions — avoids the cascading-render lint warning that useEffect+setState would trigger).

- Modified src/lib/player-store.ts:
  - Added `showTranscript: boolean` to the PlayerState interface.
  - Added `toggleTranscript: () => void` action.
  - Initialized `showTranscript: false`.
  - NOT persisted to localStorage (the panel should be closed by default on each fresh page load — keeps the player UI clean until the user explicitly asks for the transcript). The existing `partialize` only persists `playbackRate` + `volume`, so this is already correct.

- Modified src/components/aria/player-view.tsx:
  - Imported `AlignLeft` from lucide-react + `TranscriptView` from "./transcript-view".
  - Added `showTranscript` + `toggleTranscript` selectors.
  - Added `handleToggleTranscript()` that closes the chapters drawer + settings panel (mutually exclusive UI surfaces) before toggling the transcript panel.
  - Added a third `SidePanelToggle` in the header with `kind="transcript"`, `icon={AlignLeft}`, `label="Transcript"`, `active={showTranscript}`, `onClick={handleToggleTranscript}`.
  - Extended the `SidePanelToggle` `kind` prop type to include `"transcript"`.
  - Renders `<TranscriptView />` as a panel below the secondary controls (inside the player controls column, after `<SpeedControl />` / `<SleepTimerControl />` / `<VolumeControl />`) when `showTranscript` is true.

CONSTRAINTS honored:
- Did NOT modify tts_split.py or the cue-finalization code in generation_engine.py (Part 1 is working — only added `transcript_cues` to `_refresh_fields`).
- Did NOT change any existing job/token JSON shape — only ADDED fields (`transcript_cues` on /api/job_chapters + token snapshot, `has_transcript` on /api/my_jobs chapter_mp3s entries).
- Did NOT use `communicate.stream()` anywhere else.
- Transcript generation failing never fails a job — the cue-finalization in generation_engine.py is already wrapped in try/except, and the API helpers (`_chapter_has_transcript`, `_annotate_chapter_mp3s_with_transcript`) all default to false/empty when transcript_cues is missing.
- Frontend handles missing transcript_cues gracefully: "Transcript not available for this chapter." message + skeleton while loading + error retry.
- Used existing shadcn/ui components and the ARIA design system (CSS variables: --aria-fg / --aria-fg-muted / --aria-fg-dim / --aria-accent-glow / --aria-bg-soft / --aria-border / --aria-card; fonts: font-serif for the transcript body, font-mono for the header label).
- Transcript panel matches the existing player UI style (TranscriptFrame wrapper with same bg + border + rounded corners as the rest of the player).

VERIFICATION:
- `npx tsc --noEmit`: zero errors in any of the modified/created files (transcript-store.ts, use-word-sync.ts, audio-element-registry.ts, transcript-view.tsx, abm-api.ts, player-store.ts, player-view.tsx, use-audio-engine.ts). Pre-existing errors in unrelated files (skills/, scripts/, settings-modal.tsx, side-panels.tsx, auth.ts) are unchanged.
- `bun run lint`: PASSES (0 errors, 0 warnings).
- `python3 -m py_compile audiobook_app.py generation_engine.py tts_split.py`: PASSES.

Stage Summary:
Files changed:
- mini-services/audiobook-maker/audiobook_app.py (+60 / -5 lines):
  - NEW: `_chapter_has_transcript()` + `_annotate_chapter_mp3s_with_transcript()` helpers (lines 10672-10715)
  - UPDATED: `_save_tokens()` — persists transcript_cues in token snapshot (line 1714)
  - UPDATED: `_reconstruct_job_from_storj()` — restores transcript_cues from token snapshot (lines 1959, 2000-2004)
  - UPDATED: `/api/job_chapters` — returns transcript_cues in BOTH response branches (lines 10345, 10388-10393)
  - UPDATED: `/api/my_jobs` — annotates chapter_mp3s with has_transcript in BOTH loops (lines 10758-10765, 10888-10899)

- mini-services/audiobook-maker/generation_engine.py (+9 lines):
  - UPDATED: `_create_download_token()` — adds transcript_cues to _refresh_fields (lines 1446-1453)

- src/lib/abm-api.ts (+22 / -1 lines):
  - UPDATED: `AnalyzeChapter` — added `transcript_cues?: number[][]`
  - UPDATED: `AnalyzeResponse` — added `transcript_cues?: Record<string, number[][]>`
  - UPDATED: `ChapterMp3Info` — added `has_transcript?: boolean`

- src/lib/audio-element-registry.ts (NEW, 24 lines):
  - Module-level singleton for the live <audio> element

- src/lib/transcript-store.ts (NEW, 200 lines):
  - Zustand store with per-chapter cache + inflight dedup + status tracking

- src/lib/player-store.ts (+9 lines):
  - Added `showTranscript: boolean` + `toggleTranscript()` action

- src/hooks/use-audio-engine.ts (+5 lines):
  - Calls `setAudioElement(a)` on audio creation + `setAudioElement(null)` on cleanup

- src/hooks/use-word-sync.ts (NEW, 134 lines):
  - rAF loop reading audio.currentTime directly + binary-search cue lookup + setState only on index change

- src/components/aria/transcript-view.tsx (NEW, 304 lines):
  - Karaoke-style word grid with active/past/upcoming states, click-to-seek, auto-scroll with 4s manual-scroll suppression, skeleton/error/unavailable states, prefers-reduced-motion via useSyncExternalStore

- src/components/aria/player-view.tsx (+30 / -4 lines):
  - Added AlignLeft import + TranscriptView import
  - Added showTranscript + toggleTranscript selectors + handleToggleTranscript
  - Added third SidePanelToggle (transcript) in the header
  - Renders <TranscriptView /> below secondary controls when toggled
  - Extended SidePanelToggle kind prop to include "transcript"

No git push — implementation + verification only, per the task spec.

---
Task ID: BGM-1
Agent: main (AI-driven BGM cue system)
Task: Add an AI-driven BGM (background music) cue system on top of the existing Edge-TTS + word-timing pipeline. 8-mood asset library, LLM cue generation, ffmpeg mixing, 3 delivery modes (off/runtime/prerender), runtime browser mixer with crossfade + lockstep sync.

Work Log:
- Read prior worklog entries (Tasks 1-10, TRANSCRIPT-2-5) for ARIA audiobook architecture context.
- Launched two parallel Explore agents to map the backend (tts_split.py, generation_engine.py, audiobook_app.py, storage_backend.py, audio_postprocess.py, audio_utils.py, requirements.txt) and frontend (use-audio-engine.ts, use-word-sync.ts, audio-element-registry.ts, player-store.ts, transcript-store.ts, abm-api.ts, player-view.tsx, chapter-selector.tsx, audiobook-workspace.tsx, abm/[...path]/route.ts).
- KEY DISCOVERY: word timings on the wire are {chapter_index: [[startMs, endMs, word], ...]} (integer ms, flat arrays) — NOT the {w, t, d} float-seconds format the spec assumed. Adapted bgm_cues.py to normalize both formats internally.

BACKEND — new modules:
- bgm_registry.py: MOODS tuple (calm_amb, wonder, tension_low, tension_high, dread, action, sorrow, resolve, silence). asset_path_for() / asset_exists() / is_valid_mood() helpers. ASSET_DIR resolved relative to the module file.
- assets/bgm/: 8 royalty-free seamless loop MP3s (30s each, 44.1kHz stereo, 128k libmp3lame), generated via ffmpeg sine-wave synthesis with tremolo + fades. Each mood has a distinct emotional character (calm_amb = A2+E3 fifth, dread = D2+G2 tritone, action = D3+D4 rhythmic pulse at 6Hz, etc.).
- bgm_cues.py: generate_bgm_cues(chapter_text, word_timings) — normalizes input (accepts both [[startMs,endMs,word]] and [{w,t,d}] formats), builds indexed transcript "[0]The [1]corridor..." capped at 3000 words/call (splits long chapters with index offset), calls the shared OpenAI-compatible LLM (generation_engine._llm_client) with response_format=json_object + THINKING_OFF_BODY (mirrors community_translator.py pattern), validates output (drop unknown moods, clamp indices, sort, merge adjacent same-mood, force-fill gaps with previous mood), converts index→time cues with gain_db = -26 + intensity*2 (-24..-16 dB), 1.5s fade-in lead-in on first cue, 2.0s crossfade tail on every cue. R2 caching layer: get_or_create_bgm_cues() checks R2 first (bgm/{job_id}/{chapter}.bgm.json.gz), generates + caches on miss. Fail-soft everywhere.
- bgm_mix.py: mix_chapter(voice_mp3, cues, out_path) — single ffmpeg invocation. For each non-silence cue: -stream_loop (finite count computed from asset duration) + atrim + volume(gain_linear) + afade in/out 1.5s + adelay. amix all beds (normalize=0), then [voice]asplit → sidechaincompress(threshold=0.03:ratio=8:attack=20:release=500) for ducking, then [v2][ducked]amix(duration=first) + loudnorm(I=-16:TP=-1.5:LRA=11) + libmp3lame 128k. Never loads audio into Python memory. 300s timeout. Fail-soft: returns False on any error → caller keeps clean voice.

BACKEND — integration:
- generation_engine.py (+50 lines after transcript_cues finalization, before R2 upload): reads job["bgm_mode"], for each chapter with transcript_cues calls get_or_create_bgm_cues(). "prerender" mode: calls mix_chapter() and replaces the chapter MP3 in-place (os.replace), re-measures duration. "runtime" mode: just caches cues in R2 + job["bgm_cues"]. Stashes job["bgm_mode"] + job["bgm_cues"].
- audiobook_app.py:
  - /api/generate: parses bgm_mode ("off"|"runtime"|"prerender"), validates, stashes on job.
  - /api/bgm_asset/<mood>: serves loop MP3s with 30-day immutable cache headers. 404 for unknown mood/silence.
  - /api/bgm_cues/<job_id>/<int:chapter_index>: runtime-mode cue endpoint. Resolution: in-memory job["bgm_cues"] → R2 cache → self-heal regenerate from transcript_cues. 7-day immutable cache headers. 404 for off/prerender mode. Fail-soft: returns {cues:[]} on any error.
  - _build_job_descriptor: persists bgm_mode across restarts.
  - _reenqueue_orphan: restores bgm_mode.
  - _save_tokens: persists bgm_mode + bgm_cues in token snapshot.
  - _reconstruct_job_from_storj: restores bgm_mode + bgm_cues from token snapshot (field-copy list + job dict).
  - /api/job_chapters: returns bgm_mode in BOTH response branches so the frontend knows whether to fetch cues.

FRONTEND — new modules:
- src/lib/bgm-cues-store.ts: zustand store mirroring transcript-store.ts. Per-chapter cache (Map<key, BgmCuesEntry>), inflight dedup, status tracking (idle/loading/ready/error/unavailable). fetchCues() calls getBgmCues(). NOT persisted to localStorage.
- src/hooks/use-bgm-engine.ts: the runtime mixer. Lazily creates one <audio loop> per mood (preload="auto"). rAF loop reads audio.currentTime from the audio-element-registry singleton, binary-searches the current cue, triggers crossfade on mood change (linear volume ramp over 1.5s, gain_db→linear conversion, multiplied by bgmVolume slider). Pause/resume lockstep with main audio. Seek detection (delta > 1.5s): jumps active loop to (t - cue.start) % loopDuration. BGM disabled → stops all elements. Chapter change → stops all + fetches new cues. All state in refs (no React re-renders at 60fps).

FRONTEND — integration:
- src/lib/abm-api.ts: added BgmCue interface, bgm_mode field on AnalyzeResponse, getBgmCues(jobId, chapterIdx), getBgmAssetUrl(mood), bgmMode param on generate().
- src/lib/player-store.ts: added bgmEnabled (default true), bgmVolume (default 60), toggleBgm(), setBgmVolume(). Persisted via partialize (alongside playbackRate + volume).
- src/components/aria/player-view.tsx: SettingsPanel now has a "Background music" section with on/off toggle + 0-100% volume slider (disabled when BGM is off), matching the existing Volume slider style. Added Music icon import.
- src/components/aria/chapter-selector.tsx: added BGM mode dropdown (Runtime mix / Prerender / Off, default Runtime) next to the voice selector. Passes bgmMode to generate(). Added Music icon import.
- src/components/aria/audiobook-workspace.tsx: mounts useBgmEngine() alongside useAudioEngine().

VERIFICATION:
- python3 -m py_compile: all 5 backend modules compile clean.
- npx tsc --noEmit: zero errors in any BGM-related file (bgm-cues-store, use-bgm-engine, abm-api, player-store, player-view, chapter-selector, audiobook-workspace). Pre-existing errors in unrelated files unchanged.
- bun run lint: 0 errors, 0 warnings.
- Flask backend running on port 5601: /api/bgm_asset/calm_amb → 200 OK (481KB, immutable cache). /api/bgm_asset/foobar → 404. /api/bgm_cues/nonexistent/0 → 404.
- Next.js proxy: /api/abm/bgm_asset/calm_amb → 200 OK (immutable cache headers forwarded). /api/abm/bgm_cues/nonexistent/0 → {error: "Job not found"}.
- End-to-end cue pipeline test: 50 mock words → generate_bgm_cues (LLM unavailable → fail-soft single silence segment) → _segments_to_time_cues (start=1.5 lead-in, end=29.9 crossfade tail, gain_db=-24) → get_or_create_bgm_cues (R2 unavailable → returns generated cues without caching). All cues validated.
- ffmpeg mixing test: 5s voice MP3 + 3 cues (calm_amb 0-3s, silence 3-4s skipped, action 4-8s) → 5.04s output MP3, valid audio, sidechaincompress + loudnorm applied.
- agent-browser: page loads cleanly, no console errors, no runtime errors. BGM settings (bgmEnabled:true, bgmVolume:60) verified in localStorage["aria-audiobooks"].
- Both servers running clean: Next.js dev.log shows 200 responses, Flask log shows 200/404 for BGM endpoints.

Stage Summary:
Files created:
- mini-services/audiobook-maker/bgm_registry.py (80 lines)
- mini-services/audiobook-maker/bgm_cues.py (340 lines)
- mini-services/audiobook-maker/bgm_mix.py (170 lines)
- mini-services/audiobook-maker/assets/bgm/*.mp3 (8 × 30s loops, ~470KB each)
- src/lib/bgm-cues-store.ts (120 lines)
- src/hooks/use-bgm-engine.ts (210 lines)

Files modified:
- mini-services/audiobook-maker/generation_engine.py (+50 lines: BGM cue generation + prerender mixing block)
- mini-services/audiobook-maker/audiobook_app.py (+85 lines: bgm_mode parsing, /api/bgm_asset, /api/bgm_cues, persistence in 5 locations, bgm_mode in /api/job_chapters)
- src/lib/abm-api.ts (+40 lines: BgmCue type, bgm_mode field, getBgmCues(), getBgmAssetUrl(), bgmMode param on generate())
- src/lib/player-store.ts (+15 lines: bgmEnabled, bgmVolume, toggleBgm, setBgmVolume + persist)
- src/components/aria/player-view.tsx (+30 lines: BGM section in SettingsPanel + Music icon)
- src/components/aria/chapter-selector.tsx (+25 lines: BGM mode dropdown + bgmMode passed to generate())
- src/components/aria/audiobook-workspace.tsx (+2 lines: mount useBgmEngine)

CONSTRAINTS honored:
- Did NOT modify use-word-sync.ts, transcript-view.tsx, the cue/timing storage format, or the audio engine logic.
- No heavy audio deps (no pydub, no librosa) — ffmpeg CLI only for mixing.
- Fail-soft everywhere: missing LLM → silence cues; missing R2 → uncached cues; missing asset → clean narration; missing cues → no mixing.
- Single ffmpeg invocation for mixing (no intermediate WAVs) — stays in Render RAM budget.
- BGM elements managed in refs (no React re-renders at 60fps).

---
Task ID: BUGFIX-1-2
Agent: main (Fix stuck-at-last-chunk + covers disappear after restart)
Task: Fix two bugs: (1) Generation appears stuck at the last chunk because progress is updated BEFORE synthesis and there's no progress during finalization. (2) Book covers disappear after Render restarts because the cover is only on ephemeral disk + in-memory.

Work Log:
- Launched 3 parallel Explore agents to map generation_engine.py (progress/finalization/cancel logic), audiobook_app.py (my_jobs/cover/analyze/recovery), and frontend (library-view/book-cover/abm-api).
- KEY FINDINGS: _update_progress sets progress_current=2+i BEFORE _synthesize_chunk (line 3989-4000). No progress during finalization. _check_cancelled has no phase check. Cover only in memory + ephemeral disk. Cleanup supervisor already has a 600s stale watchdog but skips email jobs. Token doesn't persist last_status/cover_s3_key.

BUG 1 BACKEND (generation_engine.py):
- _update_progress: added progress_phase="synthesizing", progress_finalize_pct=0.
- _check_cancelled: returns False immediately when progress_phase=="finalizing" (immune to 60s heartbeat watchdog during concat/encode/upload).
- Added _emit_finalize(msg, frac) helper: sets progress_phase="finalizing", progress_message, progress_finalize_pct=int(frac*100), progress_updated_at. Wrapped in try/except so progress writes never break generation.
- POST-synthesis bump in BOTH branches (single_file line 4323, per-chapter line 4670): job["progress_current"]=2+i+1 + progress_updated_at=time.time() — counter only reaches N/N when chunk N is actually done.
- _emit_finalize calls at each finalization step:
  - "Assembling audio..." (0.05) — after chunk loop, both branches.
  - "Uploading to storage..." (0.70) — before R2 upload in per-chapter branch.
  - "Saving transcript cues..." (0.85) — after R2 upload.
  - "Finishing up..." (0.95) — before status flip to done.
- Wrapped the critical finalization (abm snapshot + status flip) in try/except BaseException: sets status="error", error="Finalization failed: {e}", progress_updated_at, calls _mark_pending_failed, then re-raises. MemoryError on Render now surfaces as error, not eternal "generating".

BUG 1 BACKEND (audiobook_app.py):
- /api/my_jobs stale-job watchdog: if status=="generating" and time.time()-progress_updated_at > 900 (15min), flips to "interrupted" with message "Generation stalled (server restarted or ran out of memory). Re-run the remaining chapters." Calls pending_jobs.mark_failed.
- Exposed progress_phase, progress_finalize_pct, progress_updated_at in the generating entry.
- Cleanup supervisor: bumped threshold 600→900s, removed has_email bypass for stale check (now applies to ALL jobs including email-registered batch jobs). Heartbeat check still only for non-email jobs.
- Startup recovery: after _load_job_registry(), scans _download_tokens for entries with last_status=="generating" not in memory → marks "interrupted" + calls _save_tokens(). 
- _save_tokens: cross-references live jobs dict to set last_status from the job's current status on every save.
- Token loop in /api/my_jobs: reports "interrupted" instead of "done" when last_status=="interrupted".

BUG 1 FRONTEND:
- abm-api.ts MyJob: added progress_phase ("synthesizing"|"finalizing"), progress_finalize_pct (0-100), progress_updated_at (unix timestamp).
- library-view.tsx LibraryCard + toCard: added progressPhase, progressFinalizePct, progressUpdatedAt.
- progressPct(): when progressPhase=="finalizing", renders 90 + round(finalize_pct * 0.1) so the bar creeps 90→100 instead of freezing.
- Polling effect: now polls for ALL isPollingStatus (generating/optimizing/translating/analyzed/optimized), not just generating. Heartbeat still only for generating.
- Stale-card merge: DROPS any stale card with status in {generating, optimizing, translating} when the API no longer returns it. Only keeps terminal-status stale cards. Fixes the "frozen 89% card forever" bug.
- Stall banner: when generating and Date.now()/1000 - progressUpdatedAt > 240 (4min), shows "No progress for a few minutes — the free-tier server may be waking up or restarting" + a Refresh button that calls fetchJobs().
- Progress label now shows card.progressMessage (which during finalizing is "Encoding MP3..." / "Uploading..." etc.) instead of just "Converting… N%".

BUG 2 BACKEND (audiobook_app.py):
- /api/analyze: after writing cover to disk (BOTH the .abm branch and EPUB branch), uploads to R2 at covers/{job_id}/cover{ext} via storage_backend.upload_file. Sets jobs[job_id]["cover_s3_key"]. Fail-soft: never breaks analyze.
- /api/cover rewritten with 4-tier resolution: (a) in-memory cover_thumb on disk, (b) disk fallback UPLOAD_DIR/<job_id>/cover_thumb.{jpg,png,jpeg}, (c) cover_s3_key → 302 redirect to presigned_get_url, (d) 404. All successful responses get Cache-Control: public, max-age=604800, immutable.
- _save_tokens: persists cover_thumb, cover_s3_key, cover_mime, last_status in the token snapshot.
- _reconstruct_job_from_storj: overlay list includes cover_s3_key, cover_mime, cover_thumb. Reconstructed job dict restores all three.
- /api/my_jobs has_cover (both in-memory + token loops): bool(cover_thumb or cover_s3_key) so restored jobs still advertise their cover.
- _create_download_token (generation_engine.py): _refresh_fields includes cover_s3_key, cover_mime, last_status.

BUG 2 FRONTEND:
- book-cover.tsx: replaced imperative onError style.display="none" with React state (imgFailed). Uses the React-recommended "adjust state during render" pattern (prevUrl tracking) to reset on URL change — avoids the setState-in-effect lint warning. Falls back to cached cover → monogram. Never leaves an empty dark box.
- cover-cache.ts (NEW): IndexedDB cache (DB "aria-covers", store "covers"). getCachedCover(jobId) reads data URL. cacheCover(jobId, url) fetches → blob → if <400KB → data URL → put. All operations wrapped in try/catch — fail-soft, never blocks.
- BookCover: on mount, loads cached cover from IndexedDB (instant display on cold backend). If network image succeeds, refreshes cache in background. If network fails and cache exists, shows cached cover instead of monogram. jobId prop passed from library-view.tsx and player-view.tsx call sites.

VERIFICATION:
- python3 -m py_compile: both audiobook_app.py + generation_engine.py compile clean.
- npx tsc --noEmit: zero errors in any modified file (book-cover, cover-cache, library-view, abm-api, player-view).
- bun run lint: 0 errors, 0 warnings (fixed set-state-in-effect by using prevUrl pattern).
- Flask backend running on port 5601: /api/cover/test → 404 (correct), /api/bgm_asset/calm_amb → 200, /api/my_jobs → {"jobs":[]}.
- Next.js proxy: /api/abm/cover/test → 404, /api/abm/my_jobs → {"jobs":[]}.
- agent-browser: page loads cleanly, no console errors, no runtime errors.
- Both servers running healthy.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/generation_engine.py (+55 lines: _emit_finalize, post-synthesis bumps, finalization emitters, crash wrapper, _check_cancelled phase check, _create_download_token cover_s3_key/last_status)
- mini-services/audiobook-maker/audiobook_app.py (+110 lines: my_jobs watchdog+fields, cover R2 upload in analyze, /api/cover rewrite, _save_tokens cover+last_status persistence, _reconstruct_job_from_storj restore, cleanup supervisor 900s+all-jobs, startup recovery, token-loop interrupted status, has_cover fix)
- src/lib/abm-api.ts (+10 lines: progress_phase, progress_finalize_pct, progress_updated_at on MyJob)
- src/components/aria/library-view.tsx (+40 lines: LibraryCard fields, progressPct finalizing, polling for all isPollingStatus, stale-merge drop active, stall banner)
- src/components/aria/book-cover.tsx (rewritten: React state fallback + IndexedDB cache integration)
- src/components/aria/player-view.tsx (+1 line: jobId prop on BookCover)

Files created:
- src/lib/cover-cache.ts (95 lines: IndexedDB get/put for cover data URLs, fail-soft)

CONSTRAINTS honored:
- Did NOT modify use-word-sync.ts, transcript-view.tsx, transcript-store.ts, or the cue/timing format.
- No new Python dependencies — reused storage_backend + ffmpeg CLI.
- Every new code path fails soft: missing R2 → disk fallback → monogram; missing IndexedDB → network URL; failed cover upload → non-fatal; failed progress write → non-fatal.

---
Task ID: REMOVE-TRANSCRIPT-BGM
Agent: main (strip synced transcript + BGM features from ARIA frontend)
Task: Remove ALL frontend code for the synced-transcript feature (karaoke-style word highlighting) AND the BGM (background music) runtime mixer feature. Leave no dead imports, no commented-out code, no orphan state/types/API helpers. Backend Python files are untouched (backend can keep its BGM/transcript code).

Work Log:
- Read prior worklog entries (Tasks 1, TRANSCRIPT-2-5, BGM-1, BUGFIX-1-2) for context on what was added and how it interconnects.
- Mapped all consumers via Grep: confirmed the transcript/bgm surface is fully self-contained — every importer of the 7 deleted modules was either a file I was already going to clean (player-store, player-view, chapter-selector, audiobook-workspace, use-audio-engine) or another deleted module.
- Audited 4 incidental "transcript" mentions to confirm they are UNRELATED to the audiobook synced-transcript feature and must be left alone:
  - src/app/globals.css `.aria-voice-transcript` — CSS class for the live voice chat transcript bubble (different feature).
  - src/lib/conversation-summary.ts — local var `transcript` holding chat message text for LLM summarization (different feature).
  - src/app/api/conversations/[id]/export/route.ts — comment about "human-readable transcript" for chat conversation exports (different feature).
  - src/lib/audio-cache.ts line 20 — comment "same as transcript cache" was a stale cross-reference; updated to just "Key shape: `${jobId}:${chapterIndex}`." since transcript-cache is being deleted.

DELETED (7 files):
- src/components/aria/transcript-view.tsx
- src/lib/transcript-store.ts
- src/lib/transcript-cache.ts
- src/hooks/use-word-sync.ts
- src/lib/audio-element-registry.ts
- src/lib/bgm-cues-store.ts
- src/hooks/use-bgm-engine.ts

MODIFIED — src/lib/player-store.ts (-25 lines):
- Removed `showTranscript: boolean` from PlayerState interface.
- Removed `toggleTranscript` action declaration + implementation + the "not persisted (we want it closed by default...)" comment.
- Removed BGM state fields: `bgmEnabled`, `bgmVolume` and their explanatory comments.
- Removed BGM actions: `toggleBgm`, `setBgmVolume`.
- Removed `bgmEnabled` + `bgmVolume` from the persist `partialize` selector (kept `playbackRate` + `volume`).
- Removed initial state values `bgmEnabled: true`, `bgmVolume: 70` and the "enabled by default at 70% volume..." comment.
- Removed `showTranscript: false` initial value.

MODIFIED — src/lib/abm-api.ts (-58 lines):
- Removed `transcript_cues?: number[][]` from `AnalyzeChapter` (and the doc comment).
- Removed `transcript_cues?: Record<string, number[][]>` + its doc comment from `AnalyzeResponse`.
- Removed `bgm_mode?: "off" | "runtime" | "prerender"` + its doc comment from `AnalyzeResponse`.
- Removed the entire `BgmCue` interface (and its doc comment).
- Removed `has_transcript?: boolean` + its doc comment from `ChapterMp3Info`.
- Removed `bgmMode` parameter from `generate()` signature + `bgm_mode: bgmMode` from the POST body.
- Removed `getBgmCues()` function + its doc comment (the function the task spec calls "fetchBgmCues" — actual name was getBgmCues).
- Removed `getBgmAssetUrl()` function + its doc comment.

MODIFIED — src/hooks/use-audio-engine.ts (-5 lines):
- Removed `import { setAudioElement } from "@/lib/audio-element-registry";`.
- Removed `setAudioElement(a)` call + its 3-line "register the audio element so the word-sync hook can read audio.currentTime..." comment.
- Removed `setAudioElement(null)` from the cleanup return.

MODIFIED — src/components/aria/player-view.tsx (-65 lines):
- Removed `AlignLeft` and `Music` from lucide-react imports (both were used only for transcript toggle + BGM settings respectively).
- Removed `import { TranscriptView } from "./transcript-view";`.
- Removed `showTranscript` + `toggleTranscript` selectors from usePlayerStore.
- Removed `handleToggleTranscript` function + its 4-line comment.
- Removed the transcript `<SidePanelToggle kind="transcript" ... />` button from the header.
- Updated the Reader SidePanelToggle's onClick to no longer reference showTranscript/toggleTranscript (kept the showSettings close-on-open behavior).
- Removed the `{showTranscript && <TranscriptView />}` render + its 3-line "synced-transcript panel" comment.
- Updated `SidePanelToggle`'s `kind` union type from `"settings" | "chapters" | "transcript"` to `"settings" | "chapters" | "reader"` (reader was already in use but missing from the type — fixed the type to match reality now that transcript is gone).
- In `SettingsPanel`: removed `bgmEnabled`, `bgmVolume`, `toggleBgm`, `setBgmVolume` selectors and the entire "Background music" UI block (label, on/off toggle button, 0-100% range slider with `disabled={!bgmEnabled}`, the 0%/current%/100% labels).

MODIFIED — src/components/aria/chapter-selector.tsx (-22 lines):
- Removed `Music` from lucide-react imports.
- Removed `bgmMode` state + its 3-line "BGM delivery mode" comment.
- Removed `bgmMode` argument from the `generate()` call.
- Removed the entire BGM mode selector block (label with Music icon, `<select>` with Runtime mix / Prerender / Off options).

MODIFIED — src/components/aria/audiobook-workspace.tsx (-3 lines):
- Removed `import { useBgmEngine } from "@/hooks/use-bgm-engine";`.
- Removed `useBgmEngine();` call + its 2-line "mixes background music in lockstep with the main audio..." comment.

MODIFIED — src/lib/audio-cache.ts (-1 word):
- Updated the module header comment from "Key shape: `${jobId}:${chapterIndex}` — same as transcript cache." to "Key shape: `${jobId}:${chapterIndex}`." (the transcript-cache module no longer exists, so the cross-reference was stale).

VERIFICATION:
- Verification grep (per task spec): `grep -rni "transcript\|bgm\|bgmEnabled\|bgmVolume\|toggleBgm\|showTranscript\|toggleTranscript\|TranscriptView\|wordSync\|word.sync\|audio-element-registry\|bgmCues\|bgm_cues\|BgmCue\|getBgmAssetUrl\|fetchBgmCues" src/ --include="*.ts" --include="*.tsx" --exclude-dir=node_modules` returns ONLY 4 unrelated matches in chat-conversation files (conversation-summary.ts uses `transcript` as a local var name for chat message text; conversations/[id]/export/route.ts has a comment about "human-readable transcript" for chat exports). These predate the audiobook transcript feature and refer to ARIA's chat workspace (a completely separate feature) — left untouched per the task's "chapter-summary is separate from transcript" guidance, which by analogy extends to conversation-summary.
- Tighter grep for audiobook-specific symbols (transcript_cues, has_transcript, bgm_mode, BgmCue, useBgmEngine, useWordSync, useBgmCuesStore, useTranscriptStore, setAudioElement, getAudioElement, etc.): ZERO_RESULTS.
- Dangling-import grep (any `from "@/lib/transcript-store"` etc.): NO_DANGLING_IMPORTS.
- `bun run lint`: PASSES (0 errors, 0 warnings).
- `npx tsc --noEmit` filtered for modified files: zero errors in player-store, abm-api, player-view, chapter-selector, audiobook-workspace, use-audio-engine, audio-cache (and no transcript/bgm-related errors anywhere).
- dev.log: caught the expected transient `Module not found: '@/hooks/use-bgm-engine'` immediately after deletion (before the workspace edit landed), then re-compiled cleanly — `✓ Compiled in 669ms` → `✓ Compiled in 309ms` → `✓ Compiled in 168ms` with `GET / 200 in 92ms`. Page loads fine.

Stage Summary:
Files deleted (7):
- src/components/aria/transcript-view.tsx
- src/lib/transcript-store.ts
- src/lib/transcript-cache.ts
- src/hooks/use-word-sync.ts
- src/lib/audio-element-registry.ts
- src/lib/bgm-cues-store.ts
- src/hooks/use-bgm-engine.ts

Files modified (7):
- src/lib/player-store.ts (-25 lines)
- src/lib/abm-api.ts (-58 lines)
- src/hooks/use-audio-engine.ts (-5 lines)
- src/components/aria/player-view.tsx (-65 lines)
- src/components/aria/chapter-selector.tsx (-22 lines)
- src/components/aria/audiobook-workspace.tsx (-3 lines)
- src/lib/audio-cache.ts (1 comment word)

CONSTRAINTS honored:
- Did NOT touch src/components/aria/epub-reader.tsx.
- Did NOT touch src/components/aria/chapter-summary-card.tsx.
- Did NOT touch any backend Python files (audiobook_app.py, generation_engine.py, bgm_*.py, etc.) — backend can keep its BGM/transcript code.
- Did NOT touch src/app/page.tsx.
- Did NOT touch player-view.tsx's audio playback logic (play/pause/seek/skip/transport/progress bar/chapter browser) — only removed transcript + BGM UI.
- Left the 4 unrelated "transcript" mentions in chat-workspace files alone (they refer to ARIA's chat conversation transcripts, not the audiobook synced-transcript feature being removed).
- No commented-out code left behind. No dead imports.

Git: commit + push to follow.

---
Task ID: 6
Agent: main (orchestrator)
Task: Save / sync all code done so far — user asked to "save this code as well what we have done till here"

Work Log:
- Ran `git status` → working tree clean, branch reported "up to date with origin/main" (stale local ref).
- Ran `git log --oneline -20` → confirmed prior BGM work was already committed in `efdbe8e feat: simple static BGM — 6 ambient genre loops + volume control` (player-view.tsx +108, player-store.ts +14).
- Verified BGM code present in files via grep:
    - src/lib/player-store.ts → bgmVolume, selectedTrack, toggleBgm, setBgmVolume, persistence in partialize
    - src/components/aria/player-view.tsx → BGM_TRACKS list, bgmVolume selector, volume slider, <audio loop> element
- Ran `git ls-remote origin main` → discovered remote HEAD = `19699fe` (1 commit AHEAD of local `efdbe8e`).
- Inspected remote commit `19699fe feat: add 6 ambient BGM genre audio loops for audiobook player` (Author: Vibhor Sharma) → adds public/bgm/{fantasy,scifi,mystery,romance,classic,adventure}.ogg + README.md (7 files, the audio assets the code commit was expecting).
- Ran `git fetch origin` → updated local origin/main ref to `19699fe`.
- Ran `git pull --ff-only origin main` → fast-forwarded local HEAD from `efdbe8e` to `19699fe`, pulled all 7 audio files cleanly (no conflicts, no merge commit).
- Verified post-sync: local HEAD = remote HEAD = `19699fe07b6194fedd210ea2dea6325f5f0415a8`, working tree clean, `public/bgm/` now contains all 6 .ogg files (1.3-3.1 MB each, ~12 MB total) + README.md.

Stage Summary:
- ALL prior work is now fully saved (committed + pushed) on both local and remote.
- Two commits make up the complete BGM feature:
    1. `efdbe8e` — code: player-store.ts state + player-view.tsx UI/audio element (122 lines added)
    2. `19699fe` — assets: 6 royalty-free ambient .ogg loops + README (the audio files referenced by BGM_TRACKS)
- Local and remote `main` are now identical at `19699fe`.
- Working tree clean — nothing to commit, nothing to push.
- The BGM feature is end-to-end complete: state persisted in localStorage, 6 genre loops selectable, volume slider 0-100% (default 30%), <audio loop> plays in sync with narration play/pause.
