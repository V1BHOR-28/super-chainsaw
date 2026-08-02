"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { BOOKS, type Book, type Chapter } from "@/lib/audiobooks";

export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: string;
  chapterIndex: number;
  time: number; // seconds within chapter
  note: string;
  createdAt: number;
}

export interface BookProgress {
  bookId: string;
  chapterIndex: number;
  time: number; // seconds within current chapter
  completedChapters: string[];
  lastListenedAt: number;
}

type View = "landing" | "player";

interface PlayerState {
  // View
  view: View;
  setView: (v: View) => void;
  openPlayer: (bookId: string, chapterIndex?: number) => void;
  closePlayer: () => void;

  // Current book & chapter
  currentBookId: string | null;
  chapterIndex: number;

  // Playback
  isPlaying: boolean;
  currentTime: number; // within current chapter (seconds)
  duration: number; // current chapter duration
  playbackRate: number;
  volume: number;
  muted: boolean;

  // UI
  showChapterList: boolean;
  showBookmarks: boolean;
  showSettings: boolean;
  sleepTimerMinutes: number | null; // null = off
  sleepTimerEndsAt: number | null;

  // Bookmarks
  bookmarks: Bookmark[];

  // Progress per book
  progress: Record<string, BookProgress>;

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

  getBook: () => Book | undefined;
  getChapter: () => Chapter | undefined;
  getProgress: (bookId: string) => BookProgress | undefined;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      view: "landing",
      setView: (v) => set({ view: v }),
      openPlayer: (bookId, chapterIndex) => {
        const book = BOOKS.find((b) => b.id === bookId);
        if (!book) return;
        const existing = get().progress[bookId];
        const idx =
          chapterIndex !== undefined
            ? chapterIndex
            : existing?.chapterIndex ?? 0;
        const time = chapterIndex !== undefined ? 0 : existing?.time ?? 0;
        set({
          view: "player",
          currentBookId: bookId,
          chapterIndex: idx,
          currentTime: time,
          duration: book.chapters[idx]?.duration ?? 0,
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

      currentBookId: null,
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
      progress: {},

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
        const { currentBookId, chapterIndex } = get();
        const book = BOOKS.find((b) => b.id === currentBookId);
        if (!book) return;
        if (chapterIndex < book.chapters.length - 1) {
          const next = chapterIndex + 1;
          set({
            chapterIndex: next,
            currentTime: 0,
            duration: book.chapters[next].duration,
          });
        } else {
          // finished — mark complete, pause
          set({ isPlaying: false });
        }
      },
      prevChapter: () => {
        const { currentBookId, chapterIndex, currentTime } = get();
        const book = BOOKS.find((b) => b.id === currentBookId);
        if (!book) return;
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
            duration: book.chapters[prev].duration,
          });
        }
      },
      goToChapter: (index) => {
        const { currentBookId } = get();
        const book = BOOKS.find((b) => b.id === currentBookId);
        if (!book || index < 0 || index >= book.chapters.length) return;
        set({
          chapterIndex: index,
          currentTime: 0,
          duration: book.chapters[index].duration,
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
        const { currentBookId, chapterIndex, currentTime } = get();
        const book = BOOKS.find((b) => b.id === currentBookId);
        if (!book) return;
        const ch = book.chapters[chapterIndex];
        if (!ch) return;
        const bm: Bookmark = {
          id: `bm-${Date.now()}`,
          bookId: currentBookId!,
          chapterId: ch.id,
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
        get().openPlayer(b.bookId, b.chapterIndex);
        // give player a tick to mount then seek
        setTimeout(() => {
          set({ currentTime: b.time, isPlaying: true });
        }, 80);
      },

      getBook: () => {
        const id = get().currentBookId;
        return BOOKS.find((b) => b.id === id);
      },
      getChapter: () => {
        const book = get().getBook();
        return book?.chapters[get().chapterIndex];
      },
      getProgress: (bookId) => get().progress[bookId],
    }),
    {
      name: "aria-audiobooks",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        bookmarks: s.bookmarks,
        progress: s.progress,
        playbackRate: s.playbackRate,
        volume: s.volume,
      }),
    }
  )
);
