"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { BOOKS } from "@/lib/audiobooks";

/**
 * Audio engine — drives playback for the player view.
 *
 * Strategy:
 *  - A simulated clock (requestAnimationFrame) advances `currentTime` for
 *    EVERY chapter so the progress bar / chapter durations are always
 *    consistent and every chapter is "listenable" (we don't have real audio
 *    for all 40+ chapters).
 *  - For chapters that DO have a real narration file (book 1 ch.1), a hidden
 *    <audio> element plays the narration in a loop underneath, as atmospheric
 *    accompaniment. The simulation remains the single source of truth for the
 *    timeline so seeking / skipping / chapter duration all stay coherent.
 *  - Syncs play/pause, rate, volume, sleep timer, chapter-end, and Media
 *    Session API into/out of the store.
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const currentBookId = usePlayerStore((s) => s.currentBookId);
  const chapterIndex = usePlayerStore((s) => s.chapterIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const pause = usePlayerStore((s) => s.pause);
  const nextChapter = usePlayerStore((s) => s.nextChapter);

  // create audio element once (for narration ambience)
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    a.loop = true;
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
    };
  }, []);

  // when book/chapter changes: set duration + load narration if available
  useEffect(() => {
    if (!currentBookId) return;
    const book = BOOKS.find((b) => b.id === currentBookId);
    if (!book) return;
    const chapter = book.chapters[chapterIndex];
    if (!chapter) return;

    setDuration(chapter.duration);

    const a = audioRef.current;
    if (book.sampleAudio && chapterIndex === 0 && a) {
      a.src = book.sampleAudio;
      a.load();
      if (isPlaying) {
        a.play().catch(() => {});
      }
    } else if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
  }, [currentBookId, chapterIndex]);

  // play / pause the narration ambience
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentBookId) return;
    const book = BOOKS.find((b) => b.id === currentBookId);
    const hasNarration = book?.sampleAudio && chapterIndex === 0;
    if (!hasNarration) return;
    if (isPlaying) {
      a.play().catch(() => pause());
    } else {
      a.pause();
    }
  }, [isPlaying, currentBookId, chapterIndex]);

  // playbackRate → audio element
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = playbackRate;
  }, [playbackRate]);

  // volume / muted → audio element
  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.volume = muted ? 0 : volume;
      a.muted = muted;
    }
  }, [volume, muted]);

  // simulated clock — the single source of truth for currentTime
  useEffect(() => {
    if (!currentBookId || !isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const book = BOOKS.find((b) => b.id === currentBookId);
    if (!book) return;

    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      const state = usePlayerStore.getState();
      const ch = book.chapters[state.chapterIndex];
      if (!ch) return;
      const newTime = state.currentTime + dt * state.playbackRate;
      if (newTime >= ch.duration) {
        setCurrentTime(ch.duration);
        nextChapter();
        return;
      }
      setCurrentTime(newTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, currentBookId, playbackRate, setCurrentTime, nextChapter]);

  // persist progress periodically
  useEffect(() => {
    if (!currentBookId) return;
    const persist = () => {
      const s = usePlayerStore.getState();
      const book = BOOKS.find((b) => b.id === currentBookId);
      if (!book) return;
      const ch = book.chapters[s.chapterIndex];
      if (!ch) return;
      const prevProg = s.progress[currentBookId];
      const completed =
        s.currentTime >= ch.duration - 1
          ? Array.from(new Set([...(prevProg?.completedChapters ?? []), ch.id]))
          : prevProg?.completedChapters ?? [];
      usePlayerStore.setState((state) => ({
        progress: {
          ...state.progress,
          [currentBookId]: {
            bookId: currentBookId,
            chapterIndex: s.chapterIndex,
            time: s.currentTime,
            completedChapters: completed,
            lastListenedAt: Date.now(),
          },
        },
      }));
    };
    const id = setInterval(persist, 4000);
    return () => clearInterval(id);
  }, [currentBookId]);

  // sleep timer watcher
  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const id = setInterval(() => {
      if (Date.now() >= sleepTimerEndsAt) {
        pause();
        usePlayerStore.getState().clearSleepTimer();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt, pause]);

  // Media Session API for hardware media keys
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentBookId) return;
    const book = BOOKS.find((b) => b.id === currentBookId);
    if (!book) return;
    const ch = book.chapters[chapterIndex];
    if (!ch) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${ch.title} — ${book.title}`,
        artist: book.author,
        album: "ARIA Books",
        artwork: [{ src: book.cover, sizes: "768x1344", type: "image/png" }],
      });
      navigator.mediaSession.setActionHandler("play", () =>
        usePlayerStore.getState().play()
      );
      navigator.mediaSession.setActionHandler("pause", () =>
        usePlayerStore.getState().pause()
      );
      navigator.mediaSession.setActionHandler("previoustrack", () =>
        usePlayerStore.getState().prevChapter()
      );
      navigator.mediaSession.setActionHandler("nexttrack", () =>
        usePlayerStore.getState().nextChapter()
      );
      navigator.mediaSession.setActionHandler("seekbackward", () =>
        usePlayerStore.getState().skip(-15)
      );
      navigator.mediaSession.setActionHandler("seekforward", () =>
        usePlayerStore.getState().skip(30)
      );
    } catch {
      /* ignore */
    }
  }, [currentBookId, chapterIndex]);

  return audioRef;
}
