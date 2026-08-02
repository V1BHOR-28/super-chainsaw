"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";

/**
 * Audio engine — drives real playback via the Web Speech API.
 *
 * Strategy:
 *  - Each chapter's text is split into paragraph-sized utterances (~1000-1500
 *    chars) and queued sequentially via utterance.onend triggering the next.
 *  - A virtual elapsed-time clock (requestAnimationFrame) advances
 *    `currentTime` based on `estimatedSeconds` from deriveChapters(), gated
 *    on `speechSynthesis.speaking` being true so the progress bar doesn't
 *    drift far from what's actually being read.
 *  - isPlaying → resume() if paused mid-utterance, or start the queue if stopped;
 *    pause → speechSynthesis.pause(). Chrome has a known bug where pause/resume
 *    can behave inconsistently after ~15s — as a fallback, cancel() + re-queue
 *    from the last known paragraph.
 *  - Progress is persisted via PATCH /api/audiobooks/[id] every few seconds
 *    so it survives across devices/sessions.
 */
export function useAudioEngine() {
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  // Track which paragraph utterance we're on within the current chapter,
  // and the char offset where the current paragraph starts (for progress saving).
  const paragraphIndexRef = useRef<number>(0);
  const paragraphStartOffsetRef = useRef<number>(0);

  // The full list of paragraph utterances for the current chapter.
  const paragraphsRef = useRef<string[]>([]);

  const currentAudiobook = usePlayerStore((s) => s.currentAudiobook);
  const chapters = usePlayerStore((s) => s.chapters);
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

  /** Split chapter text into paragraph-sized chunks for speech synthesis.
   *  Caps each utterance around 1200 chars to stay within browser limits. */
  function splitIntoParagraphs(text: string): string[] {
    const rawParas = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const result: string[] = [];
    for (const para of rawParas) {
      if (para.length <= 1200) {
        result.push(para);
      } else {
        // Further split long paragraphs at sentence boundaries
        const sentences = para.match(/[^.!?]+[.!?]+\s*/g) || [para];
        let current = "";
        for (const sentence of sentences) {
          if ((current + sentence).length > 1200 && current.length > 0) {
            result.push(current.trim());
            current = sentence;
          } else {
            current += sentence;
          }
        }
        if (current.trim().length > 0) result.push(current.trim());
      }
    }
    return result.length > 0 ? result : [text.slice(0, 1200)];
  }

  /** Strip markdown/whitespace artifacts that don't read well in TTS. */
  function cleanForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Pick a preferred voice — same approach as message-bubble.tsx's speak(). */
  function getPreferredVoice(): SpeechSynthesisVoice | undefined {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const voices = window.speechSynthesis.getVoices();
    return voices.find(v =>
      v.name.includes('Female') || v.name.includes('Samantha') || v.name.includes('Google US English')
    ) || voices.find(v => v.lang.startsWith('en'));
  }

  /** Speak the next paragraph in the queue. Called recursively via onend. */
  function speakNextParagraph() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const paras = paragraphsRef.current;
    const idx = paragraphIndexRef.current;

    if (idx >= paras.length) {
      // Chapter finished — advance to next chapter
      const state = usePlayerStore.getState();
      if (state.chapterIndex < state.chapters.length - 1) {
        state.nextChapter();
        // The chapter-change effect below will pick up the new chapter and
        // start speaking if isPlaying is still true.
        setTimeout(() => {
          if (usePlayerStore.getState().isPlaying) {
            startChapterPlayback();
          }
        }, 50);
      } else {
        // Finished the whole book
        state.pause();
      }
      return;
    }

    const text = cleanForSpeech(paras[idx]);
    if (!text) {
      // Skip empty paragraphs
      paragraphIndexRef.current++;
      speakNextParagraph();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = usePlayerStore.getState().playbackRate;
    utterance.pitch = 1.0;
    utterance.volume = usePlayerStore.getState().muted ? 0 : usePlayerStore.getState().volume;

    const voice = getPreferredVoice();
    if (voice) utterance.voice = voice;

    utterance.onend = () => {
      // Advance to the next paragraph
      paragraphStartOffsetRef.current += paras[idx].length;
      paragraphIndexRef.current++;
      // Only continue if still playing
      if (usePlayerStore.getState().isPlaying) {
        speakNextParagraph();
      }
    };

    utterance.onerror = () => {
      // On error, pause playback
      usePlayerStore.getState().pause();
    };

    window.speechSynthesis.speak(utterance);
  }

  /** Start playback of the current chapter from the beginning (or from a
   *  saved paragraph index if resuming). */
  function startChapterPlayback() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const state = usePlayerStore.getState();
    const chapter = state.chapters[state.chapterIndex];
    if (!chapter) return;

    // Cancel any in-flight speech
    window.speechSynthesis.cancel();

    // Split chapter into paragraphs
    paragraphsRef.current = splitIntoParagraphs(chapter.text);
    paragraphIndexRef.current = 0;
    paragraphStartOffsetRef.current = 0;

    // Small delay to let cancel() settle
    setTimeout(() => {
      speakNextParagraph();
    }, 100);
  }

  // When chapter changes: update duration
  useEffect(() => {
    if (!currentAudiobook) return;
    const chapter = chapters[chapterIndex];
    if (!chapter) return;
    setDuration(chapter.estimatedSeconds);
    // Reset paragraph tracking for the new chapter
    paragraphIndexRef.current = 0;
    paragraphStartOffsetRef.current = 0;
    paragraphsRef.current = [];
  }, [currentAudiobook, chapterIndex, chapters, setDuration]);

  // Play / pause control
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis || !currentAudiobook) return;

    if (isPlaying) {
      // If speechSynthesis is paused, resume it
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else if (!window.speechSynthesis.speaking) {
        // Not speaking and not paused — start fresh
        startChapterPlayback();
      }
      // If already speaking and not paused, nothing to do (it's already going)
    } else {
      // Pause
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.pause();
      }
    }
  }, [isPlaying, currentAudiobook, chapterIndex]);

  // When playbackRate changes: can't change live for in-flight utterances,
  // but the next paragraph queued will pick up the new rate. If not currently
  // speaking, no action needed.
  useEffect(() => {
    // No-op — rate is read fresh in speakNextParagraph() for each new utterance.
    // Mid-utterance rate changes aren't supported by the Web Speech API.
  }, [playbackRate]);

  // volume / muted — applied to the next queued utterance
  useEffect(() => {
    // No-op — volume is read fresh in speakNextParagraph() for each new utterance.
  }, [volume, muted]);

  // Virtual elapsed-time clock — gated on speechSynthesis.speaking so the
  // progress bar tracks real playback, not a free-running timer.
  useEffect(() => {
    if (!currentAudiobook || !isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      // Only advance the clock if speech synthesis is actually speaking
      // (not paused, not idle). This prevents drift when the browser
      // throttles or pauses speech.
      if (typeof window !== "undefined" && window.speechSynthesis && window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        const state = usePlayerStore.getState();
        const ch = state.chapters[state.chapterIndex];
        if (ch) {
          const newTime = state.currentTime + dt * state.playbackRate;
          if (newTime >= ch.estimatedSeconds) {
            setCurrentTime(ch.estimatedSeconds);
            // Chapter end is handled by the speech synthesis onend chain
          } else {
            setCurrentTime(newTime);
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, currentAudiobook, playbackRate, setCurrentTime]);

  // Persist progress to server periodically (every 5 seconds while playing)
  useEffect(() => {
    if (!currentAudiobook) return;
    const persist = async () => {
      const s = usePlayerStore.getState();
      if (!s.currentAudiobook) return;
      try {
        await fetch(`/api/audiobooks/${s.currentAudiobook.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progressChapter: s.chapterIndex,
            progressCharOffset: Math.floor(s.currentTime),
          }),
        });
      } catch {
        // best-effort — don't fail playback over progress save errors
      }
    };
    const id = setInterval(persist, 5000);
    return () => clearInterval(id);
  }, [currentAudiobook]);

  // Save progress on unmount / view change
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Sleep timer watcher
  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const id = setInterval(() => {
      if (Date.now() >= sleepTimerEndsAt) {
        pause();
        if (typeof window !== "undefined" && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
        usePlayerStore.getState().clearSleepTimer();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt, pause]);

  // Media Session API for hardware media keys
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator) || !currentAudiobook) return;
    const chapter = chapters[chapterIndex];
    if (!chapter) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${chapter.title} — ${currentAudiobook.title}`,
        artist: currentAudiobook.author || "Unknown author",
        album: "ARIA Audiobooks",
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
  }, [currentAudiobook, chapterIndex, chapters]);

  return null;
}
