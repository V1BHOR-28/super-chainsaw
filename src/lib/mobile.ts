/**
 * mobile.ts — Runtime detection of the Capacitor native shell + lazy bridges
 * to free native plugins. All native calls are no-ops on the web build so the
 * same code paths work everywhere.
 *
 * Free plugins used (all MIT/Apache-2.0):
 *   - @capacitor/filesystem             → native EPUB/PDF file picker fallback
 *   - @capacitor/preferences            → mirrors Zustand persist → native UserDefaults
 *   - @capacitor-community/biometric-auth → optional app lock
 *   - @capacitor-community/background-audio → iOS BG audio (Android uses Media Session)
 *
 * The plugins are loaded lazily via dynamic import() so the web bundle is not
 * polluted with native-only code. Tree-shaking will exclude these from the
 * browser build entirely.
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
 * Tell the iOS BackgroundAudio plugin what's currently playing so the
 * lock-screen media controls work. On Android this is a no-op — Android's
 * Media Session API (already wired up in use-audio-engine.ts) handles
 * lock-screen controls automatically without a native plugin.
 *
 * Safe to call on every chapter change. Idempotent.
 */
export async function notifyBackgroundAudioOfMetadata(job: MyJob | null): Promise<void> {
  if (!job) return;
  const native = await isNative();
  if (!native) return;

  // Plugin only needed on iOS — Android uses navigator.mediaSession (handled
  // in use-audio-engine.ts).
  const platform = (await import("@capacitor/core")).Capacitor.getPlatform();
  if (platform !== "ios") return;

  try {
    const { BackgroundAudio } = await import("@capacitor-community/background-audio");
    await BackgroundAudio.updateMetadata({
      artist: job.author || "Unknown author",
      title: job.title,
      album: "ARIA Audiobooks",
      artwork: job.hasCover ? `/api/abm/cover/${job.jobId}` : undefined,
    });
  } catch {
    /* non-blocking */
  }
}

/**
 * Optional biometric lock. If the user enabled it, prompt for FaceID/TouchID/
 * fingerprint before unlocking the app. Returns true if access is granted OR
 * if no biometric is enrolled (fails open to never lock users out).
 */
export async function maybePromptBiometric(): Promise<boolean> {
  const native = await isNative();
  if (!native) return true;

  try {
    const { BiometricAuth } = await import("@capacitor-community/biometric-auth");
    const available = await BiometricAuth.checkBiometry();
    if (!available.isAvailable) return true; // fail open

    await BiometricAuth.authenticate({
      reason: "Unlock ARIA",
      cancelTitle: "Cancel",
      allowDeviceCredential: true,
      iosBiometryType: 0, // 0 = any
      androidTitle: "Unlock ARIA",
      androidSubtitle: "Authenticate to continue",
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false; // user cancelled — caller decides what to do
  }
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

  // On a tablet with a hardware keyboard, still allow shortcuts.
  const platform = (await import("@capacitor/core")).Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") {
    return false; // touch-first
  }
  return true;
}
