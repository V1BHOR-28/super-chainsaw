"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

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

/** A materialized chapter row — carries TTS generation status + audio URL. */
export interface PlayerChapter {
  id: string;
  chapterIndex: number;
  title: string;
  cleanedText: string;
  status: string; // pending | generating | ready | failed
  audioUrl: string | null;
  durationSeconds: number | null;
}

type View = "landing" | "player";

interface PlayerState {
  // View
  view: View;
  setView: (v: View) => void;
  openPlayer: (audiobook: CurrentAudiobook, chapters: PlayerChapter[], chapterIndex?: number) => void;
  closePlayer: () => void;

  // Current audiobook & chapters (fetched from API, not static data)
  currentAudiobook: CurrentAudiobook | null;
  chapters: PlayerChapter[];
  chapterIndex: number;

  // Narration generation status for the current chapter
  narrating: boolean; // true while generating audio for the current chapter
  usingLiveNarration: boolean; // true if falling back to speechSynthesis (generation failed)
  setNarrating: (v: boolean) => void;
  setUsingLiveNarration: (v: boolean) => void;
  updateChapterStatus: (chapterId: string, status: string, audioUrl?: string | null) => void;

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

  getChapter: () => PlayerChapter | undefined;
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
          duration: chapters[idx]?.durationSeconds ?? 0,
          isPlaying: false,
          narrating: false,
          usingLiveNarration: false,
        });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },
      closePlayer: () => {
        set({ view: "landing", isPlaying: false, narrating: false, usingLiveNarration: false });
        if (typeof window !== "undefined") {
          window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        }
      },

      currentAudiobook: null,
      chapters: [],
      chapterIndex: 0,

      narrating: false,
      usingLiveNarration: false,
      setNarrating: (v) => set({ narrating: v }),
      setUsingLiveNarration: (v) => set({ usingLiveNarration: v }),
      updateChapterStatus: (chapterId, status, audioUrl) =>
        set((s) => ({
          chapters: s.chapters.map((ch) =>
            ch.id === chapterId
              ? { ...ch, status, audioUrl: audioUrl !== undefined ? audioUrl : ch.audioUrl }
              : ch
          ),
        })),

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
            duration: chapters[next].durationSeconds ?? 0,
            narrating: false,
            usingLiveNarration: false,
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
            duration: chapters[prev].durationSeconds ?? 0,
            narrating: false,
            usingLiveNarration: false,
          });
        }
      },
      goToChapter: (index) => {
        const { chapters } = get();
        if (index < 0 || index >= chapters.length) return;
        set({
          chapterIndex: index,
          currentTime: 0,
          duration: chapters[index].durationSeconds ?? 0,
          isPlaying: true,
          narrating: false,
          usingLiveNarration: false,
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
          duration: chapters[b.chapterIndex]?.durationSeconds ?? 0,
          isPlaying: true,
          narrating: false,
          usingLiveNarration: false,
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
