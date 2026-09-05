"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { getChapterMp3Url } from "@/lib/abm-api";
import { getAudioUrl, getSingleFileAudioUrl } from "@/lib/audio-cache";
import { notifyBackgroundAudioOfMetadata } from "@/lib/mobile";

/**
 * Audio engine — playlist player for per-chapter MP3s.
 *
 * In per-chapter mode (single_file=false), the Flask app produces individual
 * MP3 files per chapter. This engine plays them sequentially:
 *   1. Loads chapter N's MP3 via getChapterMp3Url(jobId, chapterIndex)
 *   2. On `onended`, advances to chapter N+1 and auto-plays (gapless)
 *   3. The store's `currentTime` is absolute across all chapters
 *   4. The store's `duration` is the sum of all chapter durations
 *   5. Seeking computes which chapter + offset to switch to
 *
 * For backward compat (old single_file=true jobs without chapterMp3s),
 * falls back to playing a single downloadUrl.
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isLoadingNewChapter = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const lastProgressSaveRef = useRef<number>(0);

  const currentJob = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
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

  // ── Chapter change: load the new chapter's MP3 ──
  // When currentChapterIdx changes (or the job opens), load the new source.
  // Uses IndexedDB audio cache: if the chapter was played before, it loads
  // instantly from cache (blob: URL) even when the backend is offline.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentJob) return;

    // Reset the offline-failure flag for the new source — it will re-set
    // via the 'error' listener if this source also fails to load.
    usePlayerStore.getState().setAudioError(false);

    // Backward compat: single-file mode (no chapterMp3s) — same cache-first
    // treatment via the `<jobId>:single` key, so legacy jobs play offline too.
    if (!currentJob.chapterMp3s || currentJob.chapterMp3s.length === 0) {
      getSingleFileAudioUrl(currentJob.jobId, currentJob.downloadUrl)
        .then((url) => {
          a.src = url;
          a.load();
        })
        .catch(() => {
          a.src = currentJob.downloadUrl;
          a.load();
        });
      return;
    }

    // Playlist mode
    if (currentChapterIdx < 0 || currentChapterIdx >= currentJob.chapterMp3s.length) return;

    const chInfo = currentJob.chapterMp3s[currentChapterIdx];
    const networkUrl = getChapterMp3Url(currentJob.jobId, chInfo.index);
    isLoadingNewChapter.current = true;

    // Try cache first, fall back to network URL
    getAudioUrl(currentJob.jobId, chInfo.index, networkUrl)
      .then((url) => {
        if (a && !a.paused) a.pause();
        a.src = url;
        a.load();
      })
      .catch(() => {
        // Fallback: use network URL directly
        a.src = networkUrl;
        a.load();
      });
  }, [currentJob, currentChapterIdx]);

  // ── Play / pause control ──
  // NOTE: this effect reacts ONLY to explicit user play/pause intent
  // (isPlaying toggled), NOT to chapter changes. Reacting to currentChapterIdx
  // here was the source of the chapter-boundary glitch: it fired the instant
  // the chapter index changed and called a.play() while a.src still pointed
  // at the OLD chapter's audio (the source swap happens asynchronously in the
  // chapter-load effect above). Resumption after a chapter switch is now
  // handled exclusively by onLoadedMetadata, which fires only after the new
  // source is actually ready — race-free.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentJob) return;
    // Guard: if a new chapter is loading, don't touch playback here —
    // onLoadedMetadata will resume once the new source is ready.
    if (isLoadingNewChapter.current) return;
    if (isPlaying) {
      if (a.paused) {
        a.play().catch(() => usePlayerStore.getState().pause());
      }
    } else {
      if (!a.paused) a.pause();
    }
  }, [isPlaying, currentJob]);

  // ── Audio event handlers: timeupdate, loadedmetadata, ended ──
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onTimeUpdate = () => {
      if (isLoadingNewChapter.current) return;
      const job = usePlayerStore.getState().currentJob;
      if (!job) return;

      // In playlist mode, add the chapter's start offset
      if (job.chapterMp3s && job.chapterMp3s.length > 0 && usePlayerStore.getState().currentChapterIdx >= 0) {
        const idx = usePlayerStore.getState().currentChapterIdx;
        const chapterStart = job.chapterMp3s
          .slice(0, idx)
          .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
        const absTime = chapterStart + a.currentTime;
        setCurrentTime(absTime);

        // Throttled progress save (every 5s)
        const now = Date.now();
        if (now - (lastProgressSaveRef.current || 0) > 5000) {
          lastProgressSaveRef.current = now;
          try {
            localStorage.setItem(
              `aria-playback-${job.jobId}`,
              JSON.stringify({ chapterIdx: idx, currentTime: absTime, savedAt: now }),
            );
          } catch { /* non-blocking */ }
        }
      } else {
        // Single-file mode — also save progress (every 5s)
        setCurrentTime(a.currentTime);
        const now = Date.now();
        if (now - (lastProgressSaveRef.current || 0) > 5000) {
          lastProgressSaveRef.current = now;
          const job2 = usePlayerStore.getState().currentJob;
          if (job2) {
            try {
              localStorage.setItem(
                `aria-playback-${job2.jobId}`,
                JSON.stringify({ chapterIdx: -1, currentTime: a.currentTime, savedAt: now }),
              );
            } catch { /* non-blocking */ }
          }
        }
      }
    };

    const onLoadedMetadata = () => {
      isLoadingNewChapter.current = false;
      usePlayerStore.getState().setAudioError(false);
      const job = usePlayerStore.getState().currentJob;
      if (!job) return;

      // In playlist mode, apply any pending seek offset
      if (job.chapterMp3s && job.chapterMp3s.length > 0) {
        const idx = usePlayerStore.getState().currentChapterIdx;
        if (idx >= 0 && idx < job.chapterMp3s.length) {
          const chapterStart = job.chapterMp3s
            .slice(0, idx)
            .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
          const storeTime = usePlayerStore.getState().currentTime;
          const offset = Math.max(0, storeTime - chapterStart);
          if (offset > 0.5 && offset < a.duration) {
            a.currentTime = offset;
          }
        }
      } else if (a.duration && isFinite(a.duration)) {
        setDuration(a.duration);
      }

      // === SOLE RESUME POINT after a chapter switch ===
      // This is the only place that resumes playback after the source changes.
      // The browser fires loadedmetadata only after the new audio file is
      // actually loaded and ready — so a.play() here is race-free. The old
      // code had THREE places trying to control this (this effect, the
      // play/pause effect reacting to currentChapterIdx, and onEnded's
      // setTimeout) with no coordination — whichever won produced the glitch.
      if (usePlayerStore.getState().isPlaying && a.paused) {
        a.play().catch(() => {});
      }
    };

    const onEnded = () => {
      const job = usePlayerStore.getState().currentJob;
      if (!job) return;

      // In playlist mode, advance to the next chapter. Resumption is handled
      // by onLoadedMetadata (the sole resume point) — no setTimeout needed.
      if (job.chapterMp3s && job.chapterMp3s.length > 0) {
        // Set the loading guard BEFORE advancing the chapter index. Without
        // this, a spurious 'timeupdate' event can fire between onEnded
        // returning and the chapter-load effect running — it would read the
        // NEW chapter index but the OLD audio's currentTime (at ~duration-3s),
        // setting store.currentTime to near the END of the new chapter. Then
        // onLoadedMetadata would seek to that position, making every chapter
        // start at its last ~3 seconds. Setting this synchronously here
        // prevents that race.
        isLoadingNewChapter.current = true;
        usePlayerStore.getState().advanceToNextChapter();
        return;
      }
      // No next chapter or single-file mode — stop
      usePlayerStore.getState().pause();
    };

    // ── Source failure surfacing ──
    // Fires when a.src can't load at all (offline + not cached, 404, …).
    // Without this the play button just silently does nothing offline —
    // with it the player view shows a "Not saved on device" notice.
    const onError = () => {
      if (!a.src || a.src === "") return;
      usePlayerStore.getState().setAudioError(true);
      usePlayerStore.getState().pause();
    };

    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("loadedmetadata", onLoadedMetadata);
    a.addEventListener("durationchange", onLoadedMetadata);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("loadedmetadata", onLoadedMetadata);
      a.removeEventListener("durationchange", onLoadedMetadata);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
    };
  }, [setCurrentTime, setDuration]);

  // playbackRate → audio element
  // ARIA: preservesPitch=true keeps the narrator's voice at a natural pitch
  // even at 1.5×/2× speed (no chipmunk effect). This is the default in Chrome
  // but not in all browsers — set it explicitly.
  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.playbackRate = playbackRate;
      a.preservesPitch = true;
    }
  }, [playbackRate]);

  // volume / muted → audio element
  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.volume = muted ? 0 : volume;
      a.muted = muted;
    }
  }, [volume, muted]);

  // ── Seek subscription (chapter-aware) ──
  // Subscribes to the store directly. When currentTime jumps significantly:
  //   - In single-file mode: set a.currentTime directly (old behavior)
  //   - In playlist mode (same chapter): set a.currentTime to the offset
  //   - In playlist mode (different chapter): call seekToChapter (triggers
  //     the chapter change effect which loads the new MP3)
  useEffect(() => {
    const SEEK_THRESHOLD = 1.5;
    let lastWrittenTime = -1;

    const unsubscribe = usePlayerStore.subscribe((state) => {
      const a = audioRef.current;
      if (!a || !a.src || isLoadingNewChapter.current) return;

      const job = state.currentJob;
      if (!job) return;

      // Single-file mode (backward compat)
      if (!job.chapterMp3s || job.chapterMp3s.length === 0) {
        const delta = Math.abs(state.currentTime - a.currentTime);
        if (delta > SEEK_THRESHOLD && Math.abs(state.currentTime - lastWrittenTime) > 0.1) {
          a.currentTime = state.currentTime;
          lastWrittenTime = state.currentTime;
        }
        return;
      }

      // Playlist mode — compute the chapter-relative time
      const idx = state.currentChapterIdx;
      if (idx < 0) return;

      const chapterStart = job.chapterMp3s
        .slice(0, idx)
        .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
      const relativeTime = state.currentTime - chapterStart;

      // If the target is in a different chapter, switch
      let targetIdx = idx;
      let accStart = 0;
      for (let i = 0; i < job.chapterMp3s.length; i++) {
        const dur = (job.chapterMp3s[i].duration_ms || 0) / 1000;
        if (state.currentTime < accStart + dur) {
          targetIdx = i;
          break;
        }
        accStart += dur;
        targetIdx = i;
      }

      if (targetIdx !== idx) {
        // Different chapter — switch directly without resetting currentTime
        // (seekToChapter would reset to chapter start, losing the user's
        // seek target). setState changes currentChapterIdx, which triggers
        // the chapter change effect to load the new MP3. onLoadedMetadata
        // will then compute the offset from the preserved currentTime.
        usePlayerStore.setState({ currentChapterIdx: targetIdx });
        return;
      }

      // Same chapter — seek within
      const delta = Math.abs(relativeTime - a.currentTime);
      if (delta > SEEK_THRESHOLD && Math.abs(relativeTime - lastWrittenTime) > 0.1) {
        a.currentTime = Math.max(0, relativeTime);
        lastWrittenTime = relativeTime;
      }
    });

    return unsubscribe;
  }, []); // empty deps — subscription created once

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

  // Media Session API
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator) || !currentJob) return;
    try {
      const chapterTitle = currentJob.chapterMp3s && currentChapterIdx >= 0
        ? currentJob.chapterMp3s[currentChapterIdx]?.title
        : undefined;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterTitle ? `${chapterTitle} — ${currentJob.title}` : currentJob.title,
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
    // Also notify the native iOS BackgroundAudio plugin so the lock-screen
    // media controls show the current book's title + cover art. On Android
    // this is a no-op (the Media Session API above already handles it).
    notifyBackgroundAudioOfMetadata(currentJob);
  }, [currentJob, currentChapterIdx]);

  return null;
}
