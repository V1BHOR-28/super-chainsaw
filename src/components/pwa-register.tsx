"use client";

import { useEffect } from "react";

/**
 * Registers the minimal ARIA service worker (/sw.js) so iOS Safari will treat
 * the site as an installable PWA and offer "Add to Home Screen".
 *
 * Best-effort: never throws, never blocks first paint. SW registration is
 * deferred until the browser is idle.
 */
export function PWARegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Only register on https (Vercel) or localhost (dev) — service workers
    // require a secure context.
    const isSecure =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost";
    if (!isSecure) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          // SW registration is best-effort — never break the app over it
          console.warn("[pwa] service worker registration failed:", err);
        });
    };

    // Defer until idle so it doesn't compete with first paint.
    // requestIdleCallback isn't in TS DOM lib by default, so cast to any.
    const w = window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout?: number }
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof w.requestIdleCallback === "function") {
      const handle = w.requestIdleCallback(register, { timeout: 3000 });
      return () => {
        if (typeof w.cancelIdleCallback === "function") {
          w.cancelIdleCallback(handle);
        }
      };
    }

    const t = window.setTimeout(register, 1500);
    return () => window.clearTimeout(t);
  }, []);

  return null;
}
