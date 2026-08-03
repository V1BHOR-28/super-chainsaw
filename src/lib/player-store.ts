"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * A single playing job. The Flask /api/generate produces ONE MP3 file per
 * job (single_file=true), so the player just plays one continuous audio
 * stream — there's no chapter list, no per-chapter narration state, and
 * no live-narration fallback.
 */
export interface PlayingJob {
  jobId: string;
  title: string;
  author: string;
  accent: string;
  downloadUrl: string;
}

type View = "landing" | "player";

interface PlayerState {
  // View
  view: View;
  setView: (v: View) => void;
  openPlayer: (job: PlayingJob) => void;
  closePlayer: () => void;

  // Current job
  currentJob: PlayingJob | null;

  // Playback
  isPlaying: boolean;
  currentTime: number; // seconds within the single MP3
  duration: number; // total seconds of the MP3
  playbackRate: number;
  volume: number;
  muted: boolean;

  // UI
  showSettings: boolean;
  sleepTimerMinutes: number | null; // null = off
  sleepTimerEndsAt: number | null;

  // Actions
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (d: number) => void;
  setPlaybackRate: (r: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;

  skip: (seconds: number) => void; // positive = forward, negative = back

  toggleSettings: () => void;
  setSleepTimer: (minutes: number | null) => void;
  clearSleepTimer: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      view: "landing",
      setView: (v) => set({ view: v }),
      openPlayer: (job) => {
        set({
          view: "player",
          currentJob: job,
          currentTime: 0,
          duration: 0,
          isPlaying: false,
        });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },
      closePlayer: () => {
        set({ view: "landing", isPlaying: false });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },

      currentJob: null,

      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      volume: 0.85,
      muted: false,

      showSettings: false,
      sleepTimerMinutes: null,
      sleepTimerEndsAt: null,

      play: () => set({ isPlaying: true }),
      pause: () => set({ isPlaying: false }),
      toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
      seek: (time) => set({ currentTime: Math.max(0, time) }),
      setCurrentTime: (time) => set({ currentTime: time }),
      setDuration: (d) => set({ duration: d }),
      setPlaybackRate: (r) => set({ playbackRate: r }),
      setVolume: (v) => set({ volume: v, muted: v === 0 }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),

      skip: (seconds) => {
        const { currentTime, duration } = get();
        const next = Math.max(0, Math.min(duration || 0, currentTime + seconds));
        set({ currentTime: next });
      },

      toggleSettings: () =>
        set((s) => ({ showSettings: !s.showSettings })),

      setSleepTimer: (minutes) => {
        if (minutes === null) {
          set({ sleepTimerMinutes: null, sleepTimerEndsAt: null });
        } else {
          set({
            sleepTimerMinutes: minutes,
            sleepTimerEndsAt: Date.now() + minutes * 60 * 1000,
          });
        }
      },
      clearSleepTimer: () =>
        set({ sleepTimerMinutes: null, sleepTimerEndsAt: null }),
    }),
    {
      name: "aria-audiobooks",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        playbackRate: s.playbackRate,
        volume: s.volume,
      }),
    }
  )
);
