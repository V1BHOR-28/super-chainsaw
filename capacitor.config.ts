import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration — ARIA mobile wrapper.
 *
 * Bundle ID:  com.v1bhor28.aria
 * App name:   ARIA
 * Web dir:    out   (Next.js static export — see "MOBILE.md" for build notes)
 *
 * Strategy
 * --------
 * The mobile app is a thin Capacitor WebView that loads the deployed Next.js
 * app at NEXT_PUBLIC_MOBILE_URL (set as an environment variable in the GitHub
 * Actions workflow). All API routes, NextAuth, Prisma, and the Python TTS
 * backend continue to live on the server — the WebView simply consumes them
 * over HTTPS.
 *
 * Free-only distribution
 * ----------------------
 * - Android:   signed APK auto-built by GitHub Actions, uploaded to Releases
 * - iOS:       skipped (requires $99/year Apple Developer Program)
 * - PWA fallback: still available from the browser for users who can't sideload
 *
 * Native plugins (all free, MIT/Apache)
 * ------------------------------------
 * - @capacitor/filesystem            — native EPUB/PDF picker
 * - @capacitor/preferences          — mirror Zustand persist → native UserDefaults
 * - @capacitor-community/biometric-auth — optional app lock (FaceID/fingerprint)
 * - @capacitor-community/background-audio — iOS BG audio (Android uses Media Session)
 *
 * The background-audio plugin is imported lazily on iOS only; on Android the
 * existing navigator.mediaSession implementation in use-audio-engine.ts already
 * drives the lock-screen notification + continues playback when the screen is off.
 */
const config: CapacitorConfig = {
  appId: "com.v1bhor28.aria",
  appName: "ARIA",
  webDir: "out",
  backgroundColor: "#0a0a0f",
  android: {
    allowMixedContent: false,
    // Required for the Media Session + foreground audio service to keep
    // audiobook playback alive when the screen turns off.
    backgroundColor: "#0a0a0f",
  },
  server: {
    // When NEXT_PUBLIC_MOBILE_URL is set at build time (via .env.local), the
    // WebView loads that URL directly instead of the local `out/` bundle.
    // This lets us ship app-only updates (native plugin bumps) without
    // redeploying the JS bundle.
    url: process.env.NEXT_PUBLIC_MOBILE_URL || undefined,
    cleartext: false,
  },
  plugins: {
    BackgroundAudio: {
      // iOS-specific config; harmless on Android.
      audioSessionCategory: "playback",
      // Keep playing when the ringer is silent (audiobook use case)
      audioSessionMode: "default",
    },
  },
};

export default config;
