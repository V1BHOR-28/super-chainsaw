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

/* ──────────────────────────── Types ──────────────────────────── */

export interface AnalyzeChapter {
  index: number;
  title: string;
  words: number;
  chars: number;
  estimated_minutes: number;
}

export interface AnalyzeResponse {
  job_id: string;
  title: string;
  author: string;
  language: string;
  language_detected?: boolean;
  file_type?: "epub" | "txt" | "pdf" | "abm";
  has_cover?: boolean;
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
}

/** Metadata for a single chapter MP3 file in per-chapter mode. */
export interface ChapterMp3Info {
  index: number;
  title: string;
  filename: string;
  duration_ms: number;
  start_ms: number;
  end_ms: number;
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
  // Present when status === "generating"
  progress_current?: number;
  progress_total?: number;
  progress_message?: string;
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
  const res = await fetch(`${ABM_BASE}/analyze`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Analyze failed (${res.status})`,
    );
  }
  return (await res.json()) as AnalyzeResponse;
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
): Promise<void> {
  const res = await fetch(`${ABM_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      voice,
      rate,
      selected_chapters: selectedChapters,
      output_format: outputFormat,
      single_file: false,
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
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Delete failed (${res.status})`,
    );
  }
}

/** Fetch the voice catalog grouped by language code. */
export async function getVoices(): Promise<VoicesResponse> {
  const res = await fetch(`${ABM_BASE}/voices`, {
    credentials: "include",
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
  return `${ABM_BASE}/download/${jobId}`;
}

/**
 * Returns the relative URL for streaming an individual chapter MP3.
 * Only works for jobs generated in per-chapter mode (single_file=false).
 * The Flask app serves the file with HTTP Range support for seeking.
 */
export function getChapterMp3Url(jobId: string, chapterIndex: number): string {
  return `${ABM_BASE}/chapter_mp3/${jobId}/${chapterIndex}`;
}

// ── AI cover art generation ──
// Generates a book cover image from the title + author via the
// /api/cover-art endpoint (z-ai-web-dev-sdk image generation).
// Covers are cached in localStorage (aria-cover-<jobId>) as data URLs
// so they persist across sessions without re-generating.

const COVER_KEY_PREFIX = "aria-cover-";

/** Load a cached cover from localStorage. Returns null if not cached. */
export function loadCachedCover(jobId: string): string | null {
  try {
    return localStorage.getItem(COVER_KEY_PREFIX + jobId);
  } catch {
    return null;
  }
}

/**
 * Generate an AI cover for a book. Uses the cached version if available.
 * On success, caches the cover in localStorage + returns the data URL.
 * On failure, returns null (the caller falls back to the CSS monogram).
 *
 * The generation happens server-side (/api/cover-art) and can take 10-30s.
 * The caller should NOT await this on the critical path — call it fire-and-
 * forget after upload, then update the card when it resolves.
 */
export async function generateCoverArt(
  jobId: string,
  title: string,
  author?: string,
): Promise<string | null> {
  // Check cache first
  const cached = loadCachedCover(jobId);
  if (cached) return cached;

  try {
    const res = await fetch("/api/cover-art", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, author }),
    });
    if (!res.ok) {
      console.error("[cover-art] generation failed:", res.status);
      return null;
    }
    const data = await res.json();
    const url: string | undefined = data.url;
    if (!url) return null;

    // Cache in localStorage (non-blocking)
    try {
      localStorage.setItem(COVER_KEY_PREFIX + jobId, url);
    } catch {
      // localStorage may be full (data URLs are ~500KB-1MB) — non-blocking
      console.warn("[cover-art] could not cache cover (localStorage full?)");
    }

    return url;
  } catch (err) {
    console.error("[cover-art] error:", err);
    return null;
  }
}
