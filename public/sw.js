/* eslint-disable */
/**
 * ARIA service worker v2 — offline-first.
 *
 * v1 only precached the shell HTML and a few icons: the Next.js JS chunks
 * under /_next/static/ were NEVER cached, so opening the PWA without
 * internet rendered a blank screen (HTML loaded, every script 404'd at the
 * network layer). v2 fixes that and adds selective API caching so the app
 * boots AND shows the library offline.
 *
 * Strategy:
 *   - Precache the app shell on install ("/", manifest, core icons).
 *   - /_next/static/* (immutable, content-hashed): CACHE-FIRST.
 *   - Other static assets (/icons, /bgm, /foliate-js, ...): CACHE-FIRST.
 *   - Navigation (HTML): NETWORK-FIRST so deploys arrive promptly, falling
 *     back to the cached shell when offline. Every successful navigation
 *     refreshes the cached shell, so the offline copy is never stale.
 *   - GET /api/auth/session: NETWORK-FIRST with offline cache fallback —
 *     NextAuth's client can finish its session check while offline, so the
 *     app boots into the workspace instead of hanging on the landing page.
 *     (Same-origin cache storage; the entry is refreshed on every online
 *     load and after sign-out the network response replaces it.)
 *   - GET /api/abm/my_jobs: NETWORK-FIRST with offline cache fallback —
 *     the library renders the last-known book list offline. Chapter audio
 *     itself is served from the app's IndexedDB cache (audio-cache.ts).
 *   - GET /api/abm/cover/* and /api/abm/job_chapters/*: STALE-WHILE-
 *     REVALIDATE — covers + chapter lists render instantly offline and
 *     refresh silently when online.
 *   - Everything else (POSTs, chapter_mp3 streams, SSE, /api/chat, ...):
 *     NOT intercepted — passthrough to the network.
 *
 * Chapter MP3s are deliberately excluded: they are large, need HTTP Range
 * support, and are already cached as blobs in IndexedDB by audio-cache.ts.
 */

const VERSION = "aria-pwa-v2";
const SHELL_CACHE = `aria-shell-${VERSION}`; // "/" HTML + manifest + icons
const ASSET_CACHE = `aria-assets-${VERSION}`; // /_next/static + static assets
const API_CACHE = `aria-api-${VERSION}`; // session + my_jobs + covers

const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

const STATIC_PREFIXES = [
  "/_next/static/",
  "/icons/",
  "/bgm/",
  "/screenshots/",
  "/audio/",
  "/foliate-js/",
  "/books/",
  "/manifest.webmanifest",
];

// ----- helpers -----

async function putInCache(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (e) {
    /* non-fatal */
  }
}

async function offlineResponse() {
  return new Response("Offline", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain" },
  });
}

/** Cache-first (for immutable /_next/static and static assets). */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      putInCache(cacheName, request, res.clone());
    }
    return res;
  } catch (e) {
    const fallback = await caches.match(request);
    return fallback || offlineResponse();
  }
}

/** Network-first with offline cache fallback (session, my_jobs). */
async function networkFirst(request, cacheName, { cacheSuccessOnly = true } = {}) {
  try {
    const res = await fetch(request);
    if (res && (!cacheSuccessOnly || res.ok)) {
      putInCache(cacheName, request, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    return cached || offlineResponse();
  }
}

/** Stale-while-revalidate (covers, chapter lists). */
async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.status === 200) {
        putInCache(cacheName, request, res.clone());
      }
      return res;
    })
    .catch(() => null);

  if (cached) return cached;

  const res = await networkPromise;
  return res || offlineResponse();
}

/** Navigation: network-first; refresh the cached shell; fall back offline. */
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      // Cache each page under its own URL. Offline, unknown paths fall
      // back to the cached "/" app shell below.
      putInCache(SHELL_CACHE, request, res.clone());
    }
    return res;
  } catch (e) {
    const direct = await caches.match(request);
    if (direct) return direct;
    const shell = await caches.match("/");
    return shell || offlineResponse();
  }
}

// ----- INSTALL: precache the app shell -----
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Cache each URL individually so one failure (e.g. a 404 icon on a
      // fresh deploy) doesn't abort the whole install via addAll().
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (e) {
            /* non-fatal — shell "/" is the one that matters */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

// ----- ACTIVATE: clean up old cache versions -----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("aria-") && !key.endsWith(VERSION))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// ----- FETCH: routing strategy -----
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only same-origin GETs are intercepted. POSTs (chat, generate,
  // heartbeat, uploads) and cross-origin requests pass through untouched.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 1. App navigation (HTML) — offline shell fallback
  if (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 2. Immutable build assets + static assets — cache-first
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // 3. NextAuth session — network-first, cached while offline
  if (url.pathname === "/api/auth/session") {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // 4. Jobs list — network-first, cached while offline (library renders)
  if (url.pathname === "/api/abm/my_jobs") {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // 5. Covers + chapter lists — stale-while-revalidate
  if (url.pathname.startsWith("/api/abm/cover/") || url.pathname.startsWith("/api/abm/job_chapters/")) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }

  // Everything else (chapter_mp3 audio streams, SSE progress, /api/chat,
  // RSC flight payloads, ...) → network passthrough, never cached here.
});
