"use client";

import { useEffect } from "react";
import { usePlayerStore } from "@/lib/player-store";

/**
 * Global keyboard shortcuts for the player. Only active when in player view.
 *   Space       play / pause
 *   ArrowLeft   seek -5s
 *   ArrowRight  seek +5s
 *   j           skip -15s
 *   l           skip +30s
 *   ArrowUp     next chapter
 *   ArrowDown   prev chapter
 *   m           mute toggle
 *   b           add bookmark
 *   Escape      back to library / close panels
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
          s.skip(30);
          break;
        case "ArrowUp":
          e.preventDefault();
          s.nextChapter();
          break;
        case "ArrowDown":
          e.preventDefault();
          s.prevChapter();
          break;
        case "m":
          e.preventDefault();
          s.toggleMute();
          break;
        case "b":
          e.preventDefault();
          s.addBookmark();
          break;
        case "Escape":
          if (s.showChapterList) {
            s.toggleChapterList();
          } else if (s.showBookmarks) {
            s.toggleBookmarks();
          } else if (s.showSettings) {
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
