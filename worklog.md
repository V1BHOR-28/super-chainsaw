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
