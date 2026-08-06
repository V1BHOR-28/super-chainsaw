"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { getAudioElement } from "@/lib/audio-element-registry";

/**
 * useWordSync — drives word-by-word highlight in the transcript panel.
 *
 * Reads `audio.currentTime` directly from the live <audio> element (via
 * the audio-element-registry singleton) inside a requestAnimationFrame
 * loop — NOT the player store's `currentTime`, which only updates ~4×/sec
 * via the `timeupdate` event. At 60fps the highlight tracks the narrator's
 * voice tightly enough to feel synced.
 *
 * Why rAF (not timeupdate)?
 *   - timeupdate fires every ~250ms in most browsers — visibly laggy.
 *   - rAF runs at display refresh rate (60–120fps), so the active-word
 *     highlight tracks the audio within ~16ms. setState is only called
 *     when the binary-searched index actually changes, so the React tree
 *     isn't re-rendered 60×/sec — only when the active word changes.
 *
 * The audio element's `currentTime` is already CHAPTER-RELATIVE (each
 * chapter is its own MP3 file). The backend stores cues as chapter-relative
 * milliseconds (chunk offset + 3s silence prefix baked in). So the comparison
 * is a direct `audio.currentTime * 1000` against `cue[0]` (startMs) — no
 * chapter-start subtraction needed.
 *
 * Lifecycle:
 *   - rAF loop runs while `isPlaying` is true.
 *   - On pause, the loop is cancelled (per the task spec) — but a single
 *     update is fired so the highlight matches the paused position.
 *   - While paused, the player store's `currentTime` subscription catches
 *     seeks (scrubbing the progress bar) and re-runs the single update.
 *   - On unmount, the loop is cancelled.
 *
 * @param cues  The chapter's cue array (`[[startMs, endMs, word], ...]`)
 *              from the transcript store, or null while loading / unavailable.
 * @returns     `{ activeWordIdx }` — index into `cues`, or -1 if before the
 *              first word / no cues.
 */
export function useWordSync(cues: number[][] | null): { activeWordIdx: number } {
  const [internalIdx, setInternalIdx] = useState(-1);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  // Subscribe to the store's absolute currentTime as a SEEK TRIGGER while
  // paused. The rAF loop drives updates during playback; this subscription
  // ensures the highlight jumps immediately when the user scrubs the
  // progress bar while paused (the rAF loop is cancelled in that state).
  const currentTime = usePlayerStore((s) => s.currentTime);

  // Always-current ref to cues so the rAF loop reads the latest without
  // re-subscribing on every cue change (avoids tearing down/recreating
  // the loop mid-chapter).
  const cuesRef = useRef<number[][] | null>(cues);
  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  const updateOnce = useCallback(() => {
    const c = cuesRef.current;
    if (!c || c.length === 0) return;
    const audio = getAudioElement();
    if (!audio) return;
    // audio.currentTime is chapter-relative seconds; cues are chapter-relative ms.
    const ms = audio.currentTime * 1000;
    const idx = binarySearchActiveCue(c, ms);
    setInternalIdx((prev) => (prev === idx ? prev : idx));
  }, []);

  // ── rAF loop while playing ──
  // The setState happens INSIDE the rAF callback (async), not synchronously
  // in the effect body — so this doesn't trip the react-hooks/set-state-in-
  // effect rule. On pause we still schedule a single rAF update so the
  // highlight matches the paused position (e.g. right after the user
  // clicked pause).
  useEffect(() => {
    if (!cues || cues.length === 0) {
      // No cues → the derived `activeWordIdx` below returns -1 directly,
      // no setState needed here.
      return;
    }
    let rafId = 0;
    if (!isPlaying) {
      // One-shot update on pause (rAF callback is async — safe).
      rafId = requestAnimationFrame(updateOnce);
      return () => cancelAnimationFrame(rafId);
    }
    const loop = () => {
      updateOnce();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [cues, isPlaying, updateOnce]);

  // ── Seek-while-paused trigger ──
  // When the user scrubs the progress bar while paused, the player store's
  // currentTime changes (and the audio element's currentTime follows via
  // the audio engine's seek subscription). The rAF loop above is cancelled
  // in this state, so we schedule a single rAF update here to keep the
  // highlight in sync. rAF callback is async — safe.
  useEffect(() => {
    if (!isPlaying) {
      const rafId = requestAnimationFrame(updateOnce);
      return () => cancelAnimationFrame(rafId);
    }
  }, [currentTime, isPlaying, updateOnce]);

  // Derived: -1 when no cues (cleared during render — no setState-in-effect
  // needed for the reset path), otherwise the rAF-tracked index.
  const activeWordIdx = !cues || cues.length === 0 ? -1 : internalIdx;
  return { activeWordIdx };
}

/**
 * Binary-search a sorted cue array for the active word at time `targetMs`.
 *
 * "Active" = the rightmost cue with `startMs <= targetMs`. This keeps the
 * previous word highlighted during inter-word silences (no flicker). Returns
 * -1 when `targetMs` is before the first cue's start (e.g. the 3s silence
 * prefix at the start of every chapter MP3).
 *
 * The cues array is assumed sorted ascending by startMs — the backend
 * guarantees this (`_chapter_cues.sort(key=lambda c: c[0])`).
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
  return result;
}
