/**
 * mobile.ts — Runtime detection of the Capacitor native shell + lazy bridges
 * to free native plugins. All native calls are no-ops on the web build so the
 * same code paths work everywhere.
 *
 * Free plugins used (all MIT/Apache-2.0, all confirmed published on npm):
 *   - @capacitor/filesystem             → native EPUB/PDF file picker fallback
 *   - @capacitor/preferences            → mirror Zustand persist → native UserDefaults
 *   - @capacitor/status-bar             → status bar styling
 *
 * Android background audio: handled by the existing Media Session API in
 * use-audio-engine.ts — no extra plugin needed. Lock-screen controls + media
 * notification work out-of-the-box once AndroidManifest.xml declares the
 * foreground service permission (patched by the CI workflow).
 *
 * iOS lock-screen audio + biometric lock are intentionally NOT shipped in
 * v0.1 — they require either an Apple Developer account ($99/yr) or a paid
 * Capacitor plugin. Can be added later if iOS support is needed.
 *
 * All native plugin imports are wrapped in try/catch so the web build never
 * crashes when the packages aren't installed.
 */

import type { MyJob } from "./abm-api";

/** True when this code is running inside the Capacitor native shell. */
export const isNativeMobile = async (): Promise<boolean> => {
  if (typeof window === "undefined") return false;
  try {
    const mod = await import("@capacitor/core");
    return !!mod.Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** Cached platform check — call once on app boot. */
let _isNative: boolean | null = null;
export async function isNative(): Promise<boolean> {
  if (_isNative !== null) return _isNative;
  _isNative = await isNativeMobile();
  return _isNative;
}

/**
 * Notify any native background-audio plugin about the current track. On
 * Android this is a no-op — the Media Session API (already wired up in
 * use-audio-engine.ts) drives the lock-screen media notification natively.
 *
 * Safe to call on every chapter change. Idempotent.
 */
export async function notifyBackgroundAudioOfMetadata(_job: MyJob | null): Promise<void> {
  // Intentional no-op in v0.1. Android uses navigator.mediaSession (already
  // wired up in use-audio-engine.ts). iOS would need @capacitor-community/
  // background-audio but iOS is out of scope for free distribution.
  return;
}

/**
 * Optional biometric lock. Returns true (fail-open) in v0.1 — no biometric
 * plugin is shipped. Can be wired up later if needed.
 */
export async function maybePromptBiometric(): Promise<boolean> {
  return true;
}

/**
 * Capacitor Status Bar styling — sets the iOS / Android status bar to match
 * ARIA's dark theme. Called once on app boot from layout.tsx.
 */
export async function styleStatusBarForApp(): Promise<void> {
  const native = await isNative();
  if (!native) return;

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#0a0a0f" });
  } catch {
    /* non-blocking — older Android versions don't support all calls */
  }
}

/**
 * Hide desktop keyboard shortcuts when running on a touch-only device.
 * use-keyboard-shortcuts.ts calls this on mount.
 */
export async function shouldEnableKeyboardShortcuts(): Promise<boolean> {
  const native = await isNative();
  if (!native) return true; // web — let the user keep shortcuts

  try {
    const platform = (await import("@capacitor/core")).Capacitor.getPlatform();
    if (platform === "ios" || platform === "android") {
      return false; // touch-first
    }
    return true;
  } catch {
    return true;
  }
}
