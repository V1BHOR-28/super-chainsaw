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
