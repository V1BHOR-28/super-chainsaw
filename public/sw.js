/**
 * ARIA service worker v5 — offline-first, complete offline media layer.
 *
 * v4 fixed offline audio + reader metadata (foliate precache, per-book
 * job_chapters/cover prefetch, non-destructive cache migration). What
 * still hurt was UX: updates needed a "stay online ~10s" ritual and the
 * app never told the user what was actually saved on device.
 *
 * v5 changes (app-side, SW just follows):
 *   - Registered with `updateViaCache: "none"` (pwa-register.tsx) — the
 *     browser always re-fetches sw.js from the network, so deploys are
 *     picked up on first launch after they ship. Combined with skipWaiting
 *     + clients.claim() (kept from v3/v4), a new version activates in the
 *     background while the running page keeps its (complete, cached) old
 *     shell. Next cold launch = new shell. No reload ritual.
 *   - Audio/EPUB/cover downloads are now orchestrated by the app's
 *     offline-manager (IndexedDB blobs) — this SW intentionally keeps
 *     chapter_mp3 + epub_file as passthrough (Range requests + large
 *     bodies don't belong in the Cache API).
 *   - Version bump triggers the v4 non-destructive migration + a fresh
 *     install-time precache so the first launch after this deploy
 *     re-caches the new build's chunks.
 *
 * Install precache (kept from v4):
 *   shell HTML + every /_next chunk it references + manifest/icons +
 *   the complete foliate-js engine (8 files) + session + my_jobs +
 *   job_chapters/cover for every book in the library.
 *
 * Runtime strategies (unchanged):
 *   - /_next/static/* + static prefixes + foliate-js: CACHE-FIRST.
 *   - Navigation: NETWORK-FIRST, cached shell fallback.
 *   - /api/auth/session + /api/abm/my_jobs: NETWORK-FIRST w/ offline cache.
 *   - /api/abm/cover/* + job_chapters/*: STALE-WHILE-REVALIDATE.
 *   - POSTs / chapter_mp3 streams / SSE: passthrough.
 */

const VERSION = "aria-pwa-v5";
const SHELL_CACHE = `aria-shell-${VERSION}`; // "/" HTML + manifest + icons
const ASSET_CACHE = `aria-assets-${VERSION}`; // /_next/static + foliate + static
const API_CACHE = `aria-api-${VERSION}`; // session + my_jobs + chapters + covers

const SHELL_URLS = [
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

// The complete foliate-js EPUB engine: view.js statically imports the first
// five; epub.js + paginator.js + vendor/zip.js are dynamically imported when
// a book is opened. Total ~180KB — cheap to precache, priceless offline.
// (pdf.js + its vendor bundle are intentionally excluded: heavy, and only
// needed for PDF reading — runtime caching + migration cover them.)
const FOLIATE_URLS = [
  "/foliate-js/view.js",
  "/foliate-js/epubcfi.js",
  "/foliate-js/progress.js",
  "/foliate-js/overlayer.js",
  "/foliate-js/text-walker.js",
  "/foliate-js/epub.js",
  "/foliate-js/paginator.js",
  "/foliate-js/vendor/zip.js",
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

/** Inline last-resort page — never a blank white screen. */
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

/** Fetch + cache a URL with credentials; returns the JSON text or null. */
async function warmJson(url) {
  try {
    const res = await fetch(new Request(url, { credentials: "same-origin" }));
    if (!res.ok) return null;
    const clone = res.clone();
    putInCache(API_CACHE, url, res);
    return await clone.text();
  } catch (e) {
    return null;
  }
}

/**
 * v4 heart: complete install-time precache.
 *   shell HTML + every /_next chunk it references + manifest/icons +
 *   the full foliate-js engine + session + my_jobs +
 *   job_chapters/cover for every book in my_jobs.
 */
async function precacheShell() {
  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);

  // 1. Shell HTML
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

  // 2. Manifest + core icons
  await Promise.all(
    SHELL_URLS.map(async (url) => {
      try {
        await shellCache.add(new Request(url, { cache: "reload" }));
      } catch (e) {
        /* non-fatal */
      }
    })
  );

  // 3. Every /_next/static chunk the shell references (v3 fix)
  if (html) {
    const refs = extractNextAssetUrls(html);
    await Promise.all(
      refs.map(async (path) => {
        try {
          await assetCache.add(path);
        } catch (e) {
          /* non-fatal — runtime cacheFirst still backfills */
        }
      })
    );
  }

  // 4. The complete foliate-js EPUB engine (v4 fix — BUG A)
  await Promise.all(
    FOLIATE_URLS.map(async (url) => {
      try {
        await assetCache.add(new Request(url, { cache: "reload" }));
      } catch (e) {
        /* non-fatal — migration may restore it from the previous version */
      }
    })
  );

  // 5. Warm session + my_jobs (v3 fix)
  const jobsText = await warmJson("/api/abm/my_jobs");
  await warmJson("/api/auth/session");

  // 6. Warm job_chapters + cover for EVERY book in the library (v4 fix —
  //    BUG B): parse the my_jobs JSON we just fetched and prefetch each
  //    book's metadata + cover. ~1 request per book, all non-fatal.
  if (jobsText) {
    try {
      const data = JSON.parse(jobsText);
      const jobs = (data && data.jobs) || [];
      await Promise.all(
        jobs.map(async (job) => {
          const id = job && job.job_id;
          if (!id || typeof id !== "string" || !/^[A-Za-z0-9_-]{6,}$/.test(id)) return;
          warmJson(`/api/abm/job_chapters/${id}`).catch(() => {});
          // covers: plain binary — cache directly, only if the book has one
          if (job.has_cover) {
            try {
              const res = await fetch(new Request(`/api/abm/cover/${id}`, { credentials: "same-origin" }));
              if (res.ok) putInCache(API_CACHE, `/api/abm/cover/${id}`, res);
            } catch (e) {
              /* non-fatal */
            }
          }
        })
      );
    } catch (e) {
      /* non-fatal — my_jobs parse issue */
    }
  }
}

/**
 * v4 non-destructive version upgrade (BUG C / regression guard): before
 * deleting the previous version's caches, MIGRATE their entries into the
 * new caches (existing new entries win). Immutable /_next/static chunks are
 * NOT migrated (they belong to the old build); everything else — foliate
 * engine, bgm, icons, job_chapters, covers, my_jobs — is preserved so a
 * deploy never strips assets the offline app depends on.
 */
async function migrateOldCaches() {
  const keys = await caches.keys();
  const oldKeys = keys.filter(
    (key) => key.startsWith("aria-") && !key.endsWith(VERSION)
  );
  if (!oldKeys.length) return;

  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);
  const apiCache = await caches.open(API_CACHE);
  const newAssetKeys = new Set(
    (await assetCache.keys()).map((r) => new URL(r.url).pathname)
  );
  const newApiKeys = new Set(
    (await apiCache.keys()).map((r) => new URL(r.url).pathname)
  );
  const newShellKeys = new Set(
    (await shellCache.keys()).map((r) => new URL(r.url).pathname)
  );

  for (const key of oldKeys) {
    try {
      const old = await caches.open(key);
      const entries = await old.keys();
      for (const req of entries) {
        const path = new URL(req.url).pathname;
        try {
          if (key.includes("-shell-")) {
            if (!newShellKeys.has(path)) {
              const res = await old.match(req);
              if (res) await shellCache.put(req, res);
              newShellKeys.add(path);
            }
          } else if (key.includes("-assets-")) {
            if (path.startsWith("/_next/static/")) continue; // old build
            if (!newAssetKeys.has(path)) {
              const res = await old.match(req);
              if (res) await assetCache.put(req, res);
              newAssetKeys.add(path);
            }
          } else if (key.includes("-api-")) {
            if (!newApiKeys.has(path)) {
              const res = await old.match(req);
              if (res) await apiCache.put(req, res);
              newApiKeys.add(path);
            }
          }
        } catch (e) {
          /* non-fatal — entry skipped */
        }
      }
    } catch (e) {
      /* non-fatal — cache skipped */
    }
  }

  // Old caches are now fully merged — safe to delete.
  await Promise.all(oldKeys.map((key) => caches.delete(key)));
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

// ----- INSTALL: precache the complete offline app -----
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      await self.skipWaiting();
    })()
  );
});

// ----- ACTIVATE: migrate old caches, clean up, heal, claim -----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1. Non-destructive migration of the previous version's entries,
      //    then deletion of the old caches.
      await migrateOldCaches();

      // 2. Remove any OTHER stale aria-* caches (e.g. from aborted installs).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("aria-") && !key.endsWith(VERSION))
          .map((key) => caches.delete(key))
      );

      // 3. Heal: if the shell didn't land at install time (flaky network,
      //    mid-deploy 503, app closed mid-install), retry now.
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

  // 2. Immutable build assets + static assets + foliate engine — cache-first
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
