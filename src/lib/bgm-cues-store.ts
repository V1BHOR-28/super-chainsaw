"use client";

import { create } from "zustand";
import { getBgmCues, type BgmCue } from "@/lib/abm-api";

/**
 * bgm-cues-store — per-chapter cache of BGM (background music) time cues.
 *
 * Cues are fetched from /api/bgm_cues/<jobId>/<chapterIdx> (runtime mode only).
 * The store mirrors the transcript-store pattern: per-chapter cache, inflight
 * dedup, status tracking. NOT persisted to localStorage (cues are re-fetched
 * cheaply and are immutable once generated).
 *
 * Cache key: `${jobId}:${chapterIdx}` (chapterIdx is the Flask chapter index,
 * i.e. the `index` field on `ChapterMp3Info`, NOT the playlist position).
 */

export type BgmCuesStatus = "idle" | "loading" | "ready" | "error" | "unavailable";

interface BgmCuesEntry {
  cues: BgmCue[];
  status: BgmCuesStatus;
  error?: string;
}

interface BgmCuesStore {
  /** Per-chapter cache, keyed by `${jobId}:${chapterIdx}`. */
  entries: Map<string, BgmCuesEntry>;
  /** Inflight request promises for dedup. Same keys as `entries`. */
  inflight: Map<string, Promise<BgmCue[]>>;

  /** Fetch (or return cached) BGM cues for a chapter.
   *  Returns an empty array when the chapter has no BGM (bgm_mode=off,
   *  prerender, or generation failed). The `status` field tells the caller
   *  whether to render a loading skeleton or an error state. */
  fetchCues: (jobId: string, chapterIdx: number) => Promise<BgmCue[]>;

  /** Look up the cached entry for a chapter (no fetch). */
  getEntry: (jobId: string, chapterIdx: number) => BgmCuesEntry | undefined;

  /** Drop a single chapter's cache (used when the player closes). */
  evict: (jobId: string, chapterIdx: number) => void;

  /** Drop the whole cache. */
  clear: () => void;
}

function keyFor(jobId: string, chapterIdx: number): string {
  return `${jobId}:${chapterIdx}`;
}

const IDLE_ENTRY: BgmCuesEntry = { cues: [], status: "idle" };

export const useBgmCuesStore = create<BgmCuesStore>((set, get) => ({
  entries: new Map(),
  inflight: new Map(),

  fetchCues: async (jobId, chapterIdx) => {
    const key = keyFor(jobId, chapterIdx);

    // 1) Cache hit — return immediately.
    const existing = get().entries.get(key);
    if (existing && (existing.status === "ready" || existing.status === "unavailable")) {
      return existing.cues;
    }

    // 2) Inflight dedup — return the existing promise.
    const inflight = get().inflight.get(key);
    if (inflight) return inflight;

    // 3) Mark loading.
    set((s) => {
      const next = new Map(s.entries);
      next.set(key, { cues: [], status: "loading" });
      return { entries: next };
    });

    // 4) Fire the request.
    const p = (async (): Promise<BgmCue[]> => {
      try {
        const cues = await getBgmCues(jobId, chapterIdx);
        if (!cues || cues.length === 0) {
          // No BGM for this chapter — mark unavailable (not an error).
          set((s) => {
            const next = new Map(s.entries);
            next.set(key, { cues: [], status: "unavailable" });
            const ni = new Map(s.inflight);
            ni.delete(key);
            return { entries: next, inflight: ni };
          });
          return [];
        }
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, { cues, status: "ready" });
          const ni = new Map(s.inflight);
          ni.delete(key);
          return { entries: next, inflight: ni };
        });
        return cues;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load BGM cues";
        set((s) => {
          const next = new Map(s.entries);
          next.set(key, { cues: [], status: "error", error: msg });
          const ni = new Map(s.inflight);
          ni.delete(key);
          return { entries: next, inflight: ni };
        });
        return [];
      }
    })();

    set((s) => {
      const ni = new Map(s.inflight);
      ni.set(key, p);
      return { inflight: ni };
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
      const ni = new Map(s.inflight);
      ni.delete(key);
      return { entries: next, inflight: ni };
    });
  },

  clear: () => {
    set({ entries: new Map(), inflight: new Map() });
  },
}));

/** Convenience selector: subscribe to a single chapter's entry. */
export function useBgmCuesEntry(jobId: string | undefined, chapterIdx: number): BgmCuesEntry {
  return useBgmCuesStore((s) => {
    if (!jobId) return IDLE_ENTRY;
    return s.entries.get(keyFor(jobId, chapterIdx)) ?? IDLE_ENTRY;
  });
}
