"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { useBgmCuesStore } from "@/lib/bgm-cues-store";
import { getBgmAssetUrl } from "@/lib/abm-api";
import { getAudioElement } from "@/lib/audio-element-registry";
import type { BgmCue } from "@/lib/abm-api";

/**
 * useBgmEngine — runtime BGM (background music) mixer.
 *
 * Runs alongside useAudioEngine + useWordSync. When the current chapter has
 * BGM cues (bgm_mode="runtime"), this hook:
 *
 *   1. Lazily creates one hidden `<audio loop>` per mood (preload="none").
 *   2. In a requestAnimationFrame loop, binary-searches the current cue based
 *      on the main audio's chapter-relative currentTime.
 *   3. Crossfades the outgoing mood's volume → 0 and the incoming → its gain
 *      over 1.5s (linear ramp on audio.volume, gain_db → linear).
 *   4. Applies the user's bgmVolume slider (0-100%) and bgmEnabled toggle.
 *   5. Pauses/resumes all BGM elements in lockstep with the main audio.
 *   6. On seek, jumps the active loop to (currentTime - cue.start) % loopDuration.
 *
 * Fail-soft: if cues are missing, assets fail to load, or BGM is disabled,
 * the hook is a no-op — clean narration plays without music.
 *
 * This hook does NOT touch use-word-sync.ts, transcript-view.tsx, or the
 * existing audio engine. It reads `audio.currentTime` from the shared
 * audio-element-registry singleton (same as useWordSync).
 */

const CROSSFADE_MS = 1500;
const SEEK_THRESHOLD_SEC = 1.5;

/** Per-element volume ramp state. Updated by the rAF loop. */
interface ElementRamp {
  startVolume: number;
  targetVolume: number;
  transitionStart: number; // performance.now() ms
  playing: boolean;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Binary-search the cue that contains time `t` (seconds, chapter-relative).
 *  Returns -1 if no cue covers `t` (silence gap or before first cue). */
function findActiveCueIndex(cues: BgmCue[], t: number): number {
  let lo = 0, hi = cues.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      // Check if t is within this cue's [start, end) range.
      if (t < cues[mid].end) result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function useBgmEngine() {
  const currentJob = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const bgmEnabled = usePlayerStore((s) => s.bgmEnabled);
  const bgmVolume = usePlayerStore((s) => s.bgmVolume);

  const fetchCues = useBgmCuesStore((s) => s.fetchCues);

  // ── Refs (read by the rAF loop at 60fps — no React re-renders) ──
  const cuesRef = useRef<BgmCue[]>([]);
  const elementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const rampsRef = useRef<Map<string, ElementRamp>>(new Map());
  const activeMoodRef = useRef<string | null>(null);
  const bgmEnabledRef = useRef(bgmEnabled);
  const bgmVolumeRef = useRef(bgmVolume);
  const lastTimeRef = useRef(0); // for seek detection
  const initializedRef = useRef(false);

  // Keep refs in sync with React state (the rAF loop reads refs, not state).
  useEffect(() => { bgmEnabledRef.current = bgmEnabled; }, [bgmEnabled]);
  useEffect(() => { bgmVolumeRef.current = bgmVolume; }, [bgmVolume]);

  // ── Lazy element creation ──
  function getOrCreateElement(mood: string): HTMLAudioElement | null {
    let el = elementsRef.current.get(mood);
    if (el) return el;
    try {
      el = new Audio();
      el.src = getBgmAssetUrl(mood);
      el.loop = true;
      el.preload = "auto";
      el.volume = 0;
      elementsRef.current.set(mood, el);
      rampsRef.current.set(mood, {
        startVolume: 0,
        targetVolume: 0,
        transitionStart: 0,
        playing: false,
      });
      return el;
    } catch {
      return null;
    }
  }

  /** Stop all BGM elements (pause + volume 0). Used on chapter change / disable. */
  function stopAll() {
    activeMoodRef.current = null;
    for (const [mood, el] of elementsRef.current) {
      try {
        el.pause();
        el.currentTime = 0;
        el.volume = 0;
      } catch { /* */ }
      const ramp = rampsRef.current.get(mood);
      if (ramp) {
        ramp.startVolume = 0;
        ramp.targetVolume = 0;
        ramp.playing = false;
      }
    }
  }

  /** Pause all BGM elements (keep volume state for resume). */
  function pauseAll() {
    for (const [, el] of elementsRef.current) {
      try { el.pause(); } catch { /* */ }
    }
    for (const [, ramp] of rampsRef.current) {
      ramp.playing = false;
    }
  }

  /** Resume the active mood's element. */
  function resumeActive() {
    const mood = activeMoodRef.current;
    if (!mood) return;
    const el = elementsRef.current.get(mood);
    if (!el) return;
    const ramp = rampsRef.current.get(mood);
    if (!ramp || ramp.targetVolume <= 0) return;
    try { el.play().catch(() => {}); ramp.playing = true; } catch { /* */ }
  }

  // ── Fetch cues when chapter changes ──
  useEffect(() => {
    if (!currentJob?.chapterMp3s || currentChapterIdx < 0) {
      cuesRef.current = [];
      stopAll();
      return;
    }
    const chInfo = currentJob.chapterMp3s[currentChapterIdx];
    if (!chInfo) {
      cuesRef.current = [];
      stopAll();
      return;
    }
    // Stop BGM for the previous chapter; the new chapter's cues will arrive shortly.
    stopAll();
    cuesRef.current = [];

    let cancelled = false;
    fetchCues(currentJob.jobId, chInfo.index).then((cues) => {
      if (cancelled) return;
      cuesRef.current = cues || [];
      initializedRef.current = true;
      // ARIA: diagnostic logging — log the fetched cue count once per chapter
      // change so we can verify the frontend is receiving non-empty cues.
      console.log(`[bgm-engine] chapter ${chInfo.index}: fetched ${cues?.length ?? 0} cues`);
    });
    return () => { cancelled = true; };
  }, [currentJob?.jobId, currentChapterIdx, fetchCues]);

  // ── Pause/resume lockstep with main audio ──
  useEffect(() => {
    if (!isPlaying) {
      pauseAll();
    } else {
      // ARIA: Prime the BGM audio elements for autoplay. Browsers block
      // audio.play() calls that aren't initiated by a user gesture. The
      // user clicking "play" on the main audio IS a gesture, but the rAF
      // loop's el.play() call happens asynchronously and may be blocked.
      // By calling play() here (inside the isPlaying effect, which fires
      // in response to the user's click), we "unlock" the audio element.
      // The rAF loop will fade it in when the first cue becomes active.
      for (const [mood, el] of elementsRef.current) {
        if (el.paused) {
          try {
            el.play().then(() => {
              // Successfully unlocked — the rAF loop will fade it in.
            }).catch((e) => {
              console.warn(`[bgm-engine] play() blocked for mood "${mood}":`, e);
            });
          } catch { /* */ }
        }
      }
      resumeActive();
    }
  }, [isPlaying]);

  // ── BGM enabled/disabled ──
  useEffect(() => {
    if (!bgmEnabled) {
      stopAll();
    }
  }, [bgmEnabled]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      for (const [, el] of elementsRef.current) {
        try { el.pause(); el.src = ""; } catch { /* */ }
      }
      elementsRef.current.clear();
      rampsRef.current.clear();
    };
  }, []);

  // ── The rAF loop: cue lookup + crossfade ──
  useEffect(() => {
    if (!bgmEnabled) return; // loop only runs when BGM is enabled

    let rafId = 0;

    const loop = () => {
      rafId = requestAnimationFrame(loop);
      const audio = getAudioElement();
      if (!audio || !isPlaying) return;
      const cues = cuesRef.current;
      if (!cues || cues.length === 0) return;

      const t = audio.currentTime; // chapter-relative seconds

      // ── Seek detection: large jump → reposition active loop ──
      const prevT = lastTimeRef.current;
      const delta = Math.abs(t - prevT);
      if (prevT > 0 && delta > SEEK_THRESHOLD_SEC) {
        const idx = findActiveCueIndex(cues, t);
        const newMood = idx >= 0 ? cues[idx].mood : null;
        // If the seek lands in a music cue, jump the loop to maintain sync.
        if (newMood && newMood !== "silence") {
          const el = getOrCreateElement(newMood);
          if (el) {
            const cue = cues[idx];
            const loopDur = el.duration && isFinite(el.duration) ? el.duration : 30;
            const offset = (t - cue.start) % loopDur;
            try { el.currentTime = Math.max(0, offset); } catch { /* */ }
          }
        }
        // Force-update activeMood to match the new position.
        activeMoodRef.current = newMood && newMood !== "silence" ? newMood : null;
      }
      lastTimeRef.current = t;

      // ── Cue lookup ──
      const idx = findActiveCueIndex(cues, t);
      const cue = idx >= 0 ? cues[idx] : null;
      const targetMood = cue && cue.mood !== "silence" ? cue.mood : null;

      // ── Mood change → trigger crossfade ──
      if (targetMood !== activeMoodRef.current) {
        const now = performance.now();
        const volMultiplier = bgmVolumeRef.current / 100;

        // Fade out the outgoing mood.
        if (activeMoodRef.current) {
          const oldEl = elementsRef.current.get(activeMoodRef.current);
          const oldRamp = rampsRef.current.get(activeMoodRef.current);
          if (oldEl && oldRamp) {
            oldRamp.startVolume = oldEl.volume;
            oldRamp.targetVolume = 0;
            oldRamp.transitionStart = now;
          }
        }

        // Fade in the incoming mood.
        if (targetMood) {
          const el = getOrCreateElement(targetMood);
          if (el) {
            const ramp = rampsRef.current.get(targetMood)!;
            const gainLin = dbToLinear(cue!.gain_db) * volMultiplier;
            ramp.startVolume = el.volume;
            ramp.targetVolume = gainLin;
            ramp.transitionStart = now;
            // Start playing if not already. The play() promise is handled
            // properly: only set playing=true on success, log on failure.
            if (!ramp.playing) {
              try {
                el.play().then(() => {
                  ramp.playing = true;
                }).catch((e) => {
                  console.warn(`[bgm-engine] play() failed for mood "${targetMood}":`, e);
                  ramp.playing = false;
                });
              } catch { /* */ }
            }
          }
        }
        activeMoodRef.current = targetMood;
      }

      // ── Update volumes for all elements based on their ramp ──
      const now = performance.now();
      const volMult = bgmVolumeRef.current / 100;
      for (const [mood, el] of elementsRef.current) {
        const ramp = rampsRef.current.get(mood);
        if (!ramp) continue;

        // If this is the active mood and the volume slider changed, update target.
        if (mood === activeMoodRef.current && cue) {
          const newTarget = dbToLinear(cue.gain_db) * volMult;
          if (Math.abs(newTarget - ramp.targetVolume) > 0.001) {
            ramp.startVolume = el.volume;
            ramp.targetVolume = newTarget;
            ramp.transitionStart = now;
          }
        }

        // Apply the ramp.
        const elapsed = now - ramp.transitionStart;
        const progress = Math.min(1, elapsed / CROSSFADE_MS);
        const vol = ramp.startVolume + (ramp.targetVolume - ramp.startVolume) * progress;
        try { el.volume = Math.max(0, Math.min(1, vol)); } catch { /* */ }

        // If the ramp finished and target is 0, pause the element.
        if (progress >= 1 && ramp.targetVolume <= 0 && ramp.playing) {
          try { el.pause(); } catch { /* */ }
          ramp.playing = false;
        }
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [bgmEnabled, isPlaying]);
}
