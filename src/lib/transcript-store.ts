"use client";

import { create } from "zustand";
import { getJobChapters } from "@/lib/abm-api";
import { getCachedTranscript, cacheTranscript, removeCachedTranscript } from "@/lib/transcript-cache";

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
  /** Auto-retry bookkeeping: how many retries have been attempted, and when
   *  the last retry happened. Used by fetchTranscript to space out retries
   *  with exponential backoff when the backend is down. */
  retryAttempt?: number;
  retryAt?: number;
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

    // 2) Auto-retry on error with exponential backoff.
    // When the backend is down (Docker stopped, network blip), the fetch
    // fails and the entry is marked "error". Instead of giving up forever,
    // we retry after a delay — so the transcript auto-recovers when the
    // backend comes back online. The retry is triggered by the TranscriptView
    // re-mounting or by the periodic retry effect in TranscriptView.
    if (existing && existing.status === "error") {
      const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000]; // 2s, 5s, 10s, 20s, 30s
      const attempt = existing.retryAttempt ?? 0;
      if (attempt < RETRY_DELAYS.length) {
        const lastAttempt = existing.retryAt ?? 0;
        const elapsed = Date.now() - lastAttempt;
        if (elapsed < RETRY_DELAYS[attempt]) {
          // Not enough time has passed — don't retry yet. The TranscriptView's
          // periodic retry effect will call fetchTranscript again.
          return null;
        }
        // Mark the next retry attempt so we don't double-fire.
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, {
            ...existing,
            retryAttempt: attempt + 1,
            retryAt: Date.now(),
          });
          return { entries: next };
        });
        // Fall through to the fetch below.
      } else {
        // Max retries exhausted — stay in "error" state. The user can still
        // click "Try again" manually in the TranscriptView UI.
        return null;
      }
    }

    // 3) Inflight dedup — return the existing promise.
    const inflight = get().inflight.get(key);
    if (inflight) return inflight;

    // 4) Mark loading.
    set((s) => {
      const next = new Map(s.entries);
      next.set(key, { data: null, status: "loading" });
      return { entries: next };
    });

    // 5) Fire the request. Two-tier fetch: IndexedDB cache first (instant,
    //    works with backend offline), then network (authoritative). On
    //    network success, the cues are written back to IndexedDB so the
    //    next load is instant + survives a backend outage.
    const p = (async (): Promise<TranscriptData | null> => {
      // ── Tier 1: IndexedDB cache ──
      // Check the persistent browser cache first. If we have cues for this
      // chapter, return them immediately — even if Docker is stopped. This
      // makes the transcript available permanently after the first load.
      const cached = await getCachedTranscript(jobId, chapterIdx);
      if (cached && cached.length > 0) {
        const data = buildTranscriptData(cached);
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, { data, status: "ready" });
          const nextInflight = new Map(s.inflight);
          nextInflight.delete(key);
          return { entries: next, inflight: nextInflight };
        });
        // Fire a background network fetch to refresh the cache (in case the
        // cues changed after a re-generation). Non-blocking — the cached
        // version is already returned to the caller.
        getJobChapters(jobId).then((resp) => {
          const fresh = extractCuesForChapter(resp, chapterIdx);
          if (fresh && fresh.length > 0) {
            cacheTranscript(jobId, chapterIdx, fresh).catch(() => {});
          }
        }).catch(() => {
          // Backend unreachable — the cached version is still good.
        });
        return data;
      }

      // ── Tier 2: Network fetch ──
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
        // Persist to IndexedDB so the next load survives a backend outage.
        await cacheTranscript(jobId, chapterIdx, cues);
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
          next.set(key, {
            data: null,
            status: "error",
            error: msg,
            retryAttempt: 0,
            retryAt: Date.now(),
          });
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
    // Also remove the persistent IndexedDB cache entry for this chapter.
    removeCachedTranscript(jobId, chapterIdx).catch(() => {});
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
