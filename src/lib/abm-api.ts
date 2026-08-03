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

export interface GenerateResponse {
  status?: string; // "started"
  error?: string;
  error_code?: string;
  auto_batch_email?: string;
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
  total_chapters?: number;
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
      single_file: true,
    }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Generate failed (${res.status})`,
    );
  }
  // The Flask app returns {status: "started"} on success — nothing to return.
}

/** Poll the status of a running or completed job. */
export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await fetch(`${ABM_BASE}/job_status/${jobId}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body && (body.error || body.message)) || `Status fetch failed (${res.status})`,
    );
  }
  return (await res.json()) as JobStatusResponse;
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

/** Returns the relative cover thumbnail URL for a job (may 404 if no cover). */
export function getCoverUrl(jobId: string): string {
  return `${ABM_BASE}/cover/${jobId}`;
}
