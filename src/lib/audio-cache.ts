"use client";

/**
 * audio-cache — persistent IndexedDB cache for chapter MP3 audio.
 *
 * Why: when the Docker backend is stopped, chapter MP3s are unreachable.
 * The <audio> element's src points to /api/abm/chapter_mp3/... which goes
 * through the backend. Without caching, playback is impossible offline.
 *
 * This cache stores the raw MP3 bytes as a Blob in IndexedDB. When the
 * player requests a chapter URL, the cache is checked first. If cached,
 * a blob: URL is returned (instant, works offline). If not cached, the
 * network URL is used and the bytes are cached in the background for
 * next time.
 *
 * Storage: IndexedDB can store hundreds of MB. A typical chapter is
 * ~2MB (edge-tts) or ~260KB (kokoro). A 20-chapter book = ~4-40MB.
 * Fail-soft: every operation is wrapped in try/catch.
 *
 * Key shape: `${jobId}:${chapterIndex}`.
 */

const DB_NAME = "aria-audio-cache";
const STORE_NAME = "chapters";
const DB_VERSION = 1;

let _dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

/** Get a cached chapter audio Blob. Returns null on any failure. */
export async function getCachedAudio(
  jobId: string,
  chapterIndex: number,
): Promise<Blob | null> {
  try {
    const db = await openDB();
    if (!db) return null;
    const key = `${jobId}:${chapterIndex}`;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const result = req.result;
          if (result instanceof Blob) {
            resolve(result);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/** Low-level put: store a Blob under an exact key. Fail-soft. */
function putBlob(key: string, blob: Blob): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      const db = await openDB();
      if (!db) return resolve();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Cache a chapter audio Blob. Fail-soft: never throws. */
export async function cacheAudio(
  jobId: string,
  chapterIndex: number,
  blob: Blob,
): Promise<void> {
  await putBlob(`${jobId}:${chapterIndex}`, blob);
}

/** Fetch a chapter URL, cache the bytes, return a blob: URL.
 *  If already cached, returns the cached blob: URL immediately.
 *  Falls back to the network URL if caching fails. */
export async function getAudioUrl(
  jobId: string,
  chapterIndex: number,
  networkUrl: string,
): Promise<string> {
  // 1. Check cache first
  const cached = await getCachedAudio(jobId, chapterIndex);
  if (cached) {
    return URL.createObjectURL(cached);
  }

  // 2. Fetch from network
  try {
    const resp = await fetch(networkUrl, { credentials: "include" });
    if (!resp.ok) return networkUrl; // fall back to network URL
    const blob = await resp.blob();
    if (blob.size === 0) return networkUrl;

    // 3. Cache in background
    cacheAudio(jobId, chapterIndex, blob).catch(() => {});

    // 4. Return blob URL (instant playback, no network needed)
    return URL.createObjectURL(blob);
  } catch {
    return networkUrl; // network failed — return URL anyway (might retry)
  }
}

/** Ensure a chapter is cached for offline playback (bulk "save offline").
 *  Returns true if the chapter is in the cache after this call (either it
 *  already was, or the download succeeded). Never throws — used by the
 *  offline-download loop which counts successes itself. */
export async function ensureChapterCached(
  jobId: string,
  chapterIndex: number,
  networkUrl: string,
): Promise<boolean> {
  // 1. Already cached?
  const cached = await getCachedAudio(jobId, chapterIndex);
  if (cached) return true;

  // 2. Download + persist
  try {
    const resp = await fetch(networkUrl, { credentials: "include" });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    if (blob.size === 0) return false;
    await cacheAudio(jobId, chapterIndex, blob);
    return true;
  } catch {
    return false;
  }
}

/** Remove a cached chapter (e.g. when a job is deleted). Fail-soft. */
export async function removeCachedAudio(
  jobId: string,
  chapterIndex: number,
): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    const key = `${jobId}:${chapterIndex}`;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // non-fatal
  }
}

/** Remove all cached audio for a job. Fail-soft. */
export async function removeCachedAudioForJob(jobId: string): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const key = String(cursor.key);
            if (key.startsWith(`${jobId}:`)) {
              cursor.delete();
            }
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // non-fatal
  }
}

/* ============ Legacy single-file jobs (single_file=true) ============ */

/**
 * Old jobs (single_file=true) produce ONE merged MP3 at /api/download/<id>
 * instead of per-chapter files. They share the same store with the key
 * `<jobId>:single` so removeCachedAudioForJob() (prefix match) cleans them
 * up too — no separate lifecycle needed.
 */

function singleKey(jobId: string): string {
  return `${jobId}:single`;
}

/** Get the cached single-file audio Blob. Returns null on any failure. */
export async function getCachedSingleFile(jobId: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(singleKey(jobId));
        req.onsuccess = () => {
          resolve(req.result instanceof Blob ? req.result : null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/** Ensure the merged single-file audio is cached. True = on device. */
export async function ensureSingleFileCached(
  jobId: string,
  networkUrl: string,
): Promise<boolean> {
  const cached = await getCachedSingleFile(jobId);
  if (cached) return true;
  try {
    const resp = await fetch(networkUrl, { credentials: "include" });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    if (blob.size === 0) return false;
    await putBlob(singleKey(jobId), blob);
    return true;
  } catch {
    return false;
  }
}

/** Cache-first blob URL for the single-file audio (mirrors getAudioUrl). */
export async function getSingleFileAudioUrl(
  jobId: string,
  networkUrl: string,
): Promise<string> {
  const cached = await getCachedSingleFile(jobId);
  if (cached) return URL.createObjectURL(cached);
  try {
    const resp = await fetch(networkUrl, { credentials: "include" });
    if (!resp.ok) return networkUrl;
    const blob = await resp.blob();
    if (blob.size === 0) return networkUrl;
    putBlob(singleKey(jobId), blob).catch(() => {});
    return URL.createObjectURL(blob);
  } catch {
    return networkUrl;
  }
}
