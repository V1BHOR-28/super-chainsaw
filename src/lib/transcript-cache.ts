"use client";

/**
 * transcript-cache — permanent browser-side cache for word-level transcript cues.
 *
 * Why: transcripts are important (karaoke-style synced text). When the backend
 * is down (Docker stopped, laptop off, network outage), the frontend can't
 * fetch /api/job_chapters — so the transcript disappears. This cache stores
 * the cues in IndexedDB so they're available INSTANTLY even with the backend
 * completely offline. The backend stays the source of truth; this is a
 * read-through cache that populates on first access and serves from disk
 * on every subsequent access.
 *
 * Storage: IndexedDB (not localStorage — transcript cues can be 100KB-1MB
 * per chapter, and localStorage has a 5-10MB total budget). IndexedDB can
 * store hundreds of MB, so caching many chapters across many books is fine.
 *
 * Fail-soft: every operation is wrapped in try/catch. If IndexedDB is
 * unavailable (private browsing, quota exceeded), functions return null/void
 * and the caller falls back to the network fetch.
 *
 * Key shape: `${jobId}:${chapterIdx}` — same as the in-memory transcript store.
 */

const DB_NAME = "aria-transcripts";
const STORE_NAME = "cues";
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

/** Get cached transcript cues for a chapter. Returns null on any failure. */
export async function getCachedTranscript(
  jobId: string,
  chapterIdx: number,
): Promise<number[][] | null> {
  try {
    const db = await openDB();
    if (!db) return null;
    const key = `${jobId}:${chapterIdx}`;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const result = req.result;
          if (Array.isArray(result) && result.length > 0) {
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

/** Cache transcript cues for a chapter. Fail-soft: never throws. */
export async function cacheTranscript(
  jobId: string,
  chapterIdx: number,
  cues: number[][],
): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    const key = `${jobId}:${chapterIdx}`;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(cues, key);
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

/** Remove a cached transcript (e.g. when a job is deleted). Fail-soft. */
export async function removeCachedTranscript(
  jobId: string,
  chapterIdx: number,
): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    const key = `${jobId}:${chapterIdx}`;
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

/** Remove all cached transcripts for a job (e.g. when a job is deleted). */
export async function removeCachedTranscriptsForJob(
  jobId: string,
): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        // IndexedDB cursors let us scan all keys and delete matches
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
