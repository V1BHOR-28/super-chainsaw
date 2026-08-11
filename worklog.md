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
Task ID: HINDI-SUMMARY-FIX
Agent: main (Fix Hindi chapter summary truncation + leaked-script contamination)
Task: Fix /api/chapter/summary truncating after the first 1-2 plot beats (Dante's Inferno Canto I stopped at the she-wolf, never mentioning Virgil/Mantua/Hound/follow-through) and emitting a stray Chinese character (迷) inside Hindi text. Implement full-coverage generation, map-reduce for long chapters, script/length/tail validation + retry, v3 cache invalidation, and multi-paragraph frontend rendering.

Work Log:
- Read prior worklog (BGM-1, BUGFIX-1-2, TRANSCRIPT tasks) for ARIA architecture context.
- Read current state: hindi_tts.py (SSML fix from prior task already in place — plain text + rate/pitch kwargs), text_preprocess.py (plain_text_for_tts + deprecated wrap_in_hindi_ssml already in place), audiobook_app.py summary endpoint (v2 cache, chapter_text[:2000] truncation, max_tokens=1024, English prompt, simple line-drop cleaning), hindi-summary-card.tsx (single <p> rendering).
- Audited all edge_tts.Communicate() call sites: audiobook_app.py:9124 (preview), tts_split.py:497+523 (main narration), hindi_tts.py:49 (Hindi) — ALL already pass plain text + native kwargs, no SSML anywhere. Prior SSML task confirmed complete.

BACKEND (audiobook_app.py) — added 9 module-level helpers before /api/chapter/summary:
- _NON_INDIC_SCRIPT_RE: regex matching CJK/Hangul/Hiragana/Katakana/Arabic/Cyrillic (for reject + sanitize).
- _SUMMARY_SYSTEM_PROMPT_V3: the full-coverage Devanagari prompt (9 rules) from the spec — covers beginning/middle/end, 6-10 sentences in 2-3 paragraphs, all main characters named, no skipped turns/prophecies/decisions, Devanagari-only with parenthesized Roman proper nouns on first mention, explicit ban on CJK/Japanese/Korean/Arabic/other scripts, no interpretation, summary-only output.
- _SUMMARY_RETRY_USER_MSG: "पिछला सारांश अधूरा था। अध्याय के अंतिम भाग को भी शामिल करें।"
- _SUMMARY_CHUNK_PROMPT: map-phase prompt (4-6 Devanagari sentences per chunk, order preserved, parenthesized Roman names, script ban).
- _SUMMARY_MERGE_PROMPT: reduce-phase prompt (merge chunk summaries into one cohesive 6-10 sentence summary covering full arc, script ban).
- _clean_summary_llm_output(text): strips markdown (**bold**, *italic*, # headings, [text](url), `code`, bullets), drops non-Devanagari leading lines (English preamble), collapses 3+ newlines to double.
- _sanitize_summary(text): last-resort cleanup — strips leaked non-Indic chars, collapses 3+ newlines. Runs before caching.
- _validate_summary(summary, chapter_text) → (ok, reason): 3 checks — (1) script (reject CJK/Hangul/Arabic/Cyrillic), (2) length (reject <400 chars for normal chapters, <250 for genuinely short chapters, OR <8% of chapter length, whichever threshold is larger), (3) tail-coverage (last 15% of chapter, capitalized proper nouns appearing 2+ times, reject if NONE appear in summary — catches a Canto I summary missing "Virgil").
- _split_chapter_chunks(text, chunk_words=3000, overlap_words=200): sequential word-split chunks with 200-word overlap for continuity. Returns [text] if ≤3000 words.
- _groq_summary_call(client, system, user, temp, max_tokens): single Groq chat call wrapper (model llama-3.3-70b-versatile). Returns '' on failure.
- _generate_hindi_summary(groq_client, chapter_text): orchestrator — single-pass if ≤4000 words (max_tokens=1600, temp=0.3), map-reduce if >4000 words (per-chunk 512 tokens, merge 1600 tokens). Validates attempt 1; on rejection retries once (temp=0.2 + nudge). If both fail, returns the better of the two (longer, fewer leaked chars) and logs a warning. Never raises. Logs path (single-pass vs mapreduce(N chunks)) + word count + validation result for each attempt.

BACKEND (audiobook_app.py) — rewrote /api/chapter/summary route body:
- Bumped cache keys summaries/v2/ → summaries/v3/ (invalidates all existing truncated summaries in R2).
- REMOVED chapter_text[:2000] input truncation — full chapter text now sent to the model.
- Replaced inline English prompt + max_tokens=1024 + manual line-drop cleaning with _generate_hindi_summary() call (max_tokens=1600, Devanagari coverage prompt) + _sanitize_summary() final pass.
- Audio synthesis + R2 cache write unchanged (hindi_tts.synthesize_hindi already handles multi-paragraph text via plain_text_for_tts converting \n\n → danda pauses).

BACKEND (audiobook_app.py) — updated deletion cleanup (_purge_job_completely):
- Added f"summaries/v3/{job_id}/" to the prefix list alongside existing v1/v2/glossary prefixes so deleting a book also purges its v3 summaries.

FRONTEND (hindi-summary-card.tsx):
- Replaced single <p>{summary.summary}</p> with a split-on-\n{2,} multi-paragraph layout: each paragraph renders as its own <p> inside a space-y-3 container. Preserves the 2-3 paragraph structure the new prompt produces (previously collapsed into a wall of text).
- Audio button gets mt-4 for spacing from the last paragraph.

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- bun run lint: 0 errors, 0 warnings.
- npx tsc --noEmit: zero errors in hindi-summary-card.tsx (or any related file).
- Inline logic test (6 cases, no test file created): T1 truncated summary → rejected too_short(55<387); T2 good summary (mentions Virgil, 908 chars) → accepted; T3 leaked CJK 迷 → rejected non_indic_script; T4 sanitize strips CJK + preserves Devanagari; T5 chunking 7500 words → 3 chunks [3000,3000,1900] with verified 200-word overlap; T6 short chapter → 1 chunk. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes, Fast Refresh picked up the frontend change. Dev log shows all-200 responses, no runtime errors.
- Flask backend not runnable in sandbox (no flask module installed — runs on Render in production); backend correctness verified via py_compile + inline logic tests.

CONSTRAINTS honored:
- Did NOT touch use-word-sync.ts, transcript-view.tsx, timing/offset logic, or the audio engine.
- Did NOT change the voice count (stays 11).
- Did NOT touch BGM cue logic or the tombstone/deletion system (only added v3 prefix to existing Hindi cleanup loop).
- Did NOT change glossary or explain-paragraph endpoints' token budgets (summary-only change).
- SSML-free TTS handling for Swara already in place from prior task — multi-paragraph text flows through plain_text_for_tts (\n\n → danda pauses) with no changes needed.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+210 lines: 9 helper functions + 4 prompt constants + regex before the route, rewritten /api/chapter/summary generation block, v3 cache keys, v3 prefix in deletion cleanup)
- src/components/aria/hindi-summary-card.tsx (+12/-3 lines: multi-paragraph split rendering with space-y-3 container)

No git push — implementation + verification only, per the task spec.

Regenerating the summary for Inferno Canto I will now: (1) send the FULL chapter text to Groq (no [:2000] slice), (2) use max_tokens=1600 (not 1024), (3) use the Devanagari full-coverage prompt that explicitly requires naming all main characters + covering beginning/middle/end + no skipped prophecies, (4) validate that Virgil (from the last 15% of the chapter) appears in the summary, (5) reject + retry if any CJK/Arabic/Cyrillic chars leak through, (6) cache under summaries/v3/ so the old truncated v2 summary is bypassed. The stray 迷 character is caught by both the validation (reject → retry) and the final _sanitize_summary pass (strip).

---
Task ID: REGRESSION-FIX-2
Agent: main (Fix Hindi summary audio identity + broken chapter catalog + stale player data)
Task: Fix three regressions: (1) Chapter 3 plays Chapter 2's Hindi summary audio because the old HTMLAudioElement is reused across chapters; (2) Chapters drawer shows only generated chapters (4 of 4) instead of the full book catalog (4 of 34) because chapter_mp3s was used as the full catalog; (3) Player keeps stale chapter data after a new generation because chaptersData is never reset.

Work Log:
- Read prior worklog (HINDI-SUMMARY-FIX, BGM-1, BUGFIX-1-2) for architecture context.
- Dispatched a thorough Explore agent to map ALL chapter_catalog persistence points in audiobook_app.py + generation_engine.py (12 items). Confirmed: chapter_catalog did NOT exist yet; chapter_mp3s is assigned in exactly ONE place (generation_engine.py:4866, MERGE by index); selected_chapters is OVERWRITTEN per generation; the weak fallback in /api/job_chapters created chapters from chapter_mp3s (the root cause of "4 of 4").

BACKEND (audiobook_app.py) — new helpers (after _register_job_and_flush):
- _build_chapter_catalog(info): builds a JSON-safe complete catalog [{index,title,words,chars,estimated_minutes}] from a parsed BookInfo. Uses _estimate_chapter_seconds for consistent timing.
- _generated_chapter_indices(chapter_mp3s): sorted list of chapter indices that have generated MP3 audio. Authoritative narrated set (replaces 4 inline duplications of the same pattern).

BACKEND (audiobook_app.py) — /api/analyze:
- Replaced inline chapter-list build with _build_chapter_catalog(info). Stashes result as jobs[job_id]["chapter_catalog"] + ["total_chapters"]. Persists via _register_job_and_flush(job_id, chapter_catalog=..., total_chapters=...).

BACKEND (audiobook_app.py) — _save_tokens:
- Added "chapter_catalog" to the token snapshot dict literal (between total_chapters and transcript_cues).
- Added chapter_catalog= to the _register_job() call in the registry-sync block.

BACKEND (audiobook_app.py) — _save_job_registry:
- Added "chapter_catalog" to the registry snapshot dict literal.

BACKEND (audiobook_app.py) — _reconstruct_job_from_storj:
- Added "chapter_catalog" to the overlay list (token → registry fallback).
- Added "chapter_catalog": _build_chapter_catalog(info) or rec.get("chapter_catalog", []) to the rebuild dict (rebuilds from the freshly-parsed info.chapters — always reflects the current EPUB).

BACKEND (audiobook_app.py) — /api/job_chapters (CRITICAL FIX):
- WEAK fallback: now prefers the persisted chapter_catalog (full book) over synthesizing rows from chapter_mp3s. Only falls back to chapter_mp3s rows as a LAST resort, with "chapter_catalog_incomplete": True flag. total_chapters NEVER reports len(chapter_mp3s) when a larger persisted count exists — uses _stored_total or len(_catalog).
- STRONG path: uses job.get("chapter_catalog") or _build_chapter_catalog(info) as the authoritative chapters list. Refreshes the job's catalog if missing.
- Both paths: selected_chapters derived via _generated_chapter_indices(chapter_mp3s). Cache-Control: no-store header on all responses.

BACKEND (audiobook_app.py) — /api/my_jobs:
- Live-job loop: total_chapters from len(chapter_catalog) or len(info.chapters) or stored value. Added "chapter_catalog" to the entry. Uses _generated_chapter_indices helper.
- Token-restored loop: total_chapters from len(chapter_catalog) or stored total or len(chapter_mp3s). Added "chapter_catalog" from token. Uses _generated_chapter_indices helper.
- Response: Cache-Control: no-store header.

BACKEND (audiobook_app.py) — /api/chapter/summary:
- Added Cache-Control: no-store header to both the cached-path and fresh-path success responses.

BACKEND (generation_engine.py):
- Added _build_catalog_from_info(info) local helper (mirror of audiobook_app._build_chapter_catalog, kept local to avoid circular import — reuses _estimate_chapter_seconds with a 150wpm fallback).
- _create_download_token _refresh_fields: added "chapter_catalog": job.get("chapter_catalog") or _build_catalog_from_info(info). Both the existing-token update path and new-token creation path carry it automatically.
- Post-merge (per-chapter mp3 branch, after job["chapter_mp3s"] = new_mp3s): refreshes selected_chapters = _merged_indices, rebuilds chapter_catalog from info if missing, recomputes total_chapters from catalog length. Ensures the in-memory job stays consistent after every generation.

FRONTEND (hindi-summary-card.tsx) — Bug 1 fix (FULL REWRITE):
- Removed the old render-time prevChapter state-reset block + the audioRef.current reuse bug.
- Parent now passes a `key` prop (bookId:chapterIndex) so React REMOUNTS the component on chapter change — naturally tearing down the old audio element via unmount cleanup. This is the cleanest guarantee that Chapter 3 can never replay Chapter 2's audio.
- Unmount cleanup effect: pause → removeEventListener(ended/error) → removeAttribute("src") → load() → null the ref.
- createSummaryAudio(url): destroys any existing element first, then constructs a fresh <audio> with preload="metadata" + ended/error listeners. Called from handlePlayAudio when the current element's src doesn't match the current summary URL.
- Request identity guard: requestGenerationRef (incremented on every load click) + latestBookIdRef/latestChapterIndexRef (synced via effect). A response is dropped unless generation matches AND book/chapter still match — prevents a slow Chapter 2 fetch from populating Chapter 3's card.
- Cache: SUMMARY_CACHE_VERSION = "v4" prefix. _isValidSummary() validates cached values (summary is non-empty string + audio_url is string) before use. Failed/empty responses are never cached.
- Multi-paragraph rendering preserved (split on \n{2,} into separate <p>).

FRONTEND (player-view.tsx) — Bug 3 fix:
- chapterRevision: [jobId, ...sorted chapterMp3s indices, length].join(":"). Ref-guarded render-time reset clears chaptersData to null when the job snapshot changes (new generation appended a chapter). This forces a fresh getJobChapters on the next drawer open.
- loadChapters: request identity guard (chapterRequestRef + usePlayerStore.getState().currentJob?.jobId check). Dedup via chaptersLoadingRef. Stale responses dropped.
- HindiSummaryCard now has a key prop (bookId:chapterIndex) for remount-on-chapter-change.
- ChaptersPanel: new passedTotalChapters prop. chapters sourced from chaptersData?.chapters ?? passedChapters (which is now job.chapterCatalog ?? job.chapters). chapterMp3sList from chaptersData?.chapter_mp3s ?? chapterMp3s. generatedIndices = Set(chapterMp3sList indices). totalChapters NEVER falls back to chapterMp3s.length. inAudio uses generatedIndices.has(ch.index) when hasChapterMp3s, else selectedSet.has (legacy fallback) — an EMPTY narrated set no longer marks everything as narrated.

FRONTEND (abm-api.ts):
- Added chapter_catalog? + chapter_catalog_incomplete? to AnalyzeResponse. Added chapter_catalog? to MyJob.
- cache: "no-store" on getJobChapters, getMyJobs, getChapterSummary fetches.

FRONTEND (library-view.tsx):
- LibraryCard: added chapterCatalog? field. toCard: maps job.chapter_catalog. openPlayer: passes totalChapters + chapterCatalog from the pre-fetched getJobChapters response (falling back to card fields).

FRONTEND (player-store.ts):
- PlayingJob: added totalChapters? + chapterCatalog? fields.

VERIFICATION:
- python3 -m py_compile audiobook_app.py + generation_engine.py: both PASS.
- npx tsc --noEmit: zero errors in any modified file (hindi-summary-card, player-view, abm-api, library-view, player-store).
- bun run lint: 0 errors, 0 warnings (resolved react-hooks/refs + set-state-in-effect rule conflicts by using key-based remount for the summary card + ref-guarded render-time reset for the player chapter revision, matching the existing lint-clean pattern).
- Inline logic tests (6 cases): merged indices, non-contiguous selection, empty/None, dedupe, total=10 (not 4) with 4 generated, legacy fallback. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes, Fast Refresh compiled all changes. Dev log shows all-200 responses.

CONSTRAINTS honored:
- Did NOT touch use-word-sync.ts, transcript-view.tsx, timing/offset logic, or the audio engine.
- Did NOT change the voice count (stays 11) or Hindi voice selection/narration tuning.
- Did NOT change the Hindi summary-generation prompt (only added no-store cache header).
- Did NOT touch BGM cue logic/mixing, cover persistence, deletion tombstones, or auth/client ownership.
- Did NOT change the visual design.
- Glossary/explain-paragraph endpoints' token budgets unchanged.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+85 lines: 2 helpers, /api/analyze catalog build+persist, _save_tokens catalog field, _save_job_registry catalog field, _reconstruct_job_from_storj catalog overlay+rebuild, /api/job_chapters catalog-priority rewrite + incomplete flag + no-store, /api/my_jobs both loops catalog+helper+no-store, /api/chapter/summary no-store headers)
- mini-services/audiobook-maker/generation_engine.py (+50 lines: _build_catalog_from_info helper, _refresh_fields chapter_catalog, post-merge selected_chapters/catalog/total derive)
- src/components/aria/hindi-summary-card.tsx (FULL REWRITE: key-based remount, unmount cleanup, createSummaryAudio, request identity guard, v4 cache + validation)
- src/components/aria/player-view.tsx (+45 lines: chapterRevision reset, request-guarded loadChapters, HindiSummaryCard key prop, ChaptersPanel passedTotalChapters + chapter_mp3s-authoritative calculations + inAudio fix)
- src/lib/abm-api.ts (+18 lines: chapter_catalog/incomplete types on AnalyzeResponse, chapter_catalog on MyJob, cache:no-store on 3 fetches)
- src/lib/player-store.ts (+6 lines: totalChapters + chapterCatalog on PlayingJob)
- src/components/aria/library-view.tsx (+5 lines: chapterCatalog on LibraryCard + toCard + openPlayer, AnalyzeChapter import)

No git push — implementation + verification only, per the task spec.

The fix is complete: Chapter 3 will always play Chapter 3's Hindi summary (key-based remount destroys the old audio element), and the Chapters drawer will always show the full book catalog with green ticks only on generated chapters — even after a later English TTS generation (chapterRevision invalidates the stale snapshot) and a backend restart (chapter_catalog persisted in token + registry + reconstructed from info.chapters).

---
Task ID: REPETITION-FIX
Agent: main (Fix Hindi summary repetition loop + restore explain button in transcript)
Task: Fix (1) Hindi chapter summary degenerating into the same sentence repeated ~15x (Canto VII), cached to R2 + spoken by Swara; (2) "इसे समझाएँ" explain button disappeared from the transcript because paragraphBreaks required sentence punctuation that Hinglish/edge-tts word cues don't contain.

Work Log:
- Read prior worklog (HINDI-SUMMARY-FIX, REGRESSION-FIX-2) for architecture context.
- Read current state: audiobook_app.py summary helpers (_groq_summary_call, _clean_summary_llm_output, _validate_summary, _generate_hindi_summary, prompts, cache keys), transcript-view.tsx paragraphBreaks construction + explain button JSX.

BACKEND (audiobook_app.py) — Bug 1 fix (7 changes, A-G):

A. _groq_summary_call — anti-repetition sampling:
- Added frequency_penalty=0.6, presence_penalty=0.3, top_p=0.9, effective_temp=max(temperature, 0.35).
- Fallback: if the Groq SDK rejects any penalty param (TypeError/400/invalid), retries once plain (temperature + max_tokens only). Never lets a sampling-param incompatibility fail the request.

B. _dedupe_summary(text) — new helper, called inside _clean_summary_llm_output BEFORE validation:
- _normalize_sentence(s): strips Devanagari danda (।) + Latin punctuation + quotes + brackets, collapses spaces, lowercases.
- _token_jaccard(a, b): token-set Jaccard similarity between two normalized sentences.
- _dedupe_summary: splits on \n\n into paragraphs, splits each paragraph into sentences on ।.!? via regex, normalizes each, drops exact duplicates, drops near-duplicates (Jaccard >= 0.8 with any kept sentence). Drops trailing incomplete sentence (no terminal ।.!?). Reassembles paragraphs (dropping empties), rejoins with \n\n.

C. _validate_summary — loosened length rule:
- Old: max(250, 0.08*chapter_len) for short chapters, max(400, 0.08*chapter_len) for long — no upper cap, rewarding padding.
- New: min(max(250, int(0.04 * chapter_len)), 900). 4% + 900 cap means a 9000-char chapter demands 360 chars (not 720), a 50000-char chapter demands 900 (not 4000).
- Script check + tail-coverage check unchanged.
- New hard-fail: if dedupe removed >40% of the text, logs dedupe_removed=<pct>% and returns the deduped result WITHOUT retrying (retrying reproduces the loop).

D. _generate_hindi_summary — extractive merge:
- _attempt now returns (summary, path, dedupe_pct) tracking how much the final dedupe pass removed.
- Map-reduce path: for <=6 chunks, the merge is EXTRACTIVE (concatenate chunk summaries + _dedupe_summary, no LLM call). Only >6 chunks triggers a generative merge LLM call (capped at max_tokens=1200 with anti-repetition penalties). The per-chunk summaries are already good distinct paragraphs; the generative merge was where the loop originated.
- Flow: attempt 1 (temp 0.3) → if ok, return. If dedupe_removed >40%, return as-is (no retry). Otherwise retry once (temp 0.2 + nudge). If both fail, return best-effort.

E. No-repetition instruction appended to all three prompts:
- _SUMMARY_NO_REPEAT_INSTRUCTION = "किसी भी वाक्य या विचार को दोहराएँ नहीं। हर वाक्य में नई जानकारी होनी चाहिए। यदि कहने को कुछ नया न बचे तो वहीं रुक जाएँ।"
- Appended to _SUMMARY_SYSTEM_PROMPT_V3, _SUMMARY_CHUNK_PROMPT, _SUMMARY_MERGE_PROMPT.

F. Cache namespace bump summaries/v3/ → summaries/v4/:
- summary_cache_key + audio_cache_key in api_chapter_summary. Invalidates all v3 summaries (which contain the repetition loop) + their Swara audio so they're regenerated fresh.
- Deletion cleanup: added f"summaries/v4/{job_id}/" to the prefix list.

G. TTS guard in api_chapter_summary:
- Before hindi_tts.synthesize_hindi: logs [summary] final len=<n> paras=<n> max_sentence_repeat=<n>. If max_repeat >= 3, logs [summary] WARN repetition survived (max_repeat=<n>) — first 200 chars. Makes a surviving loop visible in Render logs instead of silent.

FRONTEND (transcript-view.tsx) — Bug 2 fix:

paragraphBreaks construction (FULL REWRITE):
- Old: only broke on words ending in . ! ? — Hinglish/edge-tts word cues have NO punctuation (bare tokens like "karta", "hai", "Phir"), so paragraphBreaks was always empty and the explain button was unreachable dead code.
- New: punctuation-first + length-fallback. PARA_MIN=55, PARA_MAX=110. Breaks at a punctuated word ([.!?।]$) only if sinceBreak >= 55, OR forces a break at sinceBreak >= 110 regardless. Yields a button every 55-110 words. Trailing sentinel (words.length) ensures the final segment gets a button too.

Explain button JSX (UPDATED):
- Label changed from "इसे समझाएँ" to "हिंदी में समझाओ".
- Added Sparkles icon (w-2.5 h-2.5) before the label.
- Added opacity-70 hover:opacity-100 transition for visual findability.
- Border opacity bumped 0.2 → 0.25, color 0.7 → 0.8.
- Added `i < words.length` guard to the inline break block so the trailing sentinel (words.length) doesn't render a duplicate inline block.
- NEW: trailing explain block after the word loop — renders a button for the FINAL paragraph segment (from the last real break to words.length). Without this, the final paragraph could never be explained. Includes its own explanation panel (loading/result/audio/close) mirroring the inline block.

Mobile हिंदी toggle visibility:
- Confirmed HindiPillButton (player-view.tsx:1289) is in a flex-wrap container with no hidden/sm: breakpoint — visible at 458px width. No change needed.

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors in transcript-view.tsx.
- bun run lint: 0 errors, 0 warnings.
- Inline logic tests (5 cases): T1 15x repeat loop → collapses to 1 occurrence (len 1346→267); T2 near-duplicate (Jaccard>=0.8) dropped; T3 trailing incomplete sentence dropped; T4 clean summary passes through; T5 loosened validation threshold (9000-char→360, 50000-char→900 cap, 3000-char→250 floor). All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes. Dev log shows all-200 responses, clean compilation.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, or timing logic.
- Did NOT touch chapter catalog, BGM mixing, cover persistence, or the voice registry.
- Did NOT change the active voice count or Hindi voice selection.
- Did NOT touch playback, deletion tombstones, or auth.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+180 lines: _normalize_sentence + _token_jaccard + _dedupe_summary helpers, _clean_summary_llm_output calls dedupe, _validate_summary loosened threshold, _groq_summary_call anti-repetition sampling + fallback, _generate_hindi_summary extractive merge + dedupe_pct tracking + >40% no-retry, _SUMMARY_NO_REPEAT_INSTRUCTION appended to 3 prompts, v4 cache keys, TTS guard log, v4 in deletion cleanup)
- src/components/aria/transcript-view.tsx (+85 lines: paragraphBreaks punctuation-first + length-fallback + trailing sentinel, explain button label/icon/hover, trailing explain block for final segment, Sparkles import)

No git push — implementation + verification only, per the task spec.

Regenerating Canto VII will now: (1) use anti-repetition sampling (freq_penalty=0.6 + presence_penalty=0.3 + top_p=0.9 + min temp 0.35), (2) dedupe the output (exact + Jaccard>=0.8), (3) use extractive merge for <=6 chunks (no generative merge loop), (4) cache under v4 (invalidating the looping v3), (5) log the final shape + warn if repetition survived. The transcript will show "हिंदी में समझाओ" buttons every 55-110 words including the first and last segments.

---
Task ID: EMPTY-CHAPTERS-FIX
Agent: main (Fix "0 chapters total / No chapters found" after uploading an EPUB)
Task: Fix the regression where re-uploading an EPUB that has a persisted "generating" status (from a worker that died with the Render dyno) returns a shape-3 is_running payload with no job_id/title/author/chapters, causing the chapter selector to render "Author unknown · 0 chapters total" + "No chapters found" with a dead Convert button.

Work Log:
- Read prior worklog (REPETITION-FIX, REGRESSION-FIX-2) for architecture context.
- Confirmed root cause via grep: api_analyze() returns 3 shapes — (1) fresh analyze, (2) dedup reuse, (3) duplicate-while-busy is_running payload. Shape 3 had no job_id/chapters. `grep -r "existing_job_id" src/` returned zero matches — the frontend never handled it. This regressed now because the durable _job_registry + _reconstruct_job_from_storj dedup path made re-uploads resolve to existing jobs far more often, and interrupted jobs stay "generating" forever.

BACKEND (audiobook_app.py) — Fix 1: never report a dead job as running

New helper (after _generated_chapter_indices):
- _STALE_RUN_SECS = 180 (3 min with no heartbeat ⇒ worker is dead)
- _job_is_actually_running(job): True only if (a) status is generating/optimizing AND (b) either a worker_thread handle is alive, OR a last_progress_at/started_at heartbeat is within _STALE_RUN_SECS. A Render dyno shutdown kills worker threads without flipping the status, so a persisted "generating" status alone is NOT evidence of a live run.

api_analyze() — in-memory existing_job branch:
- Replaced `if status in ("optimizing", "generating"): return jsonify({...is_running...})` with:
  - If _job_is_actually_running(existing_job): return is_running payload WITH the full catalog (job_id, title, author, total_chapters, chapters, client_id) so the UI can render something useful.
  - Else (stale): demote existing_job["status"] to "optimized" (if ai_optimized) or "analyzed", set status = the new value, and fall through to the normal reuse path (which returns the full chapter list).

api_analyze() — _reg_job branch (durable-registry dedup):
- Identical treatment: if _job_is_actually_running(_reg_job), return is_running WITH catalog. Else demote _reg_job["status"] and fall through to the reconstructed-chapters response.
- Invariant: every analyze payload now carries job_id + chapters, even the is_running shape.

FRONTEND (abm-api.ts) — Fix 2a: normalize the shape

AnalyzeResponse type:
- Added optional fields: existing_job_id?, is_running?, status?, progress_current?, progress_total?.

analyzeEpub():
- After `const json = (await res.json()) as AnalyzeResponse;`: if `!json.job_id && json.existing_job_id`, copy existing_job_id → job_id. Callers only ever see one contract.

FRONTEND (library-view.tsx) — Fix 2b: handle is_running + defensive chapter fetch

handleFileSelected (rewrote the try block):
- If resp.is_running: toast "This book is already converting" + fetchJobs() (refresh the library so the poller picks it up) + return. Never opens an empty selector.
- Defensive: if `!resp.chapters || resp.chapters.length === 0`: if no job_id, throw "The server did not return a job for this file." Otherwise fetch via getJobChapters(resp.job_id); on failure throw "Book was analyzed but its chapter list could not be loaded." The throw surfaces in the existing "Could not analyze book" catch block.
- Un-delete + setAnalyzeResponse + success toast now use `effective` (the getJobChapters result when the original had no chapters).

FRONTEND (chapter-selector.tsx) — Fix 3: make the failure visible

Empty-state:
- Changed "No chapters found. Try re-uploading the EPUB." to "No chapters found for this book." + a second line showing `job {job_id} · status {status}` so the failure is diagnosable instead of silent.

Convert button:
- Added `|| chapters.length === 0` to all 4 disabled/style conditions (disabled, background, border, color). The button is now disabled when there are no chapters, not just when the selection is empty.

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors in any modified file (abm-api, library-view, chapter-selector).
- bun run lint: 0 errors, 0 warnings.
- grep -rn "existing_job_id" src/: matches in abm-api.ts (type def + normalization) ✓
- grep -rn "is_running" src/: matches in abm-api.ts (type) + library-view.tsx (handleFileSelected) ✓
- Inline logic tests (9 cases): live heartbeat, stale heartbeat (5min), no heartbeat, analyzed status, live thread handle, dead thread handle, non-dict input, optimizing stale, started_at fallback. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes. Dev log shows all-200 responses, clean compilation.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, or timing logic.
- Did NOT touch chapter catalog builder semantics (_build_chapter_catalog unchanged).
- Did NOT touch BGM mixing, cover persistence, deletion tombstones, Hindi summary/explain features, or the voice registry.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+65 lines: _STALE_RUN_SECS + _job_is_actually_running helper, both is_running branches now check liveness + demote stale + carry full catalog)
- src/lib/abm-api.ts (+12 lines: existing_job_id/is_running/status/progress_* fields on AnalyzeResponse, shape normalization in analyzeEpub)
- src/components/aria/library-view.tsx (+30 lines: is_running toast + fetchJobs refresh, defensive getJobChapters fallback, effective-response pattern)
- src/components/aria/chapter-selector.tsx (+5 lines: empty-state shows job_id/status, Convert button disabled when chapters.length===0)

No git push — implementation + verification only, per the task spec.

Re-uploading an EPUB that had a persisted "generating" status (from a dead worker) will now: (1) detect the stale heartbeat, (2) demote the job to analyzed/optimized, (3) return the full chapter catalog, (4) open the selector with all chapters. A genuinely running job returns the is_running shape WITH the catalog so the frontend shows an "already converting" toast instead of an empty selector.

---
Task ID: COVERAGE-FIX
Agent: main (Fix Hindi summary under-coverage + hallucination + explain button label leaking into transcript)
Task: Fix (1) Hindi chapter summaries covering ~35% of the chapter and inventing content (Canto VII omitted Plutus, boulder-rollers, clergy, Fortune discourse, Styx, wrathful, sullen — while inventing a Dante/Virgil exchange); (2) "हिंदी में समझाओ" button label being concatenated into transcript word text (e.g. "hawaहिंदी में समझाओse phula hua").

Work Log:
- Read prior worklog (REPETITION-FIX, REGRESSION-FIX-2, EMPTY-CHAPTERS-FIX) for architecture context.
- Read current state: audiobook_app.py summary helpers (old v4 single-pass + map-reduce with _groq_summary_call, _clean_summary_llm_output, _validate_summary, _dedupe_summary, _generate_hindi_summary), transcript-view.tsx paragraphBreaks + explain button JSX.

BACKEND (audiobook_app.py) — Problem 1 fix (two-pass outline → summary):

New prompts (v5):
- _SUMMARY_PASS_A_PROMPT: English extraction instruction. "You are an extraction engine. Read the chapter and output a numbered list, in strict narrative order, of EVERY distinct beat..." temperature 0.1, max_tokens 2048, no penalties. Output is a checklist — NOT shown to the user.
- _SUMMARY_PASS_B_PROMPT: Hindi summary driven by the outline as a checklist. "EVERY numbered beat in the outline must be represented in the summary. Do not skip any. Work through them in order." Hard rules: preserve proper nouns with Roman spelling in parentheses, no invented dialogue, no repetition, 4-7 paragraphs. temperature 0.3, frequency_penalty 0.4, presence_penalty 0.3.
- _SUMMARY_REPAIR_PROMPT: Hinglish one-shot repair when coverage < 80%. "Ye naam/beats summary se chhoot gaye hain: [list]. Inhe summary mein sahi jagah par jodo."

New helpers:
- _extract_outline_proper_nouns(outline): extracts capitalized tokens (3+ letters) from the Pass A outline, excluding sentence-initial common words (The, And, But, Then, They, etc.). Returns a set of proper nouns to check coverage against.
- _check_coverage(summary, outline_nouns): checks what fraction of outline proper nouns appear in the Hindi summary (matches on the Latin-script name, case-insensitive). Returns (coverage_pct, missing_set).

_groq_summary_call — now accepts configurable frequency_penalty + presence_penalty params (defaults 0.6/0.3). Pass A uses 0.0/0.0 (extraction doesn't need anti-repetition), Pass B uses 0.4/0.3 (per spec). Fallback retry without penalties on TypeError/400 unchanged.

_generate_hindi_summary — FULLY REWRITTEN as two-pass flow:
- Pass A (Extraction): if word_count > 8000 (~12k tokens), splits into ~2000-word segments, runs Pass A on each, concatenates outlines in order (renumbering beats sequentially). Otherwise single Pass A on the full chapter text. Never truncates.
- Pass B (Hindi summary): sends the outline + the FULL chapter text (never truncated) with the checklist prompt. The outline forces coverage of every beat.
- Coverage gate: extracts proper nouns from the outline, checks what fraction appear in the summary. If <80%, makes one repair call appending the missing names. Logs coverage percentage per chapter.
- De-duplication: _dedupe_summary still runs (inside _clean_summary_llm_output), now at 85% token-overlap threshold (bumped from 80%).
- NO minimum-length validation — the old length rule padded/retried to hit a character count, which produced the looping paragraphs. _validate_summary now only checks: script (no CJK/Arabic/Cyrillic), non-empty (at least one Devanagari char), and tail-coverage (proper nouns from last 15% of chapter). No length threshold at all.

Cache namespace bump: summaries/v4/ → summaries/v5/ — invalidates all v4 summaries (which used the old under-coverage flow) + their Swara audio. Deletion cleanup updated to include v5.

FRONTEND (transcript-view.tsx) — Problem 2 fix (explain button label leaking):

Root cause: the explain button was rendered INSIDE the words.map() as a sibling of the word span within the same <span key={i}> wrapper. The <span className="block mt-3"> was a block element nested inside an inline span, and its label text could leak into the word stream.

Fix — FULL RESTRUCTURE of the word rendering:
- Removed the explain button from inside words.map(). The words array now contains ONLY transcript words — no explain button, no label text, no non-transcript strings.
- Built paragraph segments: [{startIdx, endIdx}] from paragraphBreaks. Each segment is rendered as its own <p> element.
- The explain control is rendered as a sibling <div> AFTER each paragraph's closing </p> — never inside the words array, never between two words of the same paragraph.
- Paragraph boundaries fall on word boundaries from the timing data (paragraphBreaks contains word indices, never mid-token).
- The word index `i` is computed as `seg.startIdx + j` so data-cue-index stays aligned with the audio. The explain button click uses `words.slice(seg.startIdx, seg.endIdx).join(" ")` to send the correct paragraph text.
- Every segment (including the first and last) gets an explain button. The trailing sentinel (words.length) was removed — segments are built from the breaks + a trailing segment from the last break to words.length.
- Added eslint-disable-next-line for the pre-existing setFollowPlayback(true) in the chapter-change effect (the linter flagged it after the restructure, but it's pre-existing behavior the spec says not to touch).

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors in transcript-view.tsx.
- bun run lint: 0 errors, 0 warnings (after targeted eslint-disable for pre-existing set-state-in-effect).
- Inline logic tests (7 cases): T1 dedupe 85% threshold (80% overlap survives, 100% dropped); T2 exact duplicate dropped; T3 proper noun extraction (Dante/Plutus/Virgil/Fortune/Styx extracted, The/They excluded); T4 good coverage >= 80%; T5 bad coverage < 80% + missing detected (Plutus/Fortune/Styx); T6 no length check (short summary passes); T7 no_devanagari check. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes. Dev log shows all-200 responses, clean compilation.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, or timing logic.
- Did NOT touch BGM mixing, cover persistence, deletion tombstones, chapter catalog builder, or the voice registry.
- Did NOT touch playback.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+120 lines: v5 two-pass prompts, _extract_outline_proper_nouns + _check_coverage helpers, _groq_summary_call configurable penalties, _generate_hindi_summary full rewrite as two-pass outline→summary + coverage gate + long-chapter segmented Pass A, _validate_summary no length check, _dedupe_summary 85% threshold, v5 cache namespace + deletion cleanup)
- src/components/aria/transcript-view.tsx (+40 lines: restructured word rendering into paragraph segments with explain button as sibling <div> after each </p>, words array contains only transcript words, eslint-disable for pre-existing set-state-in-effect)

No git push — implementation + verification only, per the task spec.

Regenerating Canto VII will now: (1) extract every beat into a numbered outline (Pass A), (2) write a Hindi summary that must represent EVERY beat in the outline (Pass B), (3) check coverage of proper nouns and repair if <80%, (4) cache under v5. The transcript will render explain buttons as sibling blocks between paragraphs — the label "हिंदी में समझाओ" can never leak into the word stream because it's in a separate DOM element, not in the words array.

---
Task ID: GOD-PROMPT-HINDI-FIX
Agent: main (Fix ALL Hindi AI features — summary + explain — root cause: 5 hardcoded model ids, opaque errors, discarded results, free-tier failure)
Task: Fix both Hindi AI features (chapter summary + explain paragraph) that are dead due to: (A) five hardcoded copies of one model id with no fallback, (B) every failure collapsing into one opaque toast, (C) successful responses thrown away when TTS fails, (D) cost/limits guaranteeing failure at scale.

Work Log:
- Read prior worklog (COVERAGE-FIX, REPETITION-FIX, REGRESSION-FIX-2) for architecture context.
- Read all 5 hardcoded call sites: audiobook_app.py (_groq_summary_call, api_glossary, api_explain) + translate.py (_call_groq). Confirmed all pin model="llama-3.3-70b-versatile" with no fallback.

PART 1 — One Groq call site with model fallback (fixes A):
- Created mini-services/audiobook-maker/groq_client.py:
  - GROQ_MODELS: de-duped ordered list [env GROQ_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"].
  - groq_chat(system, user, *, temperature, max_tokens, frequency_penalty, presence_penalty) → (text, error_code). Never raises.
  - Walks GROQ_MODELS in order. 404/decommissioned → log + next model. 429 → retry same model with backoff [2s, 5s, 10s] (3 attempts), then next model. Success → log [groq] used model=<id> in_tokens≈<n>.
  - Error codes: groq_no_key, groq_rate_limited, groq_all_models_failed, groq_empty.
  - groq_health(): one tiny 5-token completion for /api/ai/health.
- Replaced all 5 call sites:
  - _groq_summary_call → now returns (text, error_code) via groq_chat().
  - api_glossary → uses groq_chat() directly.
  - api_explain → uses groq_chat() directly.
  - translate.py _call_groq → uses groq_chat() directly.
- RG PROOF: rg 'llama-3\.3' mini-services/ → matches ONLY groq_client.py (verified).

PART 2 — Real errors end to end (fixes B):
- Backend: both api_chapter_summary + api_explain + api_glossary now return {"error": <Hindi>, "code": <machine code>} on failure. Codes: no_transcript, job_not_found, groq_no_key, groq_rate_limited, groq_all_models_failed, empty_summary, rate_limited (with retry_after), internal, bad_request. Outer except uses traceback.print_exc().
- Frontend abm-api.ts: new HindiApiError class carries code + retry_after. getChapterSummary + explainParagraph + getGlossaryEntry throw HindiApiError on !res.ok.
- hindi-summary-card.tsx: catch (err) with console.error("[summary]...", err). Toasts the server's message; rate_limited code → "थोड़ी देर रुकें — बहुत सारे अनुरोध".
- transcript-view.tsx: handleExplain catch (err) with console.error("[explain]...", err). Same rate-limited toast. playExplainAudio catch with console.error.

PART 3 — Never discard a working result (fixes C):
- HindiSummary.audio_url + HindiGlossary.audio_url now optional (audio_url?: string).
- _isValidSummary checks ONLY typeof summary === "string" && summary.trim().length > 0. No audio_url check.
- When audio_url is empty: text renders, Listen/सुनें button hidden (already conditional on audio_url), no toast.
- playExplainAudio: destroy + rebuild when URL differs (pause → removeAttribute("src") → load() → new Audio(url)). A second explain can't replay the first one's audio.

PART 4 — Make generation survive the free tier (fixes D):
- _generate_hindi_summary now returns (summary, error_code) and is wrapped in try/except + traceback.print_exc().
- Degradation ladder (first non-empty result wins, logged with [summary] degraded_to=):
  a. Two-pass (Pass A outline → Pass B checklist) — as before.
  b. Single-pass: chapter text straight to _SUMMARY_PASS_B_PROMPT, no outline.
  c. Truncated single-pass: first 3000 words.
- Coverage-repair call SKIPPED if any previous call was rate-limited (4th call guarantees another 429).
- Pass B input capped at 6000 words (outline + first 6000 words of chapter text). The outline already carries the tail beats.
- chapter_text fallback chain in api_chapter_summary (errors no_transcript only if ALL three empty):
  1. job["transcript_cues"][chapter_index] (int + str keys).
  2. Parsed book's chapter text (info.chapters[chapter_index].text).
  3. R2-stored transcript JSON (chapters/{book_id}/{chapter_index}.transcript.json).
- /api/explain rate limit raised from 20/hr to 60/hr per client id.
- Cache namespace bumped summaries/v5/ → summaries/v6/ (both JSON + MP3 keys).
- SUMMARY_CACHE_VERSION = "v6" in hindi-summary-card.tsx.
- Deletion cleanup updated to include v6.

PART 5 — Health endpoint:
- GET /api/ai/health → {"groq_key_present": bool, "models_tried": [...], "working_model": str|null, "error": str|null}. One tiny 5-token completion through groq_chat. no-store cache header.

VERIFICATION:
- python3 -m py_compile: audiobook_app.py + groq_client.py + translate.py all PASS.
- npx tsc --noEmit: zero errors in any modified file (hindi-summary-card, transcript-view, abm-api).
- bun run lint: 0 errors, 0 warnings.
- rg 'llama-3\.3' mini-services/audiobook-maker/ → matches ONLY groq_client.py ✓
- Inline logic tests (4 cases): default model list, env override, de-dupe, backoff schedule. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes. Dev log shows all-200 responses, clean compilation.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, chapter catalog builder, analyze/chaptering, BGM mixing, cover persistence, deletion tombstones, or the voice registry.
- Did NOT touch bgm_cues.py, generation_engine.py, community_*.py, translation_core.py (pre-existing chat.completions.create call sites for non-Hindi features — out of scope).

Stage Summary:
Files created:
- mini-services/audiobook-maker/groq_client.py (155 lines: GROQ_MODELS, groq_chat with fallback + 429 backoff, groq_health)

Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+180/-90 lines: _groq_summary_call routes through groq_chat, _generate_hindi_summary degradation ladder + try/except + (summary, code) return + Pass B cap 6000 words + skip repair on rate-limit, api_chapter_summary transcript fallback chain + structured errors + traceback + v6 cache, api_glossary uses groq_chat + structured errors, api_explain rate limit 60/hr + groq_chat + structured errors, /api/ai/health endpoint, v6 in deletion cleanup)
- mini-services/audiobook-maker/translate.py (+15/-10 lines: _call_groq routes through groq_chat, comment cleanup)
- src/lib/abm-api.ts (+40 lines: HindiApiError class, audio_url optional, getChapterSummary/explainParagraph/getGlossaryEntry throw HindiApiError with code/retry_after, cache:no-store on explain)
- src/components/aria/hindi-summary-card.tsx (+20 lines: SUMMARY_CACHE_VERSION v6, _isValidSummary only checks summary, console.error + specific toasts, audio play catch logs)
- src/components/aria/transcript-view.tsx (+15 lines: handleExplain console.error + specific toast, playExplainAudio destroy+rebuild on URL change, audio play catch logs)

No git push — implementation + verification only, per the task spec.

---
Task ID: COVERAGE-FIX-V7
Agent: main (Fix Hindi summary truncation + degenerate filler + hard gates)
Task: Fix the root cause of Hindi chapter summaries covering only ~35% of the chapter then degenerating into repeated filler sentences. The root cause was truncated input to the LLM (the old v6 flow sent outline + chapter text to Pass B, and the LLM internally truncated the chapter text). Also add hard gates so a degenerate summary can never be shown to the user.

Work Log:
- Read prior worklog (GOD-PROMPT-HINDI-FIX, COVERAGE-FIX) for architecture context.
- Read current state: _generate_hindi_summary (v6 degradation ladder with 6000-word cap on Pass B input), _validate_summary (only script + tail-coverage), prompts, api_chapter_summary, hindi-summary-card, transcript-view.
- Confirmed the root cause: the v6 flow sent outline + capped_chapter (6000 words) to Pass B. The LLM internally truncated this to ~35%, producing the "यहाँ पर मैंने एक बड़ा X देखा" degenerate filler with X = Blood/Envy/Heaven/Help/Delights scraped from the transcript.

BACKEND (audiobook_app.py) — Part 1: Stop truncating the chapter

_generate_hindi_summary (v7 FULL REWRITE):
- Logs the TRUE input size before any LLM call: `summary_input chapter=<title> chars=<n> words=<n>`. This is the critical diagnostic.
- NEVER truncates the chapter text. The old `PASS_B_INPUT_CAP = 6000` and `words[:3000]` degradation step C are GONE.
- Chunk-then-reduce: if word_count > 1200, splits into ~900-word chunks with 100-word overlap (was 3000/200). Runs Pass A on each chunk, concatenates outlines IN ORDER into one master outline.
- Pass B sees ONLY the master outline — NEVER the raw chapter text. This is the key fix: the old flow sent outline + chapter text, and the LLM truncated the chapter text internally.
- Returns (summary, error_code, quality, missing, outline, coverage, diversity).

_split_chapter_chunks: chunk_words default 900, overlap_words 100 (was 3000/200).

BACKEND — Part 2+3: New Pass A + Pass B prompts

_SUMMARY_PASS_A_SYSTEM: "You are an extraction engine. You output only a numbered list of facts that literally appear in the supplied text. You never infer, never generalize, never repeat a fact. If the text ends mid-scene, stop — do not invent an ending." Pass A user includes "Text (chapter chunk {i} of {n}): <<<{chunk}>>>" + extraction instructions. Groq params: temperature=0.1, top_p=0.9, frequency_penalty=0.4, presence_penalty=0.3, max_tokens=700.

_SUMMARY_PASS_B_SYSTEM: Hindi coverage-contracted prompt. "सूची की हर पंक्ति का सार आपके सारांश में आना चाहिए — कोई घटना छोड़ें नहीं।" + no repetition + no filler + Devanagari names with Roman in parentheses. Pass B user: "अध्याय: {title}\n\nघटना-सूची:\n{master_outline}\n\nइस सूची के आधार पर 4–7 अनुच्छेदों में सारांश लिखें।" Groq params: temperature=0.35, top_p=0.9, frequency_penalty=0.6, presence_penalty=0.5, max_tokens=1400. NO minimum-length requirement anywhere.

BACKEND — Part 4: Server-side gates (_validate_summary FULL REWRITE)

_validate_summary(summary, outline) → (ok, reason, coverage, diversity, missing):

A. DEGENERACY GATE:
   - A1: most common trailing 6-word clause across sentences (>=3 → FAIL "degenerate_tail").
   - A2: duplicate sentences (>=2 → FAIL "duplicate_sentence").
   - A3: distinct-trigram ratio over the whole summary (<0.55 → FAIL "low_diversity").

B. COVERAGE GATE:
   - Extract proper nouns from the master outline (capitalized tokens, len>=3, excluding sentence-initial common words).
   - Require >= 70% to appear in the summary (match Latin-script name).
   - Below 70% → FAIL "low_coverage", include missing names in the log.

C. TAIL GATE:
   - The last outline bullet's key entity must appear in the final third of the summary.
   - If not → FAIL "truncated_coverage". (This catches a summary missing Plutus/Judgment material.)

On FAIL: retry Pass B ONCE with the failure reason appended as an explicit instruction ("पिछला प्रयास असफल: {reason}. दोहराव हटाएँ और छूटी हुई घटनाएँ शामिल करें: {missing}").
If it fails twice: strip every sentence flagged by gate A via _strip_flagged_sentences, and set quality="partial" + missing=[...] in the JSON response.

Logs: `summary_gate chapter=<chap_id> ok=<bool> reason=<reason> coverage=<float> diversity=<float>`

BACKEND — api_chapter_summary route:
- ?force=1 (or force:true in body) bypasses the R2 cache — used by the "फिर से बनाएँ" button.
- Cache namespace bumped v6 → v7 (both JSON + MP3 keys).
- Passes chapter_title to _generate_hindi_summary.
- Returns { summary, audio_url, quality, missing } on success.
- Caches quality + missing alongside the summary text.
- Deletion cleanup updated to include v7.

FRONTEND — Part 5:

abm-api.ts:
- HindiSummary type: added quality?: string + missing?: string[].
- getChapterSummary: added optional `force` param → sends ?force=1 + force:true in body.

hindi-summary-card.tsx:
- SUMMARY_CACHE_VERSION bumped v6 → v7.
- handleLoad now accepts optional `force` param (skips cache when true).
- handleRegenerate: calls handleLoad(true) — used by the "फिर से बनाएँ" button.
- Partial-quality badge: when summary.quality === "partial", renders a muted amber warning "यह सारांश अधूरा हो सकता है" + a "फिर से बनाएँ" button with RefreshCw icon. The button calls handleRegenerate which bypasses cache.
- Added AlertCircle + RefreshCw icon imports.

transcript-view.tsx: Already correct from the COVERAGE-FIX task — the explain control is rendered as a sibling <div> AFTER each paragraph's closing </p>, never inside the words array. The words array contains ONLY transcript words. No changes needed.

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors in any modified file (hindi-summary-card, abm-api).
- bun run lint: 0 errors, 0 warnings.
- Inline logic tests (7 cases): T1 degenerate_tail caught (3x repeated trailing 6-word clause); T2 duplicate_sentence caught; T3 low_diversity caught; T4 good summary passes all gates (cov=100%, div=1.0); T5 low_coverage caught (50% < 70%, missing Virgil/Plutus); T6 truncated_coverage caught (Plutus missing from tail); T7 chunk splitting 2500 words → 3 chunks [900,900,900] with verified 100-word overlap. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors, no hydration crashes. Dev log shows all-200 responses, clean compilation.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, chapter catalog builder, analyze/chaptering, BGM mixing, cover persistence, deletion tombstones, or the voice registry.
- transcript-view.tsx explain-control structure was already correct (sibling div after </p>) — no changes needed there.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+180/-120 lines: v7 prompts, _validate_summary full rewrite with degeneracy/coverage/tail gates, _split_chapter_chunks 900/100, _generate_hindi_summary full rewrite chunk-then-reduce + no truncation + Pass B sees outline only + retry-once + partial quality + _strip_flagged_sentences, api_chapter_summary force param + v7 cache + chapter_title + quality/missing in response + v7 deletion cleanup)
- src/lib/abm-api.ts (+15 lines: quality/missing on HindiSummary, force param on getChapterSummary)
- src/components/aria/hindi-summary-card.tsx (+45 lines: SUMMARY_CACHE_VERSION v7, handleLoad force param, handleRegenerate, partial-quality badge + "फिर से बनाएँ" button, AlertCircle + RefreshCw imports)

No git push — implementation + verification only, per the task spec.

Regenerating Canto VI will now: (1) log `summary_input chapter=Canto VI chars=<full> words=<1100+>`, (2) chunk into ~900-word segments with 100-word overlap, (3) extract a master outline covering the ENTIRE chapter (Cerberus through Plutus), (4) generate Hindi from the outline only (no truncated chapter text), (5) pass the degeneracy/coverage/tail gates (or retry once, or return partial quality with the badge). The master outline + `summary_gate` log lines are visible in Render logs for debugging.

---
Task ID: NARRATION-V8
Agent: main (Fix Hindi summary degenerating into proper-noun lists + bare verb enumerations)
Task: Fix Hindi chapter summaries degenerating into proper-noun lists instead of narrative. Evidence: Canto V attributed every action to Minos, ended with a literal list of English verbs ("Went, Girds, Examining, Confess, Hear"), and reduced Francesca da Rimini to "फ्रांसेस्का को देखा".

Work Log:
- Read prior worklog (COVERAGE-FIX-V7, GOD-PROMPT-HINDI-FIX) for architecture context.
- Read current state: v7 summary flow (free-text Pass A outline → Pass B Hindi from outline), _validate_summary (degeneracy/coverage/tail gates on text outline).

BACKEND (audiobook_app.py) — Complete v8 rewrite of the summary generation pipeline:

Part 1 — Pass A rewritten as JSON event extractor:
- _SUMMARY_PASS_A_SYSTEM: new prompt requiring STRICT JSON output with schema {events: [{actor, action, outcome, quote_anchor}], speakers: [{name, says}], images: []}.
- Hard rules: events MUST have verbs; "X was seen/appeared/named" FORBIDDEN as standalone events; characters named in lists belong in ONE event explaining WHY the list exists; no bare English verbs/tags; narrator is default actor (don't carry first-named forward); every event needs quote_anchor (<=8 verbatim words); cover chapter END TO END.
- _validate_pass_a_json(raw_json, chapter_text): server-side validation — JSON parse, >=8 events for >400-word chapters, quote_anchor substring verification (case/whitespace-insensitive), actor dominance check (>60% → re-run with subject repair), tail coverage (last event's anchor in last 30% of chapter). Returns (parsed, errors).
- Targeted retries: JSON parse fail → _PASS_A_REPAIR; actor dominance → _PASS_A_SUBJECT_REPAIR; tail not reached → _PASS_A_TAIL_REPAIR (appends last chunk explicitly).

Part 2 — Pass B rewritten with narration contract:
- _SUMMARY_PASS_B_SYSTEM: 250-450 words, 4-6 paragraphs. Every event must appear; every speaker's says must be reported speech; >=2 images explained (not just named). Explain the LOGIC (why souls are here, what punishment means, how it mirrors sin). BANNED: "X को देखा" >2 entities, entity-only sentences, English verb lists, repeated clauses. End with final beat.
- Groq params: temperature 0.4, top_p 0.9, frequency_penalty 0.6, presence_penalty 0.4, max_tokens 1800.

Part 3 — Coverage gate on final summary (_validate_summary_v8):
- Bare-verb regex reject (_BARE_VERB_RE): catches "Went, Girds, Examining, Confess, Hear" etc.
- "X को देखा" chain check: >2 different entities → FAIL.
- 8-word shingle repetition: any shingle occurring 2+ times → FAIL.
- Paragraph similarity: >85% Jaccard between any two paragraphs → FAIL.
- Coverage: >=80% of proper nouns from Pass A (actors + speakers) must appear in summary.
- On FAIL: regenerate Pass B once with missing names listed. If still failing: one more attempt with stricter penalties (freq 0.8, presence 0.6). If still failing: return degraded outline as Hindi bulleted list (_render_degraded_outline) with quality="degraded".

Part 4 — Input integrity:
- Logs `summary_input chapter=<id> chars_in_full_chapter=<n> words=<n>` before any LLM call.
- Logs `summary_stats chapter=<id> chars_sent_to_model=<n> chars_in_full_chapter=<n> n_chunks=<n> events_returned=<n> regeneration_count=<n> final_word_count=<n> degraded=<bool>`.
- If chars_sent_to_model < 0.95 * chars_in_full_chapter: logs WARN (possible truncation bug).
- Chunking: 900-word chunks with 135-word overlap (15%). Events de-duplicated by quote_anchor across chunks. Never run Pass B per chunk — always ONE Pass B over the merged event list.

New helpers:
- _build_outline_from_events(parsed): converts JSON events/speakers/images to text outline for Pass B.
- _extract_proper_nouns_from_parsed(parsed): extracts proper nouns from actors + speakers for coverage gate.
- _render_degraded_outline(parsed, chapter_title): renders the JSON as a Hindi bulleted list (degraded fallback).
- _BARE_VERB_RE: regex matching bare English verb enumerations.

Cache: v7 → v8. Deletion cleanup includes v8. api_chapter_summary returns `degraded` field.

FRONTEND:
- abm-api.ts: HindiSummary type adds `degraded?: boolean`. Cache version v7 → v8.
- hindi-summary-card.tsx: SUMMARY_CACHE_VERSION v7 → v8. New degraded "संक्षिप्त रूप" badge (purple, with AlertCircle + RefreshCw "फिर से बनाएँ" button) when summary.degraded || summary.quality === "degraded".

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors.
- bun run lint: 0 errors, 0 warnings.
- Inline logic tests (9 cases): T1 valid JSON passes; T2 invalid JSON caught; T3 too few events caught; T4 actor dominance caught; T5 bad anchors caught; T6 bare verbs caught; T7 dekha chain caught; T8 good summary passes; T9 shingle repeat caught. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, chapter catalog builder, analyze/chaptering, BGM mixing, cover persistence, deletion tombstones, or the voice registry.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+350/-200 lines: v8 prompts, _validate_pass_a_json, _build_outline_from_events, _extract_proper_nouns_from_parsed, _validate_summary_v8, _render_degraded_outline, _BARE_VERB_RE, _PASS_A_REPAIR/SUBJECT/TAIL, _generate_hindi_summary full rewrite, _split_chapter_chunks 15% overlap, api_chapter_summary v8 cache + degraded field, v8 deletion cleanup)
- src/lib/abm-api.ts (+5 lines: degraded field on HindiSummary)
- src/components/aria/hindi-summary-card.tsx (+25 lines: SUMMARY_CACHE_VERSION v8, degraded "संक्षिप्त रूप" badge)

No git push — implementation + verification only, per the task spec.

---
Task ID: PASS-SEPARATION-V9
Agent: main (Fix Pass A outline leaking as summary text — hard pass separation)
Task: Fix the Hindi chapter summary UI rendering Pass A (English extraction outline) instead of Pass B (Hindi prose summary). The outline with "कथन:", "रूपक:", numbered events, and Hindi-English splices was being returned as the summary text when Pass B failed the quality gate and the degraded fallback returned the outline.

Work Log:
- Read prior worklog (NARRATION-V8, COVERAGE-FIX-V7) for architecture context.
- Audited the return path: found the root cause in _generate_hindi_summary_inner — when the quality gate failed 3 times, _render_degraded_outline() rendered the Pass A JSON as a Hindi bulleted list (with "कथन:", "रूपक:", numbered events, "actor ने action" splices) and returned it as the `summary` field. This is exactly what the user saw.

Fix 2 — HARD SEPARATION (the core fix):
- Removed _render_degraded_outline() entirely. The degraded fallback path is GONE.
- When the quality gate fails twice: return ("", "summary_quality_gate_failed", "error", ...) — an EMPTY summary with an error code. The UI shows the error toast + retry button. NEVER return the outline as summary.
- When Pass B itself fails (empty output, Groq error): return ("", "summary_pass_b_failed", "error", ...) — also never the outline.
- summary_returned_from log line: "pass_b" | "pass_b_failed" | "pass_a_failed" | "quality_gate_failed" | "cache".

Fix 3 — Pass A schema (structured, not strings):
- _SUMMARY_PASS_A_SYSTEM: new schema {events: [{actor, action, outcome}], named_entities: [...], key_quotes: [...], similes: [...]}. ALL English, no Hindi/Devanagari. 10-18 events.
- _validate_pass_a_json: checks JSON parse, >=8 events, actor dominance (>60%), named_entities present.
- _PASS_A_REPAIR: "ALL fields in English. No Hindi. No Devanagari."

Fix 4 — Pass B verbatim Hindi prose prompt:
- _SUMMARY_PASS_B_SYSTEM: verbatim from spec. "तुम एक साहित्यिक अनुवादक और व्याख्याकार हो।" + rules: Hindi only, no English verbs, no numbered list/bullet/कथन/रूपक headings, 3-5 paragraphs, cover every event, every named_entity, no repetition.
- Pass B user message: outline JSON + FULL chapter text (or first 2000 + last 2000 words for >2500-word chapters).
- Groq params: temp 0.4, freq_penalty 0.5, presence_penalty 0.3, max_tokens 2048.

Fix 5 — Server-side validation gate (_validate_summary_v9):
a) Devanagari ratio < 0.55 of all letter chars (outside parentheses) → FAIL.
b) "ने " followed by ASCII [a-z] (Hindi-English splice) → FAIL.
c) Numbered list lines or "कथन:"/"रूपक:" headings (_OUTLINE_LEAK_RE) → FAIL.
d) < 80% of named_entities appear in summary → FAIL.
e) Any 8-word shingle repeats > 2 times → FAIL.
Also: bare-verb regex, paragraph similarity > 85%.
On failure: retry Pass B once. On second failure: return error_code "summary_quality_gate_failed".

Fix 6 — Input integrity logging:
- summary_pass_a_chars=<n> chapter=<id>
- summary_pass_b_chars=<n> chapter=<id>
- summary_stats chapter=<id> chars_sent_to_pass_a=<n> chars_sent_to_pass_b=<n> chars_in_full_chapter=<n> n_chunks=<n> events_returned=<n> regeneration_count=<n> final_word_count=<n>
- summary_returned_from=pass_b|pass_b_failed|pass_a_failed|quality_gate_failed|cache
- For long chapters (>2500 words): Pass B receives outline + condensed chapter (first 2000 + last 2000 words).

Fix 7 — Transcript splicing:
- Verified transcript-view.tsx already renders the explain button as a sibling <div> AFTER the paragraph's closing </p>. The words array contains ONLY transcript words (words.slice(seg.startIdx, seg.endIdx)). The explain button is in a separate <div> block, never inside the word stream. No changes needed.

Cache: v8 → v9. Deletion cleanup includes v9.

Frontend:
- hindi-summary-card.tsx: SUMMARY_CACHE_VERSION v8 → v9.
- abm-api.ts: HindiSummary type adds degraded?: boolean (already present from v8).

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors.
- bun run lint: 0 errors, 0 warnings.
- Inline gate tests (7 cases): T1 outline_leak caught (numbered list + कथन/रूपक); T2 ne_ascii_splice caught (ने + ASCII word); T3 low_devanagari_ratio caught (mostly English); T4 good Hindi summary passes (ratio 1.0, coverage 100%); T5 low_coverage caught (<80% named_entities); T6 shingle_repeat caught (>2 occurrences); T7 bare_verbs caught. All passed.
- agent-browser: page loads cleanly (HTTP 200, title "ARIA"), no console errors.

CONSTRAINTS honored:
- Did NOT touch transcript sync offset, manual-scroll override, chapter catalog builder, analyze/chaptering, BGM mixing, cover persistence, deletion tombstones, or the voice registry.
- transcript-view.tsx explain button structure already correct (sibling div after </p>).

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+300/-250 lines: v9 prompts, _validate_pass_a_json, _build_outline_for_pass_b, _extract_named_entities, _validate_summary_v9, _NE_ASCII_RE, _OUTLINE_LEAK_RE, _generate_hindi_summary full rewrite with hard pass separation, _PASS_A_REPAIR/SUBJECT/TAIL, api_chapter_summary error map + v9 cache + v9 deletion cleanup)
- src/components/aria/hindi-summary-card.tsx (SUMMARY_CACHE_VERSION v8 → v9)

No git push — implementation + verification only, per the task spec.

The Pass A outline can NEVER reach the client as summary text. When Pass B fails or the quality gate fails twice, the endpoint returns an error code (summary_pass_b_failed / summary_quality_gate_failed) and the UI shows a toast + the "फिर से बनाएँ" retry button. The outline is logged to Render logs for debugging but never displayed.

---
Task ID: GENERATE-STUCK-FIX
Agent: main (Fix Convert doing nothing + "Generation already running" on retry)
Task: Fix the root causes where clicking "Convert" does nothing (no progress card, no audio) and retrying says "Generation already running." Three root causes: (1) selection validation after the atomic status claim leaves the job stuck in "generating", (2) index mismatch after Storj reconstruction, (3) no optimistic card for fresh uploads.

Work Log:
- Read /api/generate (api_generate) — found the atomic status claim at line ~10046 followed by selection validation (filtered chapters, max_text_chars) that could early-return and leave the job permanently in "generating" with no thread.
- Read the my_jobs stale-job watchdog — found it only catches 15-min stale jobs, not jobs stuck with no _thread_started flag.

BACKEND (audiobook_app.py):

Part 1.1 — Moved ALL selection validation BEFORE the atomic status claim:
- _resolve_selection (3-tier resolver) runs BEFORE `with _jobs_lock:`
- max_text_chars cap check runs BEFORE the claim
- Both return 400/413 while status is still "analyzed"/"done" — no stuck job

Part 1.2 — Added _unclaim guard for every post-claim return:
- `def _unclaim(reason)`: reverts status to "analyzed"/"optimized" if _thread_started is False
- Called before every post-claim return (google_tts_budget, etc.)
- Thread spawn wrapped in try/except: calls `_unclaim("thread_spawn_failed")` + returns 500
- `job["_thread_started"] = True` set immediately after `thread.start()` succeeds

Part 1.3 — Three-tier chapter selection resolver (_resolve_selection):
- Tier 1: exact index match
- Tier 2: match by catalog title (for index mismatch after reparse)
- Tier 3: positional fallback (catalog order == parse order)
- Returns "none" → 400 with error_code="chapter_index_mismatch" (NO claim made, job stays clickable)

Part 1.4 — One-line start log:
- `[{job_id}] GENERATION STARTED voice={voice} lang={narration_language} chapters={[...]} bgm={bgm_mode}`

Part 1.5 — Startup sweep for already-stuck jobs:
- In the my_jobs stale-job watchdog: if status=="generating" and not _thread_started and >60s since start_time → flip to "analyzed" with message "Previous start failed — pick chapters and convert again."

FRONTEND:

Part 2.1 — Optimistic card upsert in handleConvertStarted:
- If the job_id doesn't exist in cards: INSERT an optimistic card at the top with status="generating", progressMessage="Starting…", totalChapters, chapterCatalog, coverImgUrl
- If it exists: UPDATE to "generating"
- After close: setTimeout fetchJobs at 800ms (resets isFetchingRef) + 4000ms (catches slow backend)

Part 2.2 — Verified _ACTIVE includes "generating" — the optimistic card survives polling even when the backend hasn't listed it yet.

Part 2.3 — New error codes in abm-api.ts generate():
- "chapter_index_mismatch": "This book was re-parsed on the server and the chapter numbers changed."
- "thread_spawn_failed": "The server accepted the job but couldn't start it. Try again in a minute."

Part 2.4 — chapter-selector.tsx: catch block already has console.error + toast + setConverting(false) in finally. The modal stays OPEN on failure (onConvertStarted is only called on success). Added a comment documenting this.

VERIFICATION:
- python3 -m py_compile audiobook_app.py: PASSES.
- npx tsc --noEmit: zero errors.
- bun run lint: 0 errors, 0 warnings.
- agent-browser: page loads cleanly (HTTP 200), no console errors.

CONSTRAINTS honored:
- Did not refactor anything beyond the specified changes.
- Did not touch playback, transcript, BGM, covers, tombstones, or the voice registry.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/audiobook_app.py (+100/-50 lines: _resolve_selection helper, selection validation moved before claim, _unclaim guard, _thread_started flag, try/except thread spawn, one-line start log, startup sweep for stuck jobs)
- src/components/aria/library-view.tsx (+30 lines: optimistic card upsert in handleConvertStarted)
- src/lib/abm-api.ts (+6 lines: chapter_index_mismatch + thread_spawn_failed error codes)
- src/components/aria/chapter-selector.tsx (+3 lines: comment documenting modal stays open on failure)

---
Task ID: SUMMARY-SINGLECALL
Agent: main (Replace windowed map-reduce summary with single-call summary)
Task: Replace the entire windowed map-reduce summary pipeline in chapter_summary.py with a single-call summary. Delete _segment_windows, the Pass A map step, the ledger merge, the coverage gate, and the degeneracy gate. Bump SUMMARY_CACHE_VERSION to v15. New single function summarize_chapter(title, text) -> str with a 2-model Groq ladder (kimi-k2 -> llama-3.3-70b) + extractive fallback, exact system prompt/params, deterministic post-checks with one retry, English only, per-chapter logging of model/in_words/out_words/retries.

Work Log:
- Read /home/z/my-project/mini-services/audiobook-maker/chapter_summary.py (357 lines): confirmed the 3-pass structure (segment_windows -> map_all -> build_ledger -> reduce_ledger -> is_degenerate/covers_tail gates) and CACHE_VERSION = "s1".
- Read the /api/chapter_summary route in audiobook_app.py (lines 10857-10919): confirmed it calls get_or_create_summary(...) and returns {summary, source, windows, cached}, logging windows/ledger/source/cached.
- Read frontend: src/lib/abm-api.ts (ChapterSummaryResponse had windows) + src/components/aria/chapter-summary-card.tsx (only reads summary.split(/\n{2,}/) — does NOT read windows/source/cached, so response-shape changes are safe).
- Rewrote chapter_summary.py from scratch:
  * SUMMARY_CACHE_VERSION = "v15" (was CACHE_VERSION="s1"). _r2_key now uses summaries/{job}/{idx}.v15.json.gz — all old s1/v9 caches structurally bypassed.
  * Deleted: segment_windows, map_window, map_all, build_ledger, reduce_ledger, is_degenerate, covers_tail, ledger_fallback, _MAP_SYSTEM, _REDUCE_SYSTEM, _extractive_bullets, WINDOW_*/MAX_* constants, ThreadPoolExecutor import.
  * Kept/adapted: _r2_get/_r2_put/_r2_key/_r2 caching, _sentences, _norm_for_dedup (used by post-checks), normalize_text -> _normalize.
  * New _groq_client(): prefers generation_engine._llm_client (groq in prod), else standalone OpenAI client from ABM_LLM_API_KEY/ABM_LLM_API_BASE (groq default). None if no key.
  * New _call_model(): one non-streaming chat.completions.create with temperature=0.3, max_tokens=900, presence_penalty=0.4, frequency_penalty=0.4, top_p=0.9. Returns (text|None, error|None). Never raises.
  * New _maybe_truncate(): only if len > 100_000 chars, keep first 40% + last 40% joined by "\n[...]\n".
  * New _SYSTEM_PROMPT: verbatim from spec (classic-lit summarizer, nested-speech rules, 2 paragraphs 120-200 words each, present tense, no preamble).
  * New _clean(): strip markdown/preamble, collapse >2 paragraphs to 2.
  * New _passes_checks(): >=2 paragraphs (split on blank line); rejects forbidden substrings ("the speaker","the narrator","In this chapter","Summary:"); no verbatim repeated sentence (via _norm_for_dedup); word count 200-450.
  * New _extractive_fallback(): first 8 + last 6 substantive sentences (>=6 words), split at midpoint into 2 paragraphs.
  * New _summarize_with_meta(title, text) -> (str, {model,input_words,output_words,retries,source}): walks _GROQ_MODELS ladder; per model: call -> clean -> check; on check-fail retry ONCE same model; on 2nd check-fail RETURN that output anyway (do not fall to next model); on API-call error fall to next model; if no model produces output, extractive fallback. Prints "[summary] model=... input_words=... output_words=... retries=... source=..." per chapter.
  * New summarize_chapter(title, text) -> str: thin wrapper over _summarize_with_meta returning just the text.
  * get_or_create_summary(job_id, chapter_index, chapter_text, chapter_title): now calls _summarize_with_meta, returns {summary, model, input_words, output_words, retries, source, text_sha, cached}. R2 cache round-trips the full dict (cached reads restore model/in_words/out_words/retries too).
- Updated /api/chapter_summary route in audiobook_app.py: docstring updated; log line now prints model/input_words/output_words/retries/source/cached; response JSON now {summary, source, model, input_words, output_words, retries, cached} (windows/ledger dropped).
- Updated src/lib/abm-api.ts ChapterSummaryResponse: dropped windows, added optional model/input_words/output_words/retries (card only reads summary, so no runtime impact).

Verification:
- python3 -m py_compile chapter_summary.py audiobook_app.py: BOTH PASS.
- bun run lint: 0 errors, 0 warnings.
- Post-check unit tests (all behave per spec):
  * _maybe_truncate: 1000-char input unchanged; 150k-char input -> 40000 + "\n[...]\n" + 40000 (len 80007). OK.
  * _passes_checks: 289-word 2-para valid summary -> True. Forbidden "In this chapter" -> False. Forbidden "the narrator" -> False. One paragraph -> False. 56-word too-short -> False. Verbatim-repeated sentences -> False. 168-word below-200 floor -> False. OK.
  * _clean: 4 paragraphs -> 2. Strips ##/* markdown. OK.
  * _extractive_fallback: produces exactly 2 paragraphs. OK.
  * Empty input summarize_chapter("", "") -> "". OK.
- Mock-client ladder tests (5 scenarios, FakeClient scripted per model):
  1. kimi returns GOOD first try -> model=kimi, retries=0, source=llm.
  2. kimi fails check (forbidden), retry returns GOOD -> model=kimi, retries=1, source=llm.
  3. kimi fails check twice -> keep kimi's 2nd output, retries=1 (does NOT fall to llama). Matches "return the output anyway rather than erroring".
  4. kimi call errors -> llama returns GOOD -> model=llama, retries=0, source=llm.
  5. both models error -> extractive fallback, retries=0, source=fallback.
  * Sampling params verified on the wire: temperature=0.3, max_tokens=900, presence_penalty=0.4, frequency_penalty=0.4, top_p=0.9, messages[0].role=system.
- REAL CHAPTER TEST (Alice's Adventures in Wonderland, Ch. I "Down the Rabbit-Hole", public domain, 1364 words):
  * Sandbox has no `openai` python lib and no ABM_LLM_API_KEY set, so _groq_client() returned None and the Groq ladder was skipped — the run exercised the EXTRACTIVE FALLBACK path.
  * Reported numbers: model=extractive, input_words=1364, output_words=657, retries=0, source=fallback, 2 paragraphs.
  * In production (Render: ABM_LLM_API_KEY set + ABM_LLM_API_BASE=groq + openai lib installed per worklog line 215), the same code path will call moonshotai/kimi-k2-instruct first, then llama-3.3-70b-versatile, and only fall to extractive if both are unreachable.
- grep for deleted symbols (segment_windows/map_all/build_ledger/reduce_ledger/is_degenerate/covers_tail/ledger_fallback/generate_summary/CACHE_VERSION/_MAP_SYSTEM/_REDUCE_SYSTEM/WINDOW_WORDS/MAX_LEDGER) outside chapter_summary.py: ZERO matches. Clean.

Stage Summary:
Files modified:
- mini-services/audiobook-maker/chapter_summary.py (full rewrite: 357 lines -> ~290 lines. Single-call summarize_chapter + _summarize_with_meta ladder. SUMMARY_CACHE_VERSION v15. All map-reduce/ledger/coverage/degeneracy code deleted.)
- mini-services/audiobook-maker/audiobook_app.py (~30 lines in api_chapter_summary: new log line + new response shape {summary, source, model, input_words, output_words, retries, cached}.)
- src/lib/abm-api.ts (ChapterSummaryResponse: windows -> optional model/input_words/output_words/retries.)

Real-chapter numbers (extractive fallback, no groq key in sandbox): model=extractive, input_words=1364, output_words=657, retries=0. The Groq ladder + post-check retry logic is verified via mock-client tests and will run live in production.
