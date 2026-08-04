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
