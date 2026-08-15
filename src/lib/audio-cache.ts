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

/** Cache a chapter audio Blob. Fail-soft: never throws. */
export async function cacheAudio(
  jobId: string,
  chapterIndex: number,
  blob: Blob,
): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    const key = `${jobId}:${chapterIndex}`;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(blob, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // non-fatal — the cache is a nicety
  }
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
