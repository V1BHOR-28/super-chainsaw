"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { getChapterMp3Url } from "@/lib/abm-api";
import { ensureChapterCached, getCachedAudio } from "@/lib/audio-cache";

/**
 * useOfflineDownload — bulk "save this book offline" for the player.
 *
 * Downloads every chapter MP3 of the current job into the persistent
 * IndexedDB audio cache (audio-cache.ts), so the book plays fully offline:
 * airplane mode, backend stopped, phone locked — doesn't matter.
 *
 * Chapters already cached are skipped instantly, so pressing it again after
 * a partial failure resumes where it left off.
 *
 * Also requests the Storage API persistence grant
 * (navigator.storage.persist()) — without it iOS may evict IndexedDB data
 * under storage pressure; with it, Safari treats the data as durable
 * (granted automatically once the user has installed the PWA / interacts
 * with it regularly).
 */

export type OfflineDownloadStatus = "idle" | "checking" | "downloading" | "done" | "partial" | "error";

export function useOfflineDownload() {
  const currentJob = usePlayerStore((s) => s.currentJob);

  const [status, setStatus] = useState<OfflineDownloadStatus>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0, cached: 0 });
  const abortRef = useRef(false);

  const jobId = currentJob?.jobId ?? null;
  const chapterMp3s = currentJob?.chapterMp3s ?? null;

  // Reset state when the player switches to a different book
  useEffect(() => {
    abortRef.current = true; // cancel any in-flight loop for the old book
    setStatus("idle");
    setProgress({ done: 0, total: 0, cached: 0 });
  }, [jobId]);

  /** Count how many chapters of this book are already cached offline. */
  const checkCached = useCallback(async (): Promise<number> => {
    if (!jobId || !chapterMp3s || chapterMp3s.length === 0) return 0;
    let n = 0;
    for (const ch of chapterMp3s) {
      // eslint-disable-next-line no-await-in-loop
      if (await getCachedAudio(jobId, ch.index)) n++;
    }
    return n;
  }, [jobId, chapterMp3s]);

  // On mount / book change, see if the book is already fully saved offline
  useEffect(() => {
    if (!jobId || !chapterMp3s || chapterMp3s.length === 0) return;
    let cancelled = false;
    setStatus("checking");
    checkCached().then((cached) => {
      if (cancelled) return;
      setProgress({ done: cached, total: chapterMp3s.length, cached });
      setStatus(cached >= chapterMp3s.length ? "done" : "idle");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, chapterMp3s]);

  /** Download all uncached chapters. Sequential + gentle pacing (250ms
   *  between requests) to avoid saturating the ngrok tunnel or tripping
   *  backend rate limits. Safe to call repeatedly — cached chapters are
   *  skipped. */
  const downloadAll = useCallback(async (): Promise<void> => {
    const job = usePlayerStore.getState().currentJob;
    if (!job?.chapterMp3s || job.chapterMp3s.length === 0) return;

    abortRef.current = false;
    setStatus("downloading");

    // Best-effort persistence grant — protects the cache from eviction.
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        navigator.storage.persist().catch(() => {});
      }
    } catch {
      /* non-fatal */
    }

    const total = job.chapterMp3s.length;
    let cached = 0;
    let failures = 0;

    for (let i = 0; i < job.chapterMp3s.length; i++) {
      if (abortRef.current) break;
      const ch = job.chapterMp3s[i];
      // eslint-disable-next-line no-await-in-loop
      const ok = await ensureChapterCached(
        job.jobId,
        ch.index,
        getChapterMp3Url(job.jobId, ch.index),
      );
      if (ok) {
        cached++;
      } else {
        failures++;
      }
      setProgress({ done: i + 1, total, cached });
      // Gentle pacing between downloads (skip when the chapter was a cache
      // hit — those are instant, no network involved).
      if (!ok || i < job.chapterMp3s.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ok ? 0 : 250));
      }
    }

    if (abortRef.current) {
      setStatus(cached >= total ? "done" : cached > 0 ? "partial" : "idle");
      return;
    }
    if (failures > 0) {
      setStatus(cached > 0 ? "partial" : "error");
    } else {
      setStatus(cached >= total ? "done" : "partial");
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

  return { status, progress, downloadAll, cancel, checkCached };
}
