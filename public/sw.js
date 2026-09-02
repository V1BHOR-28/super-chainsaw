/* eslint-disable */
/**
 * ARIA service worker v3 — offline-first, install-time complete.
 *
 * v2 had a fatal race: it precached the shell HTML at install but relied on
 * RUNTIME caching for the /_next/static/ JS chunks. On the first visit after
 * a deploy, the page loads its chunks BEFORE the new service worker
 * activates, so those chunks were never intercepted and never cached.
 * Offline: the shell HTML loaded from cache, every script request failed,
 * React never booted → white screen stuck forever.
 *
 * v3 fixes the boot chain end-to-end:
 *   - INSTALL precaches the shell AND every /_next/static/ chunk the shell
 *     HTML references (scripts, styles, fonts, modulepreloads) — one online
 *     visit after a deploy is now genuinely enough.
 *   - INSTALL also warms /api/auth/session + /api/abm/my_jobs (cookies are
 *     included, Set-Cookie stripped so Safari's cache.put doesn't reject),
 *     so the app boots authenticated with the library visible offline.
 *   - ACTIVATE heals: if the shell didn't land at install (flaky network,
 *     mid-deploy 503), it is retried — no SW byte-change needed.
 *   - Navigation offline falls back to shell → then to a small inline
 *     branded offline page, so the app NEVER shows a blank white screen.
 *
 * Runtime strategies (unchanged from v2):
 *   - /_next/static/* (immutable, content-hashed): CACHE-FIRST.
 *   - Other static assets (/icons, /bgm, /foliate-js, ...): CACHE-FIRST.
 *   - Navigation (HTML): NETWORK-FIRST so deploys arrive promptly, falling
 *     back to the cached shell when offline. Every successful navigation
 *     refreshes the cached shell (under its own URL and under "/"), so the
 *     offline copy tracks deploys.
 *   - GET /api/auth/session + /api/abm/my_jobs: NETWORK-FIRST with offline
 *     cache fallback.
 *   - GET /api/abm/cover/* + /api/abm/job_chapters/*: STALE-WHILE-
 *     REVALIDATE.
 *   - Everything else (POSTs, chapter_mp3 streams, SSE, /api/chat, ...):
 *     passthrough — never cached here.
 *
 * Chapter MP3s are deliberately excluded from the SW: they are large, need
 * HTTP Range support, and are already cached as blobs in IndexedDB by
 * audio-cache.ts ("Save offline" in the Chapters panel).
 */

const VERSION = "aria-pwa-v3";
const SHELL_CACHE = `aria-shell-${VERSION}`; // "/" HTML + manifest + icons
const ASSET_CACHE = `aria-assets-${VERSION}`; // /_next/static + static assets
const API_CACHE = `aria-api-${VERSION}`; // session + my_jobs + covers

const SHELL_URLS = [
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

const API_WARM_URLS = ["/api/auth/session", "/api/abm/my_jobs"];

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

/** Inline last-resort page — replaces v2's bare 503 white screen. */
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>ARIA — Offline</title><style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0c0a08;color:#e8ddc8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
min-height:100vh;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
.card{max-width:420px;text-align:center;line-height:1.6}
.logo{font-size:44px;font-weight:800;letter-spacing:.35em;margin-bottom:28px;
background:linear-gradient(135deg,#f5c66b,#c98a3d 55%,#8a5a24);-webkit-background-clip:text;background-clip:text;color:transparent}
h1{font-size:21px;margin-bottom:14px;color:#f5e9d0}
p{font-size:15px;color:#a89a80;margin-bottom:10px}
.hint{margin-top:22px;padding:14px 16px;border:1px solid #3a3126;border-radius:12px;background:#171310;font-size:14px;color:#d8c9a8}
</style></head><body><div class="card">
<div class="logo">ARIA</div>
<h1>You&rsquo;re offline</h1>
<p>This copy of ARIA hasn&rsquo;t been saved for offline use yet.</p>
<div class="hint">
Reconnect to the internet once and open ARIA for a few seconds &mdash; it will
cache itself automatically. After that, airplane mode works, and every
audiobook you saved offline plays without any network.
</div>
</div></body></html>`;

// ----- helpers -----

async function putInCache(cacheName, key, response) {
  try {
    const cache = await caches.open(cacheName);
    // Safari rejects cache.put() for responses carrying Set-Cookie — cache
    // a sanitized copy (same body, header stripped) instead.
    if (response.headers && response.headers.get && response.headers.get("set-cookie")) {
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.delete("set-cookie");
      await cache.put(key, new Response(body, { status: response.status, statusText: response.statusText, headers }));
    } else {
      await cache.put(key, response);
    }
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

function offlinePage() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Extract every /_next/static/ URL referenced anywhere in the shell HTML —
 * script src, stylesheet/modulepreload/preload hrefs, and refs embedded in
 * the inline RSC payload. Root-absolute, query/hash stripped, deduped.
 */
function extractNextAssetUrls(html) {
  const found = new Set();
  const re = /["']([^"']*\/_next\/static\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    const i = raw.indexOf("/_next/static/");
    let path = i >= 0 ? raw.slice(i) : raw;
    path = path.split("?")[0].split("#")[0];
    if (path.length > "/_next/static/".length) found.add(path);
    if (found.size >= 150) break; // safety cap
  }
  return Array.from(found);
}

/**
 * v3 heart: at install (and as an activate-time heal), fetch the shell HTML,
 * cache it, then precache EVERY /_next/static/ chunk it references, then warm
 * the session + jobs API responses. All failures are non-fatal.
 */
async function precacheShell() {
  const shellCache = await caches.open(SHELL_CACHE);

  // 1. Shell HTML — one fetch, used both for the cache and for parsing.
  let html = null;
  try {
    const res = await fetch(new Request("/", { cache: "reload", credentials: "same-origin" }));
    if (res.ok) {
      const text = await res.clone().text();
      await putInCache(SHELL_CACHE, "/", res);
      html = text;
    }
  } catch (e) {
    /* non-fatal — activate-time heal will retry */
  }

  // 2. Manifest + core icons (individually, so one 404 can't kill install).
  await Promise.all(
    SHELL_URLS.map(async (url) => {
      try {
        await shellCache.add(new Request(url, { cache: "reload" }));
      } catch (e) {
        /* non-fatal */
      }
    })
  );

  // 3. THE v3 FIX — precache every chunk the shell references. Without this,
  // the first visit after a deploy left the chunks uncached (the page loaded
  // them before this SW activated) and offline boot = white screen.
  if (html) {
    const refs = extractNextAssetUrls(html);
    const assetCache = await caches.open(ASSET_CACHE);
    await Promise.all(
      refs.map(async (path) => {
        try {
          // Immutable + content-hashed: the HTTP cache may legally serve these.
          await assetCache.add(path);
        } catch (e) {
          /* non-fatal — runtime cacheFirst still backfills on later visits */
        }
      })
    );
  }

  // 4. Warm the API responses the offline boot needs. Credentials are
  // included (same-origin) so a logged-in session/library snapshot lands in
  // the cache; every later online load refreshes it via network-first.
  await Promise.all(
    API_WARM_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { credentials: "same-origin" }));
        if (res.ok) {
          await putInCache(API_CACHE, url, res);
        }
      } catch (e) {
        /* non-fatal */
      }
    })
  );
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
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
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

/**
 * Navigation: network-first; refresh the cached shell (under the request URL
 * and, for "/"-rooted launches, under the bare "/" key); offline → exact
 * match → "/" shell → branded offline page. Never a blank white screen.
 */
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const c1 = res.clone();
      let c2 = null;
      try {
        if (new URL(request.url).pathname === "/") c2 = res.clone();
      } catch (e) {
        /* non-fatal */
      }
      putInCache(SHELL_CACHE, request, c1);
      if (c2) putInCache(SHELL_CACHE, "/", c2);
    }
    return res;
  } catch (e) {
    const direct = await caches.match(request);
    if (direct) return direct;
    const shell = await caches.match("/");
    if (shell) return shell;
    return offlinePage();
  }
}

// ----- INSTALL: precache the complete app shell -----
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      await self.skipWaiting();
    })()
  );
});

// ----- ACTIVATE: clean old caches + heal + claim -----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("aria-") && !key.endsWith(VERSION))
          .map((key) => caches.delete(key))
      );

      // Heal: if the shell didn't land at install time (flaky network, a
      // mid-deploy 503, or the app being closed mid-install), retry now so
      // offline works without waiting for another SW byte-change.
      try {
        const shellCache = await caches.open(SHELL_CACHE);
        if (!(await shellCache.match("/"))) {
          await precacheShell();
        }
      } catch (e) {
        /* non-fatal */
      }

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
