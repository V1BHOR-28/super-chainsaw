"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { DerivedChapter } from "@/lib/audiobook-chapters";

export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: string;
  chapterIndex: number;
  time: number; // seconds within chapter
  note: string;
  createdAt: number;
}

/** The audiobook metadata needed by the player UI. Fetched from /api/audiobooks
 *  and /api/audiobooks/[id]/chapters, not looked up from static data. */
export interface CurrentAudiobook {
  id: string;
  title: string;
  author: string | null;
  accent: string;
  documentId: string;
}

type View = "landing" | "player";

interface PlayerState {
  // View
  view: View;
  setView: (v: View) => void;
  openPlayer: (audiobook: CurrentAudiobook, chapters: DerivedChapter[], chapterIndex?: number) => void;
  closePlayer: () => void;

  // Current audiobook & chapters (fetched from API, not static data)
  currentAudiobook: CurrentAudiobook | null;
  chapters: DerivedChapter[];
  chapterIndex: number;

  // Playback
  isPlaying: boolean;
  currentTime: number; // virtual elapsed time within current chapter (seconds)
  duration: number; // current chapter's estimatedSeconds
  playbackRate: number;
  volume: number;
  muted: boolean;

  // UI
  showChapterList: boolean;
  showBookmarks: boolean;
  showSettings: boolean;
  sleepTimerMinutes: number | null; // null = off
  sleepTimerEndsAt: number | null;

  // Bookmarks (client-side convenience — not synced to server)
  bookmarks: Bookmark[];

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

  nextChapter: () => void;
  prevChapter: () => void;
  goToChapter: (index: number) => void;
  skip: (seconds: number) => void; // positive = forward, negative = back

  toggleChapterList: () => void;
  toggleBookmarks: () => void;
  toggleSettings: () => void;
  setSleepTimer: (minutes: number | null) => void;
  clearSleepTimer: () => void;

  addBookmark: (note?: string) => void;
  removeBookmark: (id: string) => void;
  jumpToBookmark: (b: Bookmark) => void;

  getChapter: () => DerivedChapter | undefined;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      view: "landing",
      setView: (v) => set({ view: v }),
      openPlayer: (audiobook, chapters, chapterIndex) => {
        const idx = chapterIndex !== undefined ? chapterIndex : 0;
        set({
          view: "player",
          currentAudiobook: audiobook,
          chapters,
          chapterIndex: idx,
          currentTime: 0,
          duration: chapters[idx]?.estimatedSeconds ?? 0,
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

      currentAudiobook: null,
      chapters: [],
      chapterIndex: 0,

      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      volume: 0.85,
      muted: false,

      showChapterList: false,
      showBookmarks: false,
      showSettings: false,
      sleepTimerMinutes: null,
      sleepTimerEndsAt: null,

      bookmarks: [],

      play: () => set({ isPlaying: true }),
      pause: () => set({ isPlaying: false }),
      toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
      seek: (time) => set({ currentTime: Math.max(0, time) }),
      setCurrentTime: (time) => set({ currentTime: time }),
      setDuration: (d) => set({ duration: d }),
      setPlaybackRate: (r) => set({ playbackRate: r }),
      setVolume: (v) => set({ volume: v, muted: v === 0 }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),

      nextChapter: () => {
        const { chapters, chapterIndex } = get();
        if (chapterIndex < chapters.length - 1) {
          const next = chapterIndex + 1;
          set({
            chapterIndex: next,
            currentTime: 0,
            duration: chapters[next].estimatedSeconds,
          });
        } else {
          // finished — pause
          set({ isPlaying: false });
        }
      },
      prevChapter: () => {
        const { chapters, chapterIndex, currentTime } = get();
        // if more than 5s in, restart current chapter
        if (currentTime > 5) {
          set({ currentTime: 0 });
          return;
        }
        if (chapterIndex > 0) {
          const prev = chapterIndex - 1;
          set({
            chapterIndex: prev,
            currentTime: 0,
            duration: chapters[prev].estimatedSeconds,
          });
        }
      },
      goToChapter: (index) => {
        const { chapters } = get();
        if (index < 0 || index >= chapters.length) return;
        set({
          chapterIndex: index,
          currentTime: 0,
          duration: chapters[index].estimatedSeconds,
          isPlaying: true,
        });
      },
      skip: (seconds) => {
        const { currentTime, duration } = get();
        const next = Math.max(0, Math.min(duration, currentTime + seconds));
        set({ currentTime: next });
      },

      toggleChapterList: () =>
        set((s) => ({
          showChapterList: !s.showChapterList,
          showBookmarks: false,
          showSettings: false,
        })),
      toggleBookmarks: () =>
        set((s) => ({
          showBookmarks: !s.showBookmarks,
          showChapterList: false,
          showSettings: false,
        })),
      toggleSettings: () =>
        set((s) => ({
          showSettings: !s.showSettings,
          showChapterList: false,
          showBookmarks: false,
        })),
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

      addBookmark: (note) => {
        const { currentAudiobook, chapters, chapterIndex, currentTime } = get();
        if (!currentAudiobook) return;
        const ch = chapters[chapterIndex];
        if (!ch) return;
        const bm: Bookmark = {
          id: `bm-${Date.now()}`,
          bookId: currentAudiobook.id,
          chapterId: ch.title,
          chapterIndex,
          time: currentTime,
          note: note || `${ch.title} · ${Math.floor(currentTime / 60)}:${String(
            Math.floor(currentTime % 60)
          ).padStart(2, "0")}`,
          createdAt: Date.now(),
        };
        set((s) => ({ bookmarks: [bm, ...s.bookmarks] }));
      },
      removeBookmark: (id) =>
        set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) })),
      jumpToBookmark: (b) => {
        const { chapters } = get();
        set({
          chapterIndex: b.chapterIndex,
          currentTime: b.time,
          duration: chapters[b.chapterIndex]?.estimatedSeconds ?? 0,
          isPlaying: true,
        });
      },

      getChapter: () => {
        const { chapters, chapterIndex } = get();
        return chapters[chapterIndex];
      },
    }),
    {
      name: "aria-audiobooks",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        bookmarks: s.bookmarks,
        playbackRate: s.playbackRate,
        volume: s.volume,
      }),
    }
  )
);
