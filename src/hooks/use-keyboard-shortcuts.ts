"use client";

import { useEffect } from "react";
import { usePlayerStore } from "@/lib/player-store";

/**
 * Global keyboard shortcuts for the player. Only active when in player view.
 *   Space / k   play / pause
 *   ArrowLeft   seek -5s
 *   ArrowRight  seek +5s
 *   j           skip -15s
 *   l           skip +15s
 *   m           mute toggle
 *   Escape      back to library / close settings
 */
export function useKeyboardShortcuts() {
  const view = usePlayerStore((s) => s.view);

  useEffect(() => {
    if (view !== "player") return;
    const onKey = (e: KeyboardEvent) => {
      // ignore when typing in inputs
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const s = usePlayerStore.getState();

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          s.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          s.skip(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          s.skip(5);
          break;
        case "j":
          e.preventDefault();
          s.skip(-15);
          break;
        case "l":
          e.preventDefault();
          s.skip(15);
          break;
        case "m":
          e.preventDefault();
          s.toggleMute();
          break;
        case "Escape":
          if (s.showSettings) {
            s.toggleSettings();
          } else {
            s.closePlayer();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
}
