/**
 * audio-element-registry — module-level singleton holding the live
 * <audio> element created by `useAudioEngine`.
 *
 * Why module-level (not React context, not zustand)?
 *  - `useAudioEngine` and `useWordSync` are sibling hooks mounted at the
 *    workspace root. They have no parent/child relationship that would
 *    make a context clean.
 *  - The audio element is a true singleton — exactly one per browser tab.
 *    A module-level mutable binding models that exactly.
 *  - Reading `audio.currentTime` from a rAF loop (60fps) requires zero
 *    React re-renders; we don't want this to be reactive state.
 *
 * `useAudioEngine` calls `setAudioElement(a)` on mount and
 * `setAudioElement(null)` on unmount. `useWordSync` reads via
 * `getAudioElement()` inside its rAF loop — no subscription needed.
 */

let _audio: HTMLAudioElement | null = null;

export function setAudioElement(a: HTMLAudioElement | null): void {
  _audio = a;
}

export function getAudioElement(): HTMLAudioElement | null {
  return _audio;
}
