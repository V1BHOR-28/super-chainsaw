"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";

/**
 * Audio engine — plays the single MP3 produced by the audiobook-maker
 * Flask app for the currently-open job.
 *
 * Responsibilities:
 *   - load the downloadUrl into a real <audio> element when a job opens
 *   - play / pause / seek / skip ±15s
 *   - sync playbackRate + volume + muted into the element
 *   - track currentTime + duration back into the store (drives the scrubber)
 *   - honor the sleep timer
 *   - expose Media Session metadata for OS-level controls
 *
 * REMOVED vs the legacy engine:
 *   - chapter-by-chapter playback (the Flask app produces a single MP3)
 *   - live narration / speechSynthesis fallback
 *   - per-chapter status polling + PATCH /api/audiobooks/[id] progress save
 *     (the Flask app keeps state in-memory only; jobs expire after 18h)
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const currentJob = usePlayerStore((s) => s.currentJob);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const pause = usePlayerStore((s) => s.pause);

  // Create audio element once
  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    audioRef.current = a;
    return () => {
      a.pause();
      a.src = "";
    };
  }, []);

  // When the current job changes: load the new source.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentJob) return;
    a.src = currentJob.downloadUrl;
    a.load();
    setDuration(0);
    setCurrentTime(0);
  }, [currentJob, setDuration, setCurrentTime]);

  // Play / pause control
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentJob) return;
    if (isPlaying) {
      if (a.paused) {
        a.play().catch(() => usePlayerStore.getState().pause());
      }
    } else {
      if (!a.paused) a.pause();
    }
  }, [isPlaying, currentJob]);

  // Sync <audio> element time updates → store
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTimeUpdate = () => setCurrentTime(a.currentTime);
    const onLoadedMetadata = () => {
      if (a.duration && isFinite(a.duration)) {
        setDuration(a.duration);
      }
    };
    const onEnded = () => {
      usePlayerStore.getState().pause();
    };
    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("loadedmetadata", onLoadedMetadata);
    a.addEventListener("durationchange", onLoadedMetadata);
    a.addEventListener("ended", onEnded);
    return () => {
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("loadedmetadata", onLoadedMetadata);
      a.removeEventListener("durationchange", onLoadedMetadata);
      a.removeEventListener("ended", onEnded);
    };
  }, [setCurrentTime, setDuration]);

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

  // Seek → actually move the <audio> element's playhead.
  //
  // Subscribe to the store directly rather than using a useEffect on
  // currentTime, because currentTime changes on EVERY timeupdate tick
  // (many times per second). Reacting to every change would cause an
  // infinite loop: audio fires timeupdate → store updates → effect fires
  // → sets audio.currentTime → audio fires timeupdate → ...
  useEffect(() => {
    const SEEK_THRESHOLD = 1.5; // seconds — natural playback never jumps this far per tick
    let lastWrittenTime = -1;

    const unsubscribe = usePlayerStore.subscribe((state) => {
      const a = audioRef.current;
      if (!a || !a.src) return;

      const storeTime = state.currentTime;
      const delta = Math.abs(storeTime - a.currentTime);
      if (delta > SEEK_THRESHOLD && Math.abs(storeTime - lastWrittenTime) > 0.1) {
        a.currentTime = storeTime;
        lastWrittenTime = storeTime;
      }
    });

    return unsubscribe;
  }, []); // empty deps — subscription created once and cleaned up on unmount

  // Sleep timer watcher
  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const id = setInterval(() => {
      if (Date.now() >= sleepTimerEndsAt) {
        pause();
        const a = audioRef.current;
        if (a) a.pause();
        usePlayerStore.getState().clearSleepTimer();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt, pause]);

  // Media Session API — exposes play/pause/seek to OS-level media controls
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator) || !currentJob) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentJob.title,
        artist: currentJob.author || "Unknown author",
        album: "ARIA Audiobooks",
      });
      navigator.mediaSession.setActionHandler("play", () => usePlayerStore.getState().play());
      navigator.mediaSession.setActionHandler("pause", () => usePlayerStore.getState().pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => usePlayerStore.getState().skip(-15));
      navigator.mediaSession.setActionHandler("seekforward", () => usePlayerStore.getState().skip(15));
    } catch {
      /* ignore */
    }
  }, [currentJob]);

  return null;
}
