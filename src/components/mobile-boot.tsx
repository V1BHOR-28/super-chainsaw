"use client";

import { useEffect } from "react";
import { styleStatusBarForApp } from "@/lib/mobile";

/**
 * MobileBoot — runs once on the client to apply native shell styling when
 * the app is launched inside a Capacitor WebView. No-op on the web build.
 *
 * Renders null — does not affect layout.
 */
export function MobileBoot() {
  useEffect(() => {
    styleStatusBarForApp();
  }, []);
  return null;
}
