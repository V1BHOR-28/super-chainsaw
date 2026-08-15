"use client";

import { usePlayerStore } from "@/lib/player-store";
import { useAudioEngine } from "@/hooks/use-audio-engine";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { LibraryView } from "./library-view";
import { PlayerView } from "./player-view";

/**
 * AudiobookWorkspace — the root of ARIA's Audiobooks workspace. Swaps
 * between the library grid and the player.
 *
 * The audio engine is mounted here (always on) so it can keep driving
 * playback regardless of which sub-view is showing — though with the
 * simplified single-MP3 player, there's no longer any cross-view state
 * to preserve beyond play/pause/seek.
 */
export function AudiobookWorkspace() {
  // useAudioEngine plays the current job's downloadUrl (set by openPlayer).
  // It's a no-op when there's no currentJob.
  useAudioEngine();
  useKeyboardShortcuts();

  const view = usePlayerStore((s) => s.view);

  return view === "player" ? <PlayerView /> : <LibraryView />;
}
