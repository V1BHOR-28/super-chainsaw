# 📱 ARIA Mobile App — Free Android Build Guide

This document explains how the free Capacitor mobile wrapper is wired up,
how to generate a signing keystore, how to add the secrets to GitHub, and
how the GitHub Actions workflow auto-builds a sideloadable APK on every push.

**Total cost: $0.** No paid dev accounts, no Play Store fee, no paid services.

---

## Architecture overview

```
┌─────────────────────────────────────┐
│  Android WebView (Capacitor shell)  │ ← installs on phone, has BG audio
│   - loads NEXT_PUBLIC_MOBILE_URL    │
│   - native plugins via JS bridge    │
└──────────────┬──────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────┐
│  Vercel (Next.js 16, free Hobby)    │ ← your existing deploy
│  - /api/* routes (Prisma, NextAuth) │
│  - /api/abm/* proxy → Python TTS    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Neon Postgres (free tier, pgvector)│
│  + Python audiobook-maker (ngrok)   │
└─────────────────────────────────────┘
```

The mobile app is a thin shell — all logic, auth, DB, and TTS stay server-side.

---

## Files added for mobile

| File | Purpose |
|---|---|
| `capacitor.config.ts` | Capacitor configuration (bundle ID `com.v1bhor28.aria`) |
| `src/lib/mobile.ts` | Runtime detection + lazy bridges to native plugins |
| `src/components/mobile-boot.tsx` | One-shot client-side native shell styling |
| `scripts/generate-keystore.sh` | Generates a self-signed Android release keystore |
| `.github/workflows/build-android.yml` | CI pipeline — builds + releases APK on tag push |
| (patched) `src/lib/auth.ts` | Mobile-aware `SameSite=None; Secure` cookies |
| (patched) `next.config.ts` | `output: "export"` + image opt-out for mobile builds |
| (patched) `src/hooks/use-audio-engine.ts` | Notifies iOS BackgroundAudio plugin of metadata |
| (patched) `src/hooks/use-keyboard-shortcuts.ts` | Disabled on touch devices |
| (patched) `src/app/layout.tsx` | Adds `<MobileBoot/>` + `viewportFit: "cover"` |
| (patched) `src/app/globals.css` | Safe-area utilities + touch-no-select + h-screen-mobile |
| (patched) `package.json` | `mobile:*` scripts + Capacitor deps |

---

## One-time setup (10 minutes)

### Step 1 — Generate a signing keystore locally

```bash
npm run mobile:keystore
```

The script prints **4 values** to your terminal:
- `KEYSTORE_BASE64` (a long block of base64)
- `KEYSTORE_PASSWORD`
- `KEY_ALIAS` (= `aria`)
- `KEY_PASSWORD`

⚠️ Back up `aria-release.jks` to a password manager or USB drive. If you lose
it, future APK updates will be rejected by phones that already have ARIA
installed (signature mismatch).

### Step 2 — Add the values to GitHub as repo secrets

1. Go to `https://github.com/V1BHOR-28/super-chainsaw/settings/secrets/actions`
2. Click **"New repository secret"**
3. Add 4 secrets with the exact names from the script:
   - `KEYSTORE_BASE64`
   - `KEYSTORE_PASSWORD`
   - `KEY_ALIAS`
   - `KEY_PASSWORD`

### Step 3 — Set the MOBILE_URL repo variable

1. Go to `Settings → Secrets and variables → Actions → Variables` (not Secrets)
2. Click **"New variable"**
3. Name: `MOBILE_URL`
4. Value: `https://ariaggn.vercel.app` (or your production URL)

### Step 4 — Merge the PR + push a tag

```bash
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

The workflow triggers automatically. Within ~5 minutes:
- A GitHub Release named `v0.1.0` is created
- The signed APK is attached as a release asset
- A QR code (`install-qr.png`) is also attached
- Anyone with the QR code can scan + install ARIA on Android

---

## Updating the app later

Just push a new tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

A new release is auto-published with the same signing key, so users can install
over the existing version without losing data.

If you push to `main` without a tag, the workflow still builds the APK and
uploads it as a workflow artifact (downloadable from the Actions tab for 30
days), but no Release is created — useful for QA.

---

## Native plugins used (all free / open source)

| Plugin | License | Purpose |
|---|---|---|
| `@capacitor/core` | MIT | Native bridge |
| `@capacitor/android` | MIT | Android platform |
| `@capacitor/app` | MIT | Lifecycle hooks |
| `@capacitor/filesystem` | MIT | Native file picker |
| `@capacitor/preferences` | MIT | Native UserDefaults |
| `@capacitor/status-bar` | MIT | Status bar styling |
| `@capacitor/haptics` | MIT | Touch feedback |
| `@capacitor/keyboard` | MIT | Keyboard events |
| `@capacitor-community/biometric-auth` | MIT | Optional FaceID / fingerprint |
| `@capacitor-community/background-audio` | MIT | iOS lock-screen audio |

---

## What's NOT included (to stay free)

- ❌ Apple App Store distribution ($99/year Apple Developer Program)
- ❌ Google Play Store distribution ($25 one-time registration)
- ❌ Paid Capacitor plugins (none needed — all required features are free)
- ❌ Paid CI/CD (GitHub Actions is free for public repos)
- ❌ Paid hosting (Vercel Hobby + Neon free tier suffice)
- ❌ Push notification paid services (Firebase Cloud Messaging is free, can be added later)

---

## Local dev / testing the build

To run the mobile build locally without an Android Studio install:

```bash
npm install
npm run build:mobile   # builds Next.js in mobile mode + npx cap sync
```

This produces a static `out/` folder that Capacitor can serve. To open the
native project in Android Studio:

```bash
npm run mobile:open:android   # requires Android Studio installed
```

The GitHub Actions workflow does this for you, so you only need Android Studio
locally if you want to debug the native shell interactively.

---

## Troubleshooting

**Build fails in CI with "keystore not found"**
→ You haven't added the `KEYSTORE_BASE64` secret. Re-run step 2 above. The
  workflow falls back to a debug APK if the secret is missing — that's still
  installable but with a different signature each build.

**APK installs but ARIA shows a black screen**
→ Most likely `MOBILE_URL` is not set. Re-run step 3 above. The WebView needs
  to know which deployed Next.js URL to load.

**Auth doesn't persist between sessions**
→ Verify that your Vercel deployment's `NEXTAUTH_URL` env var matches the
  `MOBILE_URL` exactly (including `https://`). NextAuth needs to know its
  public URL to set cookies correctly for cross-origin WebView requests.

**Audio stops when screen locks (Android)**
→ Verify the AndroidManifest patch was applied — check the workflow log for
  "Patched AndroidManifest for foreground audio service". If you're running
  locally without CI, manually add the foreground service permission + service
  declaration as shown in `.github/workflows/build-android.yml` steps.

---

## Roadmap (free, when you're ready)

- [ ] Auto-update prompt: wire up a small "new version available" toast that
      checks the latest GitHub Release via the public API
- [ ] Firebase Cloud Messaging (free) for push notifications
- [ ] Capacitor native share sheet for "share this chapter"
- [ ] In-app file picker that uses `@capacitor/filesystem` instead of `<input type="file">`

---

## 📱 iOS: PWA path (free, no Mac, no Apple Developer account)

**Apple does NOT allow self-signed `.ipa` files to be installed on real iPhones.**
Either you pay Apple $99/year for the Developer Program (then you can build
signed `.ipa` files via CI), or you use the PWA path — which is what ARIA uses.

A **PWA (Progressive Web App)** is a web page that iOS Safari will install as
a real home-screen icon, launch fullscreen with no Safari chrome, persist
storage like a native app, and even work offline. **It is the only $0 path
that puts an app icon on a real iPhone.**

### How it works

1. The Next.js app serves a `manifest.webmanifest` (see `public/`) that
   declares `display: "standalone"`, theme color, and icons.
2. `src/app/layout.tsx` adds `appleWebApp` metadata + raw
   `<link rel="apple-touch-startup-image" media="..." href="...">` tags for
   per-iPhone-resolution launch screens.
3. `src/components/pwa-register.tsx` registers `/sw.js` as a service worker
   for offline support — required by iOS Safari to offer the install prompt.
4. User opens `https://ariaggn.vercel.app` in iOS Safari → Share →
   "Add to Home Screen" → ARIA icon appears alongside native apps.

### Files added for iOS PWA

| File | Purpose |
|---|---|
| `public/manifest.webmanifest` | PWA manifest: name, icons, start_url, shortcuts |
| `public/sw.js` | Offline-first service worker (v4 — full precache + non-destructive updates) |
| `public/icons/icon-{16,32,167,180,192,512}x*.png` | Standard PWA icons |
| `public/icons/icon-{192,512}x*-maskable.png` | Android adaptive-icon variants |
| `public/icons/apple-touch-icon.png` | 180×180 Apple home-screen icon |
| `public/icons/splash-{WxH}.png` | Per-iPhone-resolution launch screens |
| `public/icons/og-image.png` | 1200×630 OpenGraph / Twitter card |
| `src/components/pwa-register.tsx` | Client component that registers `/sw.js` |
| `src/app/layout.tsx` | Metadata: manifest, appleWebApp, splash-screen links |

### How to install on iPhone

1. Open `https://ariaggn.vercel.app` in **Safari** (not Chrome — only Safari
   can install PWAs on iOS).
2. Tap the **Share** button (square with up-arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Confirm — ARIA's icon appears on your home screen. Tap it to launch
   fullscreen with no Safari chrome.

### Offline mode (service worker v4)

The app is **offline-first**: it opens and plays your saved audiobooks with
zero internet — airplane mode, backend stopped, whatever.

How it works:
- The service worker (`public/sw.js`, v4) caches the app shell, **every
  Next.js JS/CSS/font chunk the shell references** (parsed at install time —
  this was the v2 white-screen bug: chunks were only cached at runtime, and
  the first visit after a deploy loaded them before the SW activated, so
  the offline boot had HTML but zero scripts), your auth session, the
  library job list (Set-Cookie headers are stripped before caching — Safari
  rejects cookie-carrying responses, which silently broke the v2 jobs
  cache), the **complete EPUB reader engine (foliate-js)**, and **per-book
  chapter lists + covers for every book in your library** — so the reader
  and the player's book metadata work offline after a single online visit
  (this was the v3 bug: the reader engine and book metadata were only
  runtime-cached, and the v3 update wiped them). Opening
  the PWA offline boots straight into the app instead of a blank screen.
- Chapter audio is stored as blobs in IndexedDB (`src/lib/audio-cache.ts`).
- **Updates are non-destructive**: when a new service-worker version
  activates, cached offline assets (reader engine, book metadata, covers,
  BGM, icons) are migrated into the new version's caches instead of being
  wiped. Only immutable build chunks are discarded (they belong to the old
  deploy).
- If the cache is ever incomplete (e.g. you went offline before ever opening
  the app online since the last deploy), the SW serves a small branded
  "You're offline" page explaining the one-time online visit — never a
  blank white screen.
- **Save a whole book offline**: open the book in the player → Chapters
  panel → **Save offline**. Every chapter MP3 downloads to the device
  (skips already-cached chapters, resumable). A green "Offline ready"
  state confirms the book will play with no network.
- The download also requests `navigator.storage.persist()` so iOS is less
  likely to evict the audio cache under storage pressure.

What works offline:
- App boots (shell + session + library from cache; header shows OFFLINE)
- Playing any book that was saved offline (IndexedDB, no network)
- **Opening any book** — its chapter list + cover are cached for the whole
  library at install time
- Reading EPUBs previously opened (epub-cache, IndexedDB) — the reader
  engine itself is cached too, so the reader opens offline even for a
  fresh install
- Playback position memory, reading positions, settings

What needs internet:
- Generating new audiobooks (your computer's Docker backend)
- Chat (LLM APIs)
- Chapters never played/downloaded before
- New deploys of the app itself

First-run rule: open the app **online once** after each deploy and leave it
a few seconds — the service worker installs and precaches the full shell
(HTML + all JS chunks + session + library list + reader engine + every
book's chapter list and cover) in the background during that visit. After
that, offline works until the next deploy.

**Offline white screen?** It means the current install was never opened
online since the last deploy (nothing is cached yet). Reconnect, open ARIA,
wait ~10 seconds, then try airplane mode again. If it still happens, open
the app once in Safari proper (not the home-screen icon) to force a reload,
then reopen via the icon.

### Caveats (iOS PWA limitations to know)

- **No background audio** — iOS aggressively suspends PWAs when backgrounded.
  Audio playback will stop when the screen locks. (Android WebView via the
  Capacitor build doesn't have this limitation.) Chapters already played once
  are cached on-device (IndexedDB) and replay offline without the backend.
- **Audiobook generation survives a locked phone (fire-and-forget)** — the
  backend refreshes job heartbeats server-side (`ABM_SELF_HEARTBEAT_SEC=30`
  in docker-compose.yml), so you can start a generation, lock the phone, and
  come back later to a finished book. The generation runs on your computer,
  not the phone — only the (tiny) progress poll needs the app open, and even
  that is optional now. Without this flag, jobs are auto-cancelled ~60s
  after the last client heartbeat.
- **No push notifications** — iOS 16.4+ supports web push, but only for apps
  installed from the home screen AND only via the standard Notifications API
  with a user gesture. Limited and flaky.
- **Storage limits** — iOS gives PWAs a smaller quota than native apps
  (usually 1-2GB+; a full offline book is typically 4-40MB). The storage
  persistence grant mitigates eviction, but don't hoard dozens of books.
- **Updates** — Safari checks for SW updates on every PWA launch (`sw.js`
  is served with `Cache-Control: max-age=0, must-revalidate`), so new
  versions arrive on the next open; close and reopen the app once to pick
  them up.

### Regenerating the icon set

If you change the source logo (`public/aria-logo.png`), regenerate the icons:

```bash
python3 scripts/generate_pwa_icons.py
```

The script lives in this repo at `scripts/generate_pwa_icons.py` and uses
Pillow to resize the source into all required PWA / Apple icon / splash
screen sizes.
