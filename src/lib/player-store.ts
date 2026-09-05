"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChapterMp3Info } from "@/lib/abm-api";

/**
 * A single playing job. In per-chapter mode, the Flask /api/generate
 * produces individual MP3 files per chapter (single_file=false), so the
 * player is a playlist player: it plays chapter N's MP3, then on `onended`
 * advances to chapter N+1's MP3 — gapless playback with exact chapter
 * boundaries.
 *
 * For backward compat, if chapterMp3s is empty, the player falls back to
 * playing a single merged downloadUrl (old single_file=true mode).
 */
export interface PlayerChapterInfo {
  index: number;
  title: string;
  chars: number;
  estimated_minutes: number;
}

export interface PlayingJob {
  jobId: string;
  title: string;
  author: string;
  accent: string;
  /** Single-file download URL (legacy single_file=true mode). Used as
   *  fallback when chapterMp3s is empty. */
  downloadUrl: string;
  /** Per-chapter MP3 metadata from the Flask job. When non-empty, the
   *  player operates in playlist mode. */
  chapterMp3s?: ChapterMp3Info[];
  /** Which chapter indices are in the current audio. */
  selectedChapters?: number[];
  /** Full chapter metadata for the chapter browser. */
  chapters?: PlayerChapterInfo[];
  /** Cover image URL from the Flask /api/cover/<jobId> endpoint. When
   *  absent, the CSS monogram fallback is used. */
  coverImgUrl?: string;
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

  // Playlist state
  currentChapterIdx: number; // index into chapterMp3s array (-1 = no playlist)
  seekToChapter: (idx: number) => void;
  advanceToNextChapter: () => boolean; // returns true if there's a next chapter

  // Playback
  isPlaying: boolean;
  currentTime: number; // absolute seconds across all chapters
  duration: number; // total seconds across all chapters
  playbackRate: number;
  volume: number;
  muted: boolean;

  // ARIA: resume-where-you-left-off
  // When openPlayer restores a saved position, this is set to the restored
  // time (in seconds). The player view shows a "Resumed from X:XX" toast
  // and clears this after a few seconds. Null = no resume (fresh start).
  resumedFrom: number | null;
  clearResumedFrom: () => void;

  // ARIA: offline playback failure — set by the audio engine when the
  // <audio> element errors (typically: chapter not on device + no network).
  // The player view shows a "Not saved on device" notice instead of a
  // silent dead play button. Cleared on chapter/job change + successful load.
  audioError: boolean;
  setAudioError: (v: boolean) => void;

  // UI
  showSettings: boolean;
  showReader: boolean;
  sleepTimerMinutes: number | null;
  sleepTimerEndsAt: number | null;

  // BGM (background music) — simple static ambient loops.
  // bgmTrack: which ambient loop to play ("" = off).
  // bgmVolume: 0-100 slider.
  bgmTrack: string;
  bgmVolume: number;

  // Actions
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (d: number) => void;
  setPlaybackRate: (r: number) => void;
  setVolume: (v: number) => void;
  setBgmTrack: (track: string) => void;
  setBgmVolume: (v: number) => void;
  toggleMute: () => void;

  skip: (seconds: number) => void;

  toggleSettings: () => void;
  toggleReader: () => void;
  setSleepTimer: (minutes: number | null) => void;
  clearSleepTimer: () => void;
}

// ── Playback progress persistence (localStorage) ──
// Saves {chapterIdx, currentTime} per job so the user resumes where they left
// off after a refresh. Throttled by the audio engine (every 5s).
const PROGRESS_KEY_PREFIX = "aria-playback-";
function saveProgress(jobId: string, chapterIdx: number, currentTime: number) {
  try {
    localStorage.setItem(
      PROGRESS_KEY_PREFIX + jobId,
      JSON.stringify({ chapterIdx, currentTime, savedAt: Date.now() }),
    );
  } catch { /* non-blocking */ }
}
function loadProgress(jobId: string): { chapterIdx: number; currentTime: number } | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY_PREFIX + jobId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return { chapterIdx: data.chapterIdx ?? 0, currentTime: data.currentTime ?? 0 };
  } catch { return null; }
}
function clearProgress(jobId: string) {
  try { localStorage.removeItem(PROGRESS_KEY_PREFIX + jobId); } catch { /* */ }
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      view: "landing",
      setView: (v) => set({ view: v }),
      openPlayer: (job) => {
        // Compute total duration from chapterMp3s if available
        const totalDuration = job.chapterMp3s && job.chapterMp3s.length > 0
          ? job.chapterMp3s.reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000
          : 0;

        // Restore saved playback progress from localStorage
        const saved = loadProgress(job.jobId);
        const startChapterIdx = saved && job.chapterMp3s && saved.chapterIdx < job.chapterMp3s.length
          ? saved.chapterIdx
          : (job.chapterMp3s && job.chapterMp3s.length > 0 ? 0 : -1);
        const startTime = saved ? saved.currentTime : 0;

        // ARIA: if we restored a non-trivial position (>3s in), flag it so
        // the player view can show a "Resumed from X:XX" toast. Below 3s
        // is effectively a fresh start — no toast needed.
        const resumedFrom = saved && saved.currentTime > 3 ? saved.currentTime : null;

        set({
          view: "player",
          currentJob: job,
          currentChapterIdx: startChapterIdx,
          currentTime: startTime,
          duration: totalDuration,
          isPlaying: false,
          resumedFrom,
          audioError: false,
        });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },
      closePlayer: () => {
        // Save final progress before closing
        const { currentJob, currentChapterIdx, currentTime } = get();
        if (currentJob) {
          saveProgress(currentJob.jobId, currentChapterIdx, currentTime);
        }
        set({ view: "landing", isPlaying: false, currentChapterIdx: -1 });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },

      currentJob: null,
      currentChapterIdx: -1,

      seekToChapter: (idx) => {
        const { currentJob } = get();
        if (!currentJob?.chapterMp3s || idx < 0 || idx >= currentJob.chapterMp3s.length) return;
        // Compute the absolute start time of this chapter
        const startTime = currentJob.chapterMp3s
          .slice(0, idx)
          .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
        set({ currentChapterIdx: idx, currentTime: startTime });
      },

      advanceToNextChapter: () => {
        const { currentJob, currentChapterIdx } = get();
        if (!currentJob?.chapterMp3s) return false;
        const next = currentChapterIdx + 1;
        if (next >= currentJob.chapterMp3s.length) return false;
        // Set currentTime to the start of the next chapter
        const startTime = currentJob.chapterMp3s
          .slice(0, next)
          .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
        set({ currentChapterIdx: next, currentTime: startTime });
        return true;
      },

      isPlaying: false,
      currentTime: 0,
      duration: 0,
      // ARIA: default playback rate 0.7× — 1.0× sounds too fast for audiobook
      // narration. 0.7× is a comfortable listening pace. The user can still
      // change this via the SpeedControl (0.7, 0.85, 1, 1.15, ...) and their
      // choice is persisted to localStorage.
      playbackRate: 0.7,
      volume: 0.85,
      muted: false,

      // ARIA: resume-where-you-left-off — null until openPlayer restores a
      // saved position. The player view shows a toast + clears it.
      resumedFrom: null,
      clearResumedFrom: () => set({ resumedFrom: null }),

      // ARIA: offline playback failure flag (see interface comment)
      audioError: false,
      setAudioError: (v) => set({ audioError: v }),

      showSettings: false,
      showReader: false,
      bgmTrack: "",
      bgmVolume: 30,
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
      setBgmTrack: (track) => set({ bgmTrack: track }),
      setBgmVolume: (v) => set({ bgmVolume: Math.max(0, Math.min(100, Math.round(v))) }),

      skip: (seconds) => {
        const { currentTime, duration } = get();
        const next = Math.max(0, Math.min(duration || 0, currentTime + seconds));
        set({ currentTime: next });
      },

      toggleSettings: () =>
        set((s) => ({ showSettings: !s.showSettings })),

      toggleReader: () =>
        set((s) => ({ showReader: !s.showReader })),

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
        bgmTrack: s.bgmTrack,
        bgmVolume: s.bgmVolume,
      }),
    }
  )
);
