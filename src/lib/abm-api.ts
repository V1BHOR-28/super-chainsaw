/**
 * abm-api.ts — Thin typed wrapper around the audiobook-maker Flask API.
 *
 * The Flask app runs on Render in production (ABM_SERVICE_URL env var on
 * Vercel) and on port 5601 in the sandbox. A Next.js catch-all proxy route
 * at /api/abm/[...path] forwards all requests to the Flask service, so
 * the frontend uses relative paths only — no CORS, no absolute URLs.
 *
 * Endpoints wrapped (all prefixed with /api/abm/):
 *   POST /api/abm/analyze        (multipart form, field name "epub")
 *   POST /api/abm/generate       (JSON body)
 *   GET  /api/abm/job_status/:id
 *   GET  /api/abm/download/:id
 *   GET  /api/abm/voices
 *   GET  /api/abm/my_jobs
 */

const ABM_BASE = "/api/abm";

/* ──── Client ID helpers ──── */
const CID_KEY = "abm_cid";
export function getStoredClientId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(CID_KEY) || "";
}
export function setStoredClientId(cid: string) {
  if (typeof window !== "undefined" && cid) localStorage.setItem(CID_KEY, cid);
}
/** Build headers with the X-ABM-Cid header if we have a stored cid. */
function cidHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const cid = getStoredClientId();
  if (cid) h["X-ABM-Cid"] = cid;
  return h;
}

/* ──────────────────────────── Types ──────────────────────────── */

export interface AnalyzeChapter {
  index: number;
  title: string;
  words: number;
  chars: number;
  estimated_minutes: number;
  /** Word-level sync cues for this chapter: [[startMs, endMs, word], ...].
   *  Only present when edge-tts WordBoundary events were captured during
   *  synthesis. Missing for older jobs, non-edge voices, or fallback paths. */
  transcript_cues?: number[][];
}

export interface AnalyzeResponse {
  job_id: string;
  title: string;
  author: string;
  language: string;
  language_detected?: boolean;
  file_type?: "epub" | "txt" | "pdf" | "abm";
  has_cover?: boolean;
  /** Client ID assigned by the Flask backend. Stored in localStorage and
   *  sent as X-ABM-Cid header / ?cid= query param on all subsequent requests
   *  so cover/audio endpoints can identify the owner. */
  client_id?: string;
  total_chapters: number;
  total_words: number;
  total_chars?: number;
  estimated_minutes: number;
  chapters: AnalyzeChapter[];
  preview_text?: string;
  llm_available?: boolean;
  ai_optimized?: boolean;
  optimized_chapters?: number[];
  max_text_chars?: number;
  max_gemini_text_chars?: number;
  selected_chapters?: number[];
  /** Per-chapter MP3 metadata. Present when the job was generated with
   *  output_format='mp3' + single_file=false (ARIA per-chapter mode).
   *  Each entry has exact duration + file path info for playlist playback. */
  chapter_mp3s?: ChapterMp3Info[];
  /** Complete parsed chapter catalog (EVERY chapter in the book, regardless
   *  of whether it has generated audio). Separate from chapter_mp3s (the
   *  generated playlist). Present when /api/analyze built the catalog; may
   *  be empty for legacy jobs (frontend falls back to /api/job_chapters). */
  chapter_catalog?: AnalyzeChapter[];
  /** True when the backend could only synthesize chapter rows from
   *  chapter_mp3s (no durable full catalog existed). The frontend uses this
   *  to decide whether to offer a "re-upload to see all chapters" hint. */
  chapter_catalog_incomplete?: boolean;
  /** Word-level transcript cues keyed by chapter index (string keys — JSON
   *  object keys are always strings on the wire). Each value is a list of
   *  [startMs, endMs, word] cues. Present when edge-tts WordBoundary events
   *  were captured. The frontend's transcript-store looks up by both the
   *  numeric and stringified chapter index to be safe.
   *
   *  Note: only returned by /api/job_chapters — NOT by /api/my_jobs (which
   *  returns the smaller `has_transcript` boolean per chapter instead). */
  transcript_cues?: Record<string, number[][]>;
  /** BGM delivery mode for this job: "off" | "runtime" | "prerender".
   *  "runtime" → the frontend fetches /api/bgm_cues and mixes in the browser.
   *  "prerender" → BGM is already baked into the chapter audio (no mixing needed).
   *  "off" → no BGM at all. */
  bgm_mode?: "off" | "runtime" | "prerender";
  narration_language?: "en" | "hinglish";
  /** ARIA: present when the backend detects this exact file already has a
   *  live generation (same client_id + file_hash, status generating/optimizing).
   *  The frontend uses this to show an "already converting" toast instead of
   *  opening an empty chapter selector. When true, job_id + chapters are still
   *  present so the UI can render something useful. */
  existing_job_id?: string;
  is_running?: boolean;
  status?: string;
  progress_current?: number;
  progress_total?: number;
}

/** A single BGM time cue — when to start/stop a mood loop and at what gain.
 *  Times are in seconds (float). gain_db is decibels (negative, typically
 *  -24 to -16). The frontend converts gain_db → linear and multiplies by
 *  the user's BGM volume slider (0-100%). */
export interface BgmCue {
  start: number;
  end: number;
  mood: string;
  gain_db: number;
}

/** Metadata for a single chapter MP3 file in per-chapter mode. */
export interface ChapterMp3Info {
  index: number;
  title: string;
  filename: string;
  duration_ms: number;
  start_ms: number;
  end_ms: number;
  /** True if word-level sync cues exist for this chapter (returned by
   *  /api/my_jobs so the library can show a synced-transcript affordance
   *  without shipping the full cues payload on every poll). The actual
   *  cues are fetched on-demand via /api/job_chapters. */
  has_transcript?: boolean;
}

export type JobStatus =
  | "analyzed"
  | "optimizing"
  | "optimized"
  | "translating"
  | "generating"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface JobStatusResponse {
  status: JobStatus;
  current: number;
  total: number;
  pct: number;
  message: string;
}

export interface AbmVoice {
  engine: string; // "edge" | "google" | "gemini" | "speechify"
  gender: string; // "Female" | "Male"
  gender_icon: string;
  id: string;
  locale: string;
  name: string;
}

export interface AbmLanguageGroup {
  name: string;
  voices: AbmVoice[];
}

export interface VoicesResponse {
  [languageCode: string]: AbmLanguageGroup | { _premium_status?: unknown; _translate_available?: boolean };
}

export interface MyJobFormats {
  m4b: boolean;
  zip: boolean;
  mp3: boolean;
  abm: boolean;
}

export interface MyJob {
  job_id: string;
  status: JobStatus;
  title: string;
  output_format?: string;
  created_at?: number;
  /** Which chapter indices are in the current audio. Empty/missing = whole
   *  book was converted OR nothing converted yet. Used by the library +
   *  player UI to show which chapters are downloaded. */
  selected_chapters?: number[];
  total_chapters?: number;
  /** Per-chapter MP3 metadata from the persisted download token.
   *  Present for done jobs generated in per-chapter mode. */
  chapter_mp3s?: ChapterMp3Info[];
  /** Compact chapter catalog (every chapter in the book) from the token
   *  snapshot. Empty for legacy tokens — frontend falls back to
   *  /api/job_chapters to fetch the full list on demand. */
  chapter_catalog?: AnalyzeChapter[];
  // Present when status === "generating"
  progress_current?: number;
  progress_total?: number;
  progress_message?: string;
  /** ARIA: "synthesizing" (chunk loop) or "finalizing" (concat/encode/upload).
   *  When "finalizing", the progress bar creeps 90→100 based on
   *  progress_finalize_pct instead of freezing at N/N. */
  progress_phase?: "synthesizing" | "finalizing";
  /** 0-100 — finalization sub-progress (only meaningful when
   *  progress_phase === "finalizing"). */
  progress_finalize_pct?: number;
  /** Unix timestamp of the last progress update. Used by the frontend
   *  to show a "No progress for a few minutes" stall banner. */
  progress_updated_at?: number;
  narration_language?: "en" | "hinglish";
  // Present when status === "done" (from download token)
  download_token?: string;
  expires_at?: number;
  downloaded_at?: number | null;
  formats?: MyJobFormats;
  // Optional metadata not always present
  author?: string;
  voice?: string;
  rate?: string;
  current_chapter_num?: number;
  admin_copy?: boolean;
  /** Whether the EPUB had an embedded cover image (extracted by the Flask
   *  app during /api/analyze). When true, the cover is served from
   *  /api/cover/<job_id>. */
  has_cover?: boolean;
}

export interface MyJobsResponse {
  jobs: MyJob[];
}

/* ──────────────────────────── Helpers ──────────────────────────── */

/** True if the job is in any state that warrants polling for updates. */
export function isPollingStatus(status: JobStatus | string | undefined): boolean {
  return (
    status === "generating" ||
    status === "optimizing" ||
    status === "translating" ||
    status === "analyzed" ||
    status === "optimized"
  );
}

/* ──────────────────────────── API ──────────────────────────── */

/**
 * Upload an EPUB/TXT/PDF/ABM file to the Flask /api/analyze endpoint.
 * The Flask app parses the book and returns the chapter list + metadata,
 * stashing the parsed state in-memory keyed by the returned job_id.
 */
export async function analyzeEpub(file: File): Promise<AnalyzeResponse> {
  const form = new FormData();
  form.append("epub", file);

  // If NEXT_PUBLIC_ABM_DIRECT_URL is set, POST directly to the Flask service
  // to bypass Vercel's ~4.5MB request body limit. This is essential for
  // large PDF uploads that exceed the Vercel proxy's buffering capacity.
  const rawDirectUrl = process.env.NEXT_PUBLIC_ABM_DIRECT_URL;
  // Guard: if the URL doesn't start with http, it's malformed — fall back to proxy.
  const directUrl = rawDirectUrl && rawDirectUrl.startsWith("http") ? rawDirectUrl.replace(/\/+$/, "") : null;
  if (rawDirectUrl && !directUrl) {
    console.error("[abm-api] NEXT_PUBLIC_ABM_DIRECT_URL is set but invalid:", rawDirectUrl, "— falling back to /api/abm proxy");
  }
  const analyzeUrl = directUrl
    ? `${directUrl}/api/analyze`
    : `${ABM_BASE}/analyze`;

  // 300s timeout — large PDFs can take minutes to parse on Render free tier
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);

  let res: Response;
  try {
    res = await fetch(analyzeUrl, {
      method: "POST",
      body: form,
      credentials: "include",
      signal: controller.signal,
      headers: cidHeaders(),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Upload timed out after 5 minutes. The file may be too large or the server is still waking up.');
    }
    console.error('[abm-api] analyze network failure', analyzeUrl, err);
    throw new Error(
      `Could not reach the audiobook service at ${analyzeUrl}. ` +
      `If this persists the server may be asleep or blocking this origin.`
    );
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    // Try to parse JSON error, fall back to raw text
    const text = await res.text().catch(() => '');
    let errorMsg = `Analyze failed (${res.status})`;
    try {
      const body = JSON.parse(text);
      if (body.error || body.message) errorMsg = body.error || body.message;
    } catch {
      // Not JSON — include the first 200 chars of the response
      if (text) errorMsg += `: ${text.substring(0, 200)}`;
    }
    throw new Error(errorMsg);
  }

  // Parse the JSON response
  try {
    const json = (await res.json()) as AnalyzeResponse;
    // ARIA: normalize the busy-shape response. The backend returns
    // existing_job_id (not job_id) when this file already has a live
    // generation. Copy it to job_id so callers only ever see one contract.
    if (!json.job_id && json.existing_job_id) {
      json.job_id = json.existing_job_id;
    }
    if (json.client_id) setStoredClientId(json.client_id);
    return json;
  } catch {
    throw new Error('The server returned an invalid response. The file may be corrupted or in an unsupported format.');
  }
}

/**
 * Kick off TTS generation for a previously-analyzed job.
 * The Flask app spawns a background thread and returns immediately.
 * Output format is MP3 so it can be played back in the browser via <audio>.
 */
export async function generate(
  jobId: string,
  voice: string,
  selectedChapters: number[],
  outputFormat: "mp3" | "m4b" | "zip" = "mp3",
  rate: string = "+0%",
  bgmMode: "off" | "runtime" | "prerender" = "off",
  language: "en" | "hinglish" = "en",
): Promise<void> {
  const res = await fetch(`${ABM_BASE}/generate`, {
    method: "POST",
    headers: cidHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      job_id: jobId,
      voice,
      rate,
      selected_chapters: selectedChapters,
      output_format: outputFormat,
      single_file: false,
      bgm_mode: bgmMode,
      language,
    }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Translate machine-readable error codes to human-readable messages
    const errorCode = body?.error_code || body?.error || "";
    let msg: string;
    if (errorCode === "payment_required" || errorCode === "free_quota_exhausted") {
      msg = "This voice requires payment (Gemini premium). Try an edge-tts voice instead — they're free.";
    } else if (errorCode === "gemini_tts_not_configured") {
      msg = "Gemini TTS is not configured on the server. Try an edge-tts voice instead.";
    } else if (errorCode === "gemini_overload") {
      msg = "Gemini voices are temporarily overloaded. Try again in a few minutes, or use an edge-tts voice.";
    } else if (errorCode === "selection_too_large") {
      msg = body?.error || "Selection too large. Reduce the number of chapters.";
    } else if (errorCode === "invalid_voice") {
      msg = "Invalid voice selected. Pick a different voice.";
    } else if (body?.error === "Session expired. Re-upload file.") {
      msg = "This book's session has expired (server restarted). Re-upload the EPUB to convert more chapters.";
    } else {
      msg = (body && (body.error || body.message)) || `Generate failed (${res.status})`;
    }
    throw new Error(msg);
  }
  // The Flask app returns {status: "started"} on success — nothing to return.
}

/**
 * Send a heartbeat to keep a generating job alive.
 *
 * The Flask app cancels jobs if no client polls the SSE /api/progress endpoint
 * for 60+ seconds (heartbeat timeout). Since we use polling via the my_jobs
 * endpoint instead of SSE, we must call this endpoint periodically to reset the timer.
 * Call every 30 seconds while a job is generating.
 */
export async function sendHeartbeat(jobId: string): Promise<void> {
  try {
    await fetch(`${ABM_BASE}/heartbeat/${jobId}`, {
      method: "POST",
      credentials: "include",
      headers: cidHeaders(),
    });
  } catch {
    // Non-blocking — heartbeat failure shouldn't crash the UI
  }
}

/**
 * Reset a completed ("done") job back to "analyzed" so the user can select
 * different chapters and re-generate. The book's parsed chapter data must
 * still be in memory (jobs expire after 18h).
 */
export async function resetToChapters(jobId: string): Promise<void> {
  const res = await fetch(`${ABM_BASE}/reset_to_chapters/${jobId}`, {
    method: "POST",
    credentials: "include",
    headers: cidHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Reset failed (${res.status})`,
    );
  }
}

/**
 * Fetch the chapter list for an existing analyzed/done/error job.
 *
 * Used when the user clicks "More chapters" on a done job — we need the
 * chapter list to re-render the chapter selector with per-chapter checkboxes
 * instead of the "whole book" fallback. Returns the same shape as analyzeEpub
 * (minus preview_text) so the frontend can reuse the same component.
 *
 * Returns the AnalyzeResponse. Throws if the job has expired (18h retention)
 * — the caller should prompt the user to re-upload the EPUB.
 */
export async function getJobChapters(jobId: string): Promise<AnalyzeResponse> {
  const res = await fetch(`${ABM_BASE}/job_chapters/${jobId}`, {
    credentials: "include",
    headers: cidHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Chapter fetch failed (${res.status})`,
    );
  }
  return (await res.json()) as AnalyzeResponse;
}

/**
 * Permanently delete a job and all its files. Works for any job status.
 * If the job is generating, it's cancelled first. Idempotent — deleting a
 * non-existent job returns success.
 */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${ABM_BASE}/delete/${jobId}`, {
    method: "POST",
    credentials: "include",
    headers: cidHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Delete failed (${res.status})`,
    );
  }
}

/** Fetch BGM (background music) time cues for a single chapter (runtime mode).
 *  Returns an array of {start, end, mood, gain_db} cues. Empty array if the
 *  chapter has no BGM (bgm_mode=off or prerender, or generation failed).
 *  Cached aggressively on the server (7-day immutable). */
export async function getBgmCues(
  jobId: string,
  chapterIdx: number,
): Promise<BgmCue[]> {
  const res = await fetch(`${ABM_BASE}/bgm_cues/${jobId}/${chapterIdx}`, {
    credentials: "include",
    headers: cidHeaders(),
  });
  if (!res.ok) {
    // 404 = bgm_mode is off/prerender → no cues (expected, not an error)
    if (res.status === 404) return [];
    return [];
  }
  const body = await res.json();
  return (body?.cues ?? []) as BgmCue[];
}

/** Returns the relative URL for a BGM loop asset MP3 by mood name.
 *  Served by Flask /api/bgm_asset/<mood> with 30-day immutable cache headers.
 *  Used as the `src` of hidden <audio loop> elements in the runtime mixer. */
export function getBgmAssetUrl(mood: string): string {
  const cid = getStoredClientId();
  return `${ABM_BASE}/bgm_asset/${mood}${cid ? `?cid=${encodeURIComponent(cid)}` : ""}`;
}

/** Fetch the voice catalog grouped by language code. */
export async function getVoices(): Promise<VoicesResponse> {
  const res = await fetch(`${ABM_BASE}/voices`, {
    credentials: "include",
    headers: cidHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Voices fetch failed (${res.status})`);
  }
  return (await res.json()) as VoicesResponse;
}

/** Fetch all jobs owned by this client (uses the abm_cid cookie for identity). */
export async function getMyJobs(): Promise<MyJobsResponse> {
  const res = await fetch(`${ABM_BASE}/my_jobs`, {
    credentials: "include",
    headers: cidHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`My jobs fetch failed (${res.status})`);
  }
  return (await res.json()) as MyJobsResponse;
}

/**
 * Returns the relative download URL for a finished job. Suitable for use
 * directly as the `src` of an <audio> element — the Flask app serves the
 * MP3 with proper streaming + range support.
 */
export function getDownloadUrl(jobId: string): string {
  const cid = getStoredClientId();
  return `${ABM_BASE}/download/${jobId}${cid ? `?cid=${encodeURIComponent(cid)}` : ""}`;
}

/**
 * Returns the relative URL for streaming an individual chapter MP3.
 * Only works for jobs generated in per-chapter mode (single_file=false).
 * The Flask app serves the file with HTTP Range support for seeking.
 */
export function getChapterMp3Url(jobId: string, chapterIndex: number): string {
  const cid = getStoredClientId();
  return `${ABM_BASE}/chapter_mp3/${jobId}/${chapterIndex}${cid ? `?cid=${encodeURIComponent(cid)}` : ""}`;
}

/**
 * Returns the relative URL for the book's cover image, extracted from the
 * EPUB by the Flask app during /api/analyze. The Flask endpoint
 * /api/cover/<job_id> serves the embedded EPUB cover (or a generated
 * fallback if the EPUB had no cover). Available immediately after upload —
 * no AI generation needed.
 *
 * Returns an empty string if the job has no cover (has_cover=false), so
 * the caller can fall back to the CSS monogram.
 */
export function getCoverUrl(jobId: string, hasCover: boolean): string {
  if (!hasCover) return "";
  const cid = getStoredClientId();
  return `${ABM_BASE}/cover/${jobId}${cid ? `?cid=${encodeURIComponent(cid)}` : ""}`;
}

/* ──── Hindi comprehension API ──── */

export interface HindiSummary {
  summary: string;
  audio_url?: string;
}

export interface HindiGlossary {
  explanation: string;
  audio_url?: string;
}

/** Error thrown by getChapterSummary / explainParagraph on !res.ok.
 *  Carries the server's machine-readable `code` + optional `retry_after`
 *  (seconds) so the frontend can show a specific toast. */
export class HindiApiError extends Error {
  code?: string;
  retry_after?: number;
  constructor(message: string, code?: string, retry_after?: number) {
    super(message);
    this.name = "HindiApiError";
    this.code = code;
    this.retry_after = retry_after;
  }
}

export async function getChapterSummary(bookId: string, chapterIndex: number): Promise<HindiSummary> {
  const res = await fetch(`${ABM_BASE}/chapter/summary`, {
    method: "POST",
    headers: cidHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ book_id: bookId, chapter_index: chapterIndex }),
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HindiApiError(
      body.error || `Summary failed (${res.status})`,
      body.code,
      body.retry_after,
    );
  }
  return (await res.json()) as HindiSummary;
}

export async function getGlossaryEntry(bookId: string, term: string, contextSnippet: string): Promise<HindiGlossary> {
  const res = await fetch(`${ABM_BASE}/glossary`, {
    method: "POST",
    headers: cidHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ book_id: bookId, term, context_snippet: contextSnippet }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HindiApiError(
      body.error || `Glossary failed (${res.status})`,
      body.code,
      body.retry_after,
    );
  }
  return (await res.json()) as HindiGlossary;
}

export async function explainParagraph(bookId: string, chapterIndex: number, paragraphText: string): Promise<HindiGlossary> {
  const res = await fetch(`${ABM_BASE}/explain`, {
    method: "POST",
    headers: cidHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ book_id: bookId, chapter_index: chapterIndex, paragraph_text: paragraphText }),
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HindiApiError(
      body.error || `Explain failed (${res.status})`,
      body.code,
      body.retry_after,
    );
  }
  return (await res.json()) as HindiGlossary;
}
