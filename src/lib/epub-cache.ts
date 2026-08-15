"use client";

/**
 * epub-cache — persistent IndexedDB cache for EPUB files.
 *
 * Same pattern as audio-cache: fetch the EPUB once, store the Blob in
 * IndexedDB, serve from cache when the backend is offline.
 *
 * EPUB files are typically 1-5MB. IndexedDB handles this easily.
 * Key shape: jobId (one EPUB per book).
 */

const DB_NAME = "aria-epub-cache";
const STORE_NAME = "epubs";
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

/** Get a cached EPUB Blob. Returns null on any failure. */
export async function getCachedEpub(jobId: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(jobId);
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

/** Cache an EPUB Blob. Fail-soft: never throws. */
export async function cacheEpub(jobId: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(blob, jobId);
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

/** Remove a cached EPUB. Fail-soft. */
export async function removeCachedEpub(jobId: string): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(jobId);
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
