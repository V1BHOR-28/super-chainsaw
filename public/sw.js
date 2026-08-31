/* eslint-disable */
/**
 * ARIA — minimal offline-capable service worker.
 *
 * Strategy:
 *   - Precache the app shell on install (just "/", the manifest, and icons).
 *   - Runtime: cache-first for same-origin static assets under /icons, /bgm,
 *     /screenshots, /audio, /foliate-js. Network-first for everything else
 *     (so the user always sees fresh app HTML/JS).
 *   - Never cache /api/* (those are dynamic backend calls).
 *
 * This is intentionally tiny — it exists so iOS Safari will offer the
 * "Add to Home Screen" install prompt with offline capability, not to be a
 * full app-shell network layer.
 */

const VERSION = "aria-pwa-v1";
const PRECACHE = `aria-precache-${VERSION}`;
const RUNTIME = `aria-runtime-${VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/icon-180x180.png",
];

// ----- INSTALL: precache the app shell -----
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// ----- ACTIVATE: clean up old caches -----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== PRECACHE && key !== RUNTIME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ----- FETCH: routing strategy -----
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept cross-origin or API calls
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Static asset cache buckets
  const STATIC_PREFIXES = ["/icons/", "/bgm/", "/screenshots/", "/audio/", "/foliate-js/", "/books/", "/manifest.webmanifest"];

  // Network-first for navigation requests (HTML) — so users get fresh app
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("/")))
    );
    return;
  }

  // Cache-first for static assets
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(RUNTIME).then((cache) => cache.put(request, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
      })
    );
  }
});
