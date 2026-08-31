"use client";

import { useEffect } from "react";
import { styleStatusBarForApp } from "@/lib/mobile";
import { useMobileViewport } from "@/hooks/use-mobile-viewport";

/**
 * MobileBoot — runs once on the client to apply native shell styling when
 * the app is launched inside a Capacitor WebView, and installs the
 * visual-viewport tracker that keeps the app shell sized correctly on
 * iOS Safari / iOS PWA (keyboard + URL-bar aware).
 *
 * Renders null — does not affect layout.
 */
export function MobileBoot() {
  useMobileViewport();

  useEffect(() => {
    styleStatusBarForApp();
  }, []);
  return null;
}
