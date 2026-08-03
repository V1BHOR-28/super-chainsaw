"use client";

import { usePlayerStore } from "@/lib/player-store";
import { useAudioEngine } from "@/hooks/use-audio-engine";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { LibraryView } from "./library-view";
import { PlayerView } from "./player-view";

/**
 * AudiobookWorkspace — the root of ARIA's Audiobooks workspace. Swaps
 * between the library grid and the player, mirroring the standalone
 * audiobook prototype's own page.tsx, but mounted as a workspace inside
 * ARIA's existing sidebar shell instead of a standalone route.
 *
 * Note: the ported player-store's `view` field uses "landing" as its value
 * for "show the grid" (inherited from the original prototype, where it was
 * literally the marketing landing page). Here it just means "library grid" —
 * it has nothing to do with ARIA's own `landing-page.tsx`.
 */
export function AudiobookWorkspace() {
  // useAudioEngine drives playback/timer/sleep-timer/media-session regardless
  // of which sub-view is showing, same as the original prototype.
  useAudioEngine();
  useKeyboardShortcuts();

  const view = usePlayerStore((s) => s.view);

  return view === "player" ? <PlayerView /> : <LibraryView />;
}
