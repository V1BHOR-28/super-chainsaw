"use client";

/**
 * offline-manager — the single orchestrator for "saved on device" books.
 *
 * Before this module, offline support was scattered: audio-cache saved
 * chapters only when played or via a "Save offline" row hidden inside the
 * player's chapter panel; the EPUB was only cached after the reader was
 * opened online once; covers were sometimes cached. Result: the user had
 * no way to know what was on the device, and airplane mode broke in
 * confusing, unpredictable ways.
 *
 * This module makes saving explicit, complete, and observable:
 *
 *   downloadJob(card) saves EVERYTHING for a book, in order:
 *     1. job snapshot  (title/author/chapters metadata → rehydrates the
 *                       library even if localStorage is wiped)
 *     2. cover         (data URL via cover-cache)
 *     3. all chapters  (MP3 blobs via audio-cache, sequential + pacing)
 *     4. the EPUB      (blob via epub-cache — the reader's source)
 *
 *   Every step updates an in-memory OfflineStatus and notifies
 *   subscribers (use-offline-manager) so the library badge, the player
 *   header button, and the chapters panel all update live.
 *
 *   computeStatus() reads the ground truth from IndexedDB (not the
 *   in-memory record), so the UI never lies about what is on device —
 *   even for chapters cached by older versions of the app or by
 *   simply playing a book online.
 *
 *   removeJob() deletes every stored artifact for a book.
 *
 * All operations are fail-soft: a partial download is a valid state
 * ("3/12 chapters on device"), never an error screen.
 */

import {
  ensureChapterCached,
  getCachedAudio,
  getCachedSingleFile,
  ensureSingleFileCached,
  removeCachedAudioForJob,
} from "@/lib/audio-cache";
import { getCachedEpub, cacheEpub, removeCachedEpub } from "@/lib/epub-cache";
import { getCachedCover, cacheCover } from "@/lib/cover-cache";
import { getChapterMp3Url, getEpubFileUrl, getCoverUrl, getDownloadUrl } from "@/lib/abm-api";
import type { ChapterMp3Info } from "@/lib/abm-api";

/** The minimal job info the manager needs to save a book offline. */
export interface DownloadableJob {
  jobId: string;
  title: string;
  author?: string | null;
  accent?: string;
  hasCover?: boolean;
  chapterMp3s?: ChapterMp3Info[];
}

/** Live per-book offline state. Mirrored to IndexedDB (store: `status`). */
export interface OfflineStatus {
  jobId: string;
  /** idle: nothing on device. active: downloading right now.
   *  partial: some artifacts saved. complete: chapters + epub saved. */
  phase: "idle" | "active" | "partial" | "complete";
  chaptersDone: number;
  chaptersTotal: number;
  epubDone: boolean;
  coverDone: boolean;
  /** Approximate bytes saved (chapters + epub). 0 = unknown. */
  bytes: number;
  updatedAt: number;
}

const DB_NAME = "aria-offline";
const DB_VERSION = 1;
const STATUS_STORE = "status";
const JOBS_STORE = "jobs";

/** Pacing between chapter downloads — gentle on the ngrok tunnel. */
const CHAPTER_PACING_MS = 200;

// ── module state ──
const statuses = new Map<string, OfflineStatus>();
const inFlight = new Set<string>();
const subscribers = new Set<() => void>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let persistedRecordsLoaded = false;

// ── IndexedDB (records only; blobs live in audio/epub/cover caches) ──

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STATUS_STORE)) db.createObjectStore(STATUS_STORE);
        if (!db.objectStoreNames.contains(JOBS_STORE)) db.createObjectStore(JOBS_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      const db = await openDB();
      if (!db) return resolve();
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbGet<T>(store: string, key: string): Promise<T | null> {
  return new Promise(async (resolve) => {
    try {
      const db = await openDB();
      if (!db) return resolve(null);
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbDelete(store: string, key: string): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      const db = await openDB();
      if (!db) return resolve();
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ── subscription plumbing ──

function notify() {
  subscribers.forEach((cb) => {
    try {
      cb();
    } catch {
      /* subscriber crashed — never take the manager down */
    }
  });
}

/** Subscribe to status changes. Returns an unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Sync snapshot of all known statuses — for React state seeding. */
export function getAll(): Record<string, OfflineStatus> {
  const out: Record<string, OfflineStatus> = {};
  statuses.forEach((s, k) => {
    out[k] = { ...s };
  });
  return out;
}

export function isDownloading(jobId: string): boolean {
  return inFlight.has(jobId);
}

function upsert(status: OfflineStatus, persist = true) {
  statuses.set(status.jobId, status);
  notify();
  if (persist) idbPut(STATUS_STORE, status.jobId, status).catch(() => {});
}

/** Rehydrate persisted statuses once (first subscriber wins; idempotent). */
async function ensureRecordsLoaded(): Promise<void> {
  if (persistedRecordsLoaded) return;
  persistedRecordsLoaded = true;
  try {
    const db = await openDB();
    if (!db) return;
    const records = await new Promise<OfflineStatus[]>((resolve) => {
      try {
        const tx = db.transaction(STATUS_STORE, "readonly");
        const req = tx.objectStore(STATUS_STORE).getAll();
        req.onsuccess = () => resolve((req.result as OfflineStatus[]) || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    // Seed in-memory state for jobs we've seen before. `active` is stale by
    // definition (the loop died with the page) — demote to partial/idle.
    for (const r of records) {
      if (r && typeof r.jobId === "string") {
        statuses.set(r.jobId, {
          ...r,
          phase: r.phase === "active" ? "partial" : r.phase,
        });
      }
    }
    notify();
  } catch {
    /* non-fatal */
  }
}

// ── ground-truth status computation ──

/**
 * Compute the REAL status of a job by inspecting the blob caches. This is
 * the source of truth for the UI — it counts chapters cached by any path
 * (played online, "Save offline", downloadJob) and checks the EPUB/cover.
 */
export async function computeStatus(jobId: string, chapterMp3s?: ChapterMp3Info[]): Promise<OfflineStatus> {
  const total = chapterMp3s?.length ?? 0;
  let done = 0;
  let bytes = 0;

  if (total > 0 && chapterMp3s) {
    for (const ch of chapterMp3s) {
      const blob = await getCachedAudio(jobId, ch.index);
      if (blob) {
        done++;
        bytes += blob.size;
      }
    }
  } else {
    // Legacy single-file job — one merged MP3 counts as its "chapter".
    const single = await getCachedSingleFile(jobId);
    if (single) {
      done = 1;
      bytes += single.size;
    }
  }

  const epub = await getCachedEpub(jobId);
  if (epub) bytes += epub.size;

  const cover = await getCachedCover(jobId);

  // For single-file jobs with the merged MP3 on device, report 1/1.
  const chaptersTotal = total > 0 ? total : done > 0 ? 1 : 0;

  const phase: OfflineStatus["phase"] =
    chaptersTotal > 0 && done === chaptersTotal && epub
      ? "complete"
      : done > 0 || epub
        ? "partial"
        : "idle";

  return {
    jobId,
    phase,
    chaptersDone: done,
    chaptersTotal,
    epubDone: !!epub,
    coverDone: !!cover,
    bytes,
    updatedAt: Date.now(),
  };
}

/** Recompute + persist statuses for a set of jobs (library refresh). */
export async function refreshStatuses(jobs: DownloadableJob[]): Promise<Record<string, OfflineStatus>> {
  await ensureRecordsLoaded();
  const results: Record<string, OfflineStatus> = {};
  for (const job of jobs) {
    const status = await computeStatus(job.jobId, job.chapterMp3s);
    results[job.jobId] = status;
    if (!inFlight.has(job.jobId)) upsert(status);
  }
  return results;
}

/** Persist the job snapshot so the library can rehydrate offline. */
async function saveJobSnapshot(job: DownloadableJob): Promise<void> {
  await idbPut(JOBS_STORE, job.jobId, {
    jobId: job.jobId,
    title: job.title,
    author: job.author ?? null,
    accent: job.accent ?? null,
    hasCover: job.hasCover ?? false,
    chapterMp3s: job.chapterMp3s ?? [],
    savedAt: Date.now(),
  });
}

/** Get a persisted job snapshot (offline library rehydration). */
export async function getJobSnapshot(jobId: string): Promise<DownloadableJob | null> {
  return idbGet<DownloadableJob>(JOBS_STORE, jobId);
}

// ── the download pipeline ──

/**
 * Download everything for a book onto the device. Idempotent + resumable:
 * already-cached chapters/epub/cover are skipped, so calling it repeatedly
 * is safe. Only one download per job runs at a time (concurrent calls
 * return the current status immediately).
 *
 * Never throws — the returned status says how far it got.
 */
export async function downloadJob(job: DownloadableJob): Promise<OfflineStatus> {
  await ensureRecordsLoaded();

  if (inFlight.has(job.jobId)) {
    return statuses.get(job.jobId) ?? { ...idleStatus(job.jobId) };
  }
  inFlight.add(job.jobId);

  // Best-effort persistence grant — protects every cache from eviction.
  try {
    if (navigator.storage && typeof navigator.storage.persist === "function") {
      navigator.storage.persist().catch(() => {});
    }
  } catch {
    /* non-fatal */
  }

  const total = job.chapterMp3s?.length ?? 0;
  let status: OfflineStatus = {
    jobId: job.jobId,
    phase: "active",
    chaptersDone: 0,
    chaptersTotal: total,
    epubDone: false,
    coverDone: false,
    bytes: 0,
    updatedAt: Date.now(),
  };
  upsert({ ...status });

  try {
    // 1. Job snapshot — tiny, do it first so even an interrupted download
    //    leaves enough metadata to rehydrate the library card offline.
    await saveJobSnapshot(job);

    // 2. Cover (small, fast)
    try {
      if (job.hasCover !== false) {
        await cacheCover(job.jobId, getCoverUrl(job.jobId, true));
        status.coverDone = !!(await getCachedCover(job.jobId));
      }
    } catch {
      /* cover is cosmetic */
    }

    // 3. Chapters — sequential with pacing (gentle on the ngrok tunnel).
    if (job.chapterMp3s && job.chapterMp3s.length > 0) {
      for (let i = 0; i < job.chapterMp3s.length; i++) {
        const ch = job.chapterMp3s[i];
        const blob = await getCachedAudio(job.jobId, ch.index);
        if (blob) {
          status.chaptersDone++;
          status.bytes += blob.size;
          upsert({ ...status, chaptersDone: status.chaptersDone, bytes: status.bytes });
          continue; // cache hit — instant, no pacing needed
        }
        const ok = await ensureChapterCached(
          job.jobId,
          ch.index,
          getChapterMp3Url(job.jobId, ch.index),
        );
        if (ok) {
          const fresh = await getCachedAudio(job.jobId, ch.index);
          status.chaptersDone++;
          status.bytes += fresh?.size ?? 0;
        }
        upsert({ ...status, chaptersDone: status.chaptersDone, bytes: status.bytes });
        await new Promise((r) => setTimeout(r, CHAPTER_PACING_MS));
      }
    } else {
      // Legacy single-file job — the merged MP3 is the one "chapter".
      status.chaptersTotal = 1;
      upsert({ ...status, chaptersTotal: 1 });
      const ok = await ensureSingleFileCached(job.jobId, getDownloadUrl(job.jobId));
      if (ok) {
        const fresh = await getCachedSingleFile(job.jobId);
        status.chaptersDone = 1;
        status.bytes += fresh?.size ?? 0;
        upsert({ ...status, chaptersDone: 1, bytes: status.bytes });
      }
    }

    // 4. EPUB — the reader's source. One request, typically 1–5 MB.
    try {
      let epub = await getCachedEpub(job.jobId);
      if (!epub) {
        const resp = await fetch(getEpubFileUrl(job.jobId), { credentials: "include" });
        if (resp.ok) {
          const blob = await resp.blob();
          if (blob.size > 0) {
            await cacheEpub(job.jobId, blob);
            epub = blob;
          }
        }
      }
      if (epub) {
        status.epubDone = true;
        status.bytes += epub.size;
      }
    } catch {
      /* epub stays un-cached — reader shows its own guidance */
    }

    // 5. Finalize
    const complete =
      (status.chaptersTotal === 0 || status.chaptersDone === status.chaptersTotal) && status.epubDone;
    status.phase = complete ? "complete" : status.chaptersDone > 0 ? "partial" : "idle";
    status.updatedAt = Date.now();
    upsert({ ...status });
    return { ...status };
  } finally {
    inFlight.delete(job.jobId);
    notify();
  }
}

/**
 * Ensure just the EPUB is on device (used by the reader after it fetches
 * the book online — keeps the manager's status in sync).
 */
export async function markEpubCached(jobId: string, chaptersTotal?: number): Promise<void> {
  await ensureRecordsLoaded();
  const existing = statuses.get(jobId);
  const status: OfflineStatus = existing
    ? { ...existing }
    : { ...idleStatus(jobId, chaptersTotal ?? 0) };
  status.epubDone = true;
  status.phase =
    (status.chaptersTotal === 0 || status.chaptersDone === status.chaptersTotal) && status.epubDone
      ? "complete"
      : "partial";
  status.updatedAt = Date.now();
  upsert(status);
}

/** Remove every offline artifact for a job. Fail-soft. */
export async function removeJob(jobId: string): Promise<void> {
  await ensureRecordsLoaded();
  await Promise.all([
    removeCachedAudioForJob(jobId),
    removeCachedEpub(jobId),
    idbDelete(STATUS_STORE, jobId),
    idbDelete(JOBS_STORE, jobId),
  ]);
  statuses.delete(jobId);
  notify();
}

function idleStatus(jobId: string, chaptersTotal = 0): OfflineStatus {
  return {
    jobId,
    phase: "idle",
    chaptersDone: 0,
    chaptersTotal,
    epubDone: false,
    coverDone: false,
    bytes: 0,
    updatedAt: Date.now(),
  };
}

/** Human-readable size ("4.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}
