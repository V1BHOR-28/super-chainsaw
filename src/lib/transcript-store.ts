"use client";

import { create } from "zustand";
import { getJobChapters } from "@/lib/abm-api";

/**
 * transcript-store — per-chapter cache of word-level sync cues.
 *
 * Cues are big ([[startMs, endMs, word], ...] for every word in the chapter).
 * /api/my_jobs only ships a `has_transcript` boolean per chapter; the actual
 * cues are fetched on-demand here via /api/job_chapters when the user opens
 * the transcript panel for a chapter.
 *
 * Cache key: `${jobId}:${chapterIdx}` (chapterIdx is the Flask chapter index,
 * i.e. the `index` field on `ChapterMp3Info`, NOT the playlist position).
 *
 * NOT persisted to localStorage — the cues are too large for the typical
 * localStorage budget, and re-fetching from /api/job_chapters is cheap.
 *
 * Inflight request dedup: if `fetchTranscript` is called twice for the same
 * chapter while the first request is still in flight, both callers await the
 * same promise.
 */

export interface TranscriptData {
  /** Flat cue array: [startMs, endMs, word] tuples. */
  cues: number[][];
  /** Pre-extracted word strings for rendering. Index-aligned with `cues`. */
  words: string[];
}

export type TranscriptStatus = "idle" | "loading" | "ready" | "error" | "unavailable";

interface TranscriptEntry {
  data: TranscriptData | null;
  status: TranscriptStatus;
  error?: string;
}

interface TranscriptStore {
  /** Per-chapter cache, keyed by `${jobId}:${chapterIdx}`. */
  entries: Map<string, TranscriptEntry>;
  /** Inflight request promises for dedup. Same keys as `entries`. */
  inflight: Map<string, Promise<TranscriptData | null>>;

  /** Fetch (or return cached) transcript cues for a chapter.
   *  Returns null when the chapter has no cues (older job, non-edge voice,
   *  or fallback synthesis path). The `status` field on the matching entry
   *  tells the caller whether to render cues, a skeleton, or an "unavailable"
   *  message. */
  fetchTranscript: (jobId: string, chapterIdx: number) => Promise<TranscriptData | null>;

  /** Look up the cached entry for a chapter (no fetch). */
  getEntry: (jobId: string, chapterIdx: number) => TranscriptEntry | undefined;

  /** Drop a single chapter's cache (used when the player closes). */
  evict: (jobId: string, chapterIdx: number) => void;

  /** Drop the whole cache. */
  clear: () => void;
}

function keyFor(jobId: string, chapterIdx: number): string {
  return `${jobId}:${chapterIdx}`;
}

/** Extract cues for a specific chapter from a /api/job_chapters response.
 *  The API returns `transcript_cues` keyed by chapter index, but JSON object
 *  keys are always strings — try both numeric and stringified forms. */
function extractCuesForChapter(
  resp: { transcript_cues?: Record<string, number[][]> },
  chapterIdx: number,
): number[][] | null {
  const tc = resp.transcript_cues;
  if (!tc) return null;
  const byString = tc[String(chapterIdx)];
  if (Array.isArray(byString) && byString.length > 0) return byString;
  // Some response shapes (rare) may have numeric keys after JSON.parse —
  // cover this defensively.
  const byNum = (tc as unknown as Record<number, number[][]>)[chapterIdx];
  if (Array.isArray(byNum) && byNum.length > 0) return byNum;
  return null;
}

/** Build the TranscriptData from raw cues: extract word strings once so the
 *  render loop doesn't allocate per-frame. */
function buildTranscriptData(cues: number[][]): TranscriptData {
  const words: string[] = new Array(cues.length);
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    // cue shape is [startMs, endMs, word] — word is the 3rd element.
    // Stored as `number[][]` per the API spec but the word slot is a string
    // at runtime; coerce defensively.
    words[i] = c && c.length >= 3 ? String(c[2]) : "";
  }
  return { cues, words };
}

const IDLE_ENTRY: TranscriptEntry = { data: null, status: "idle" };

export const useTranscriptStore = create<TranscriptStore>((set, get) => ({
  entries: new Map(),
  inflight: new Map(),

  fetchTranscript: async (jobId, chapterIdx) => {
    const key = keyFor(jobId, chapterIdx);

    // 1) Cache hit — return immediately.
    const existing = get().entries.get(key);
    if (existing && (existing.status === "ready" || existing.status === "unavailable")) {
      return existing.data;
    }

    // 2) Inflight dedup — return the existing promise.
    const inflight = get().inflight.get(key);
    if (inflight) return inflight;

    // 3) Mark loading.
    set((s) => {
      const next = new Map(s.entries);
      next.set(key, { data: null, status: "loading" });
      return { entries: next };
    });

    // 4) Fire the request.
    const p = (async (): Promise<TranscriptData | null> => {
      try {
        const resp = await getJobChapters(jobId);
        const cues = extractCuesForChapter(resp, chapterIdx);
        if (!cues || cues.length === 0) {
          // Chapter has no word-level cues — render "Transcript not available".
          set((s) => {
            const next = new Map(s.entries);
            next.set(key, { data: null, status: "unavailable" });
            const nextInflight = new Map(s.inflight);
            nextInflight.delete(key);
            return { entries: next, inflight: nextInflight };
          });
          return null;
        }
        const data = buildTranscriptData(cues);
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, { data, status: "ready" });
          const nextInflight = new Map(s.inflight);
          nextInflight.delete(key);
          return { entries: next, inflight: nextInflight };
        });
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load transcript";
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, { data: null, status: "error", error: msg });
          const nextInflight = new Map(s.inflight);
          nextInflight.delete(key);
          return { entries: next, inflight: nextInflight };
        });
        return null;
      }
    })();

    set((s) => {
      const nextInflight = new Map(s.inflight);
      nextInflight.set(key, p);
      return { inflight: nextInflight };
    });

    return p;
  },

  getEntry: (jobId, chapterIdx) => {
    return get().entries.get(keyFor(jobId, chapterIdx));
  },

  evict: (jobId, chapterIdx) => {
    const key = keyFor(jobId, chapterIdx);
    set((s) => {
      const next = new Map(s.entries);
      next.delete(key);
      const nextInflight = new Map(s.inflight);
      nextInflight.delete(key);
      return { entries: next, inflight: nextInflight };
    });
  },

  clear: () => {
    set({ entries: new Map(), inflight: new Map() });
  },
}));

/** Convenience selector: subscribe to a single chapter's entry. */
export function useTranscriptEntry(jobId: string | undefined, chapterIdx: number): TranscriptEntry {
  return useTranscriptStore((s) => {
    if (!jobId) return IDLE_ENTRY;
    return s.entries.get(keyFor(jobId, chapterIdx)) ?? IDLE_ENTRY;
  });
}
