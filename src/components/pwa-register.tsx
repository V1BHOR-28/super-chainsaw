"use client";

import { useEffect } from "react";
import { toast } from "@/hooks/use-toast";

/**
 * Registers the ARIA service worker (/sw.js) so iOS Safari treats the site
 * as an installable PWA and offers "Add to Home Screen".
 *
 * Offline update flow (v5): `updateViaCache: "none"` makes the browser
 * ALWAYS fetch sw.js from the network — never a stale HTTP-cached copy —
 * so a new deploy is picked up on the first launch after it ships. The
 * SW itself calls skipWaiting + clients.claim(), which means the new
 * version activates in the background while the app keeps running on the
 * old (already-cached, fully functional) shell. The next cold launch uses
 * the new shell. No reload ritual, no 10-second wait — just an optional
 * toast telling the user an update landed.
 *
 * Best-effort: never throws, never blocks first paint. Registration is
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

    let updateToasted = false;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          // A new version finished installing while this page was open.
          // Inform (don't reload) — the update applies on next launch.
          const notifyUpdate = () => {
            if (updateToasted) return;
            updateToasted = true;
            try {
              toast({
                title: "ARIA updated",
                description: "The new version finishes installing — it takes effect next time you open the app.",
              });
            } catch {
              /* toast system not mounted — non-fatal */
            }
          };

          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                notifyUpdate();
              }
            });
          });

          // Cover the case where the update already finished installing
          // before this listener attached (Safari can be quick).
          if (registration.waiting && navigator.serviceWorker.controller) {
            notifyUpdate();
          }
        })
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
