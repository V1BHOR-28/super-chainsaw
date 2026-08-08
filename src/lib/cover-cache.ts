"use client";

/**
 * cover-cache — client-side IndexedDB cache for book cover images.
 *
 * Why: the Flask backend runs on Render's free tier, which wipes ephemeral
 * disk on every restart. Covers are uploaded to R2 (see /api/analyze), but
 * if R2 isn't configured the cover is gone until the user re-uploads the
 * EPUB. This cache stores small cover thumbnails (< 400KB) as data URLs in
 * IndexedDB so the library never blanks out on a cold/restarted backend.
 *
 * Fail-soft: every operation is wrapped in try/catch. If IndexedDB is
 * unavailable (private browsing, quota exceeded, etc.) the functions return
 * null/void and the caller falls back to the network URL or monogram.
 */

const DB_NAME = "aria-covers";
const STORE_NAME = "covers";
const DB_VERSION = 1;
const MAX_COVER_SIZE = 400 * 1024; // 400KB — thumbnails only

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

/** Get a cached cover data URL for a job. Returns null on any failure. */
export async function getCachedCover(jobId: string): Promise<string | null> {
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
          resolve(typeof result === "string" ? result : null);
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

/** Fetch a cover URL and cache it as a data URL in IndexedDB.
 *  Only caches if the blob is < 400KB (thumbnails only).
 *  Fail-soft: never throws. */
export async function cacheCover(jobId: string, url: string): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const blob = await resp.blob();
    if (blob.size > MAX_COVER_SIZE) return; // too big — skip caching
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl) return;
    await putCover(db, jobId, dataUrl);
  } catch {
    // non-fatal — the cache is a nicety
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(typeof result === "string" ? result : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

function putCover(db: IDBDatabase, jobId: string, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(dataUrl, jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
