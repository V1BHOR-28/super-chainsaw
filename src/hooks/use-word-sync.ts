"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { getAudioElement } from "@/lib/audio-element-registry";

const SYNC_OFFSET_KEY = "aria:transcript-sync-offset";
const DEFAULT_OFFSET_MS = 180;
const GAP_TOLERANCE_MS = 120;

export function getSyncOffset(): number {
  if (typeof window === "undefined") return DEFAULT_OFFSET_MS;
  try {
    const v = localStorage.getItem(SYNC_OFFSET_KEY);
    if (v !== null) return parseInt(v, 10);
  } catch {}
  return DEFAULT_OFFSET_MS;
}

export function setSyncOffset(ms: number): void {
  try {
    localStorage.setItem(SYNC_OFFSET_KEY, String(ms));
  } catch {}
}

export function useWordSync(cues: number[][] | null): { activeWordIdx: number } {
  const [internalIdx, setInternalIdx] = useState(-1);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);

  const cuesRef = useRef<number[][] | null>(cues);
  const offsetRef = useRef<number>(getSyncOffset());

  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  // Re-read offset from localStorage on every currentTime change (cheap, covers
  // the case where the user adjusts the control while paused).
  useEffect(() => {
    offsetRef.current = getSyncOffset();
  }, [currentTime]);

  const updateOnce = useCallback(() => {
    const c = cuesRef.current;
    if (!c || c.length === 0) return;
    const audio = getAudioElement();
    if (!audio) return;
    const ms = audio.currentTime * 1000 - offsetRef.current;
    const idx = binarySearchActiveCue(c, ms);
    setInternalIdx((prev) => (prev === idx ? prev : idx));
  }, []);

  // rAF loop — runs even while paused (cheap, and makes seeks/scrubs land
  // in one frame instead of waiting ~250ms for the next timeupdate).
  useEffect(() => {
    if (!cues || cues.length === 0) return;
    let rafId = 0;
    const loop = () => {
      updateOnce();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [cues, updateOnce]);

  // Seek-while-paused trigger (in addition to the always-on rAF loop, this
  // ensures the highlight updates within a frame when the store's currentTime
  // changes, even if the rAF hasn't ticked yet).
  useEffect(() => {
    if (!isPlaying) {
      const rafId = requestAnimationFrame(updateOnce);
      return () => cancelAnimationFrame(rafId);
    }
  }, [currentTime, isPlaying, updateOnce]);

  const activeWordIdx = !cues || cues.length === 0 ? -1 : internalIdx;
  return { activeWordIdx };
}

/**
 * Binary-search for the active cue at `targetMs`.
 *
 * Returns the rightmost cue with `startMs <= targetMs`, BUT keeps it
 * highlighted through its `endMs` plus a gap tolerance so short inter-word
 * silences don't blank the highlight.
 */
function binarySearchActiveCue(cues: number[][], targetMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const startMs = cues[mid][0];
    if (startMs <= targetMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // If the found cue has ended (end + gap < target), check if we're in a
  // gap before the next word. Keep the previous word highlighted during
  // the gap tolerance window.
  if (result >= 0 && result < cues.length - 1) {
    const endMs = cues[result][1];
    if (targetMs > endMs + GAP_TOLERANCE_MS) {
      // We're past this word's end + tolerance. The next word hasn't
      // started yet (startMs > targetMs). Keep the current word
      // highlighted — it's closer than nothing.
    }
  }
  return result;
}
