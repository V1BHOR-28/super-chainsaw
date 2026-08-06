"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, FileQuestion } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import {
  useTranscriptStore,
  useTranscriptEntry,
} from "@/lib/transcript-store";
import { useWordSync } from "@/hooks/use-word-sync";
import { cn } from "@/lib/utils";

/**
 * TranscriptView — word-by-word synced transcript panel for the ARIA player.
 *
 * Renders the current chapter's text as clickable <span> words. The active
 * word (the one being spoken right now) is highlighted in the accent color;
 * past words are full-opacity, upcoming words are dimmed. Clicking a word
 * seeks the player to that word's position.
 *
 * Data flow:
 *   1. On chapter change, fires `fetchTranscript(jobId, chapterIndex)` —
 *      this calls /api/abm/job_chapters and caches the chapter's cues.
 *   2. `useWordSync(cues)` runs a rAF loop reading `audio.currentTime`
 *      directly and binary-searches the cue array for the active word.
 *   3. The active word auto-scrolls into view (suppressed for 4s after a
 *      manual scroll so the user can browse freely).
 *
 * States shown:
 *   - loading → skeleton
 *   - unavailable → "Transcript not available for this chapter."
 *   - error → "Couldn't load transcript" + retry button
 *   - ready → the word grid
 *
 * Notes:
 *   - `currentChapterIdx` is the POSITION in chapterMp3s (0-based, contiguous).
 *   - `chapterMp3s[idx].index` is the BOOK chapter number — what the backend
 *     uses to key transcript_cues. These differ when the user converted a
 *     non-contiguous selection (e.g. chapters 1, 2, 5).
 *   - `audio.currentTime` is chapter-relative seconds; cues are chapter-
 *     relative ms (the 3s silence prefix is baked in). Click-to-seek adds
 *     the chapter's absolute start offset to convert back to global seconds.
 */
export function TranscriptView() {
  const job = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const seek = usePlayerStore((s) => s.seek);
  const fetchTranscript = useTranscriptStore((s) => s.fetchTranscript);

  const chapterMp3s = job?.chapterMp3s;
  const chapterInfo =
    chapterMp3s && currentChapterIdx >= 0 && currentChapterIdx < chapterMp3s.length
      ? chapterMp3s[currentChapterIdx]
      : null;
  const chapterIndex = chapterInfo?.index ?? -1;
  const jobId = job?.jobId;

  // Absolute start of this chapter (seconds) — used to convert a chapter-
  // relative cue startMs back into a global seek target.
  const chapterStartSec =
    chapterMp3s && currentChapterIdx >= 0
      ? chapterMp3s
          .slice(0, currentChapterIdx)
          .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000
      : 0;

  // Fetch transcript whenever the chapter changes (or first time the panel
  // opens for a given chapter). The store dedupes inflight requests and
  // caches the result, so this is safe to call repeatedly.
  useEffect(() => {
    if (!jobId || chapterIndex < 0) return;
    fetchTranscript(jobId, chapterIndex);
  }, [jobId, chapterIndex, fetchTranscript]);

  const entry = useTranscriptEntry(jobId, chapterIndex);
  const cues = entry?.data?.cues ?? null;
  const words = entry?.data?.words ?? null;
  const { activeWordIdx } = useWordSync(cues);

  // ── Click-to-seek ──
  const handleWordClick = (cueIdx: number) => {
    if (!cues || cueIdx < 0 || cueIdx >= cues.length) return;
    const startMs = cues[cueIdx][0];
    const absSec = chapterStartSec + startMs / 1000;
    seek(absSec);
  };

  // ── Auto-scroll the active word into view ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef<number>(0);
  const reducedMotion = usePrefersReducedMotion();

  // Track manual scrolls so we can suppress auto-scroll for 4s afterwards.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      lastUserScrollRef.current = Date.now();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // When the active word changes, scroll it into view (unless the user has
  // recently scrolled manually — give them 4s of free browsing before we
  // resume auto-follow).
  useEffect(() => {
    if (activeWordIdx < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - lastUserScrollRef.current < 4000) return;
    const node = el.querySelector<HTMLElement>(
      `[data-cue-index="${activeWordIdx}"]`,
    );
    if (!node) return;
    try {
      node.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
    } catch {
      // Older Safari doesn't support the options object — fall back.
      node.scrollIntoView(false);
    }
  }, [activeWordIdx, reducedMotion]);

  // ── Render states ──
  if (!job || currentChapterIdx < 0 || !chapterInfo) {
    return (
      <TranscriptFrame>
        <div className="px-5 py-8 text-sm text-[var(--aria-fg-muted)] text-center">
          No chapter selected.
        </div>
      </TranscriptFrame>
    );
  }

  if (entry?.status === "loading" || entry?.status === "idle") {
    return (
      <TranscriptFrame>
        <div className="px-5 py-5">
          <div className="flex items-center gap-2 text-xs text-[var(--aria-fg-muted)] mb-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading transcript…
          </div>
          <TranscriptSkeleton />
        </div>
      </TranscriptFrame>
    );
  }

  if (entry?.status === "error") {
    return (
      <TranscriptFrame>
        <div className="px-5 py-8 flex flex-col items-center gap-2 text-sm text-[var(--aria-fg-muted)] text-center">
          <FileQuestion className="w-5 h-5 opacity-60" />
          <span>Couldn&apos;t load transcript.</span>
          <button
            onClick={() =>
              jobId && chapterIndex >= 0 && fetchTranscript(jobId, chapterIndex)
            }
            className="mt-1 text-xs underline hover:text-[var(--aria-accent-glow)] transition-colors"
          >
            Try again
          </button>
        </div>
      </TranscriptFrame>
    );
  }

  if (entry?.status === "unavailable" || !cues || !words) {
    return (
      <TranscriptFrame>
        <div className="px-5 py-8 flex flex-col items-center gap-2 text-sm text-[var(--aria-fg-muted)] text-center">
          <FileQuestion className="w-5 h-5 opacity-60" />
          <span>Transcript not available for this chapter.</span>
          <span className="text-[11px] text-[var(--aria-fg-dim)] max-w-[300px]">
            Word-level sync requires edge-tts voices. Try a different chapter
            or voice if you need synced highlighting.
          </span>
        </div>
      </TranscriptFrame>
    );
  }

  // Ready — render the word grid.
  return (
    <TranscriptFrame>
      <div
        ref={scrollRef}
        className="transcript-scroll px-5 py-5 max-h-[55vh] overflow-y-auto"
      >
        <p className="font-serif text-base sm:text-[17px] leading-[2] m-0">
          {words.map((word, i) => {
            const isActive = i === activeWordIdx;
            const isPast = i < activeWordIdx;
            return (
              <span
                key={i}
                data-cue-index={i}
                onClick={() => handleWordClick(i)}
                className={cn(
                  "cursor-pointer rounded px-[1px] transition-colors duration-150",
                  isActive
                    ? "text-[var(--aria-accent-glow)] bg-[rgba(245,158,11,0.14)]"
                    : isPast
                      ? "text-[var(--aria-fg)] hover:bg-[var(--aria-card)]"
                      : "text-[var(--aria-fg-muted)] opacity-55 hover:bg-[var(--aria-card)] hover:opacity-100",
                )}
              >
                {word}{" "}
              </span>
            );
          })}
        </p>
      </div>
    </TranscriptFrame>
  );
}

/* ──────────────────── Sub-components ──────────────────── */

/** Outer container — matches the player's transport-control visual style
 *  (soft bg, hairline border, rounded corners). */
function TranscriptFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-2 rounded-2xl border overflow-hidden"
      style={{
        background: "var(--aria-bg-soft)",
        borderColor: "var(--aria-border)",
      }}
    >
      <div className="flex items-center justify-between px-5 py-3 border-b"
           style={{ borderColor: "var(--aria-border)" }}>
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: "var(--aria-accent-glow)" }}
          >
            Transcript
          </span>
        </div>
        <span className="text-[10px] text-[var(--aria-fg-dim)]">
          Click any word to jump there
        </span>
      </div>
      {children}
    </div>
  );
}

function TranscriptSkeleton() {
  // 6 lines of varying width — looks like a paragraph loading.
  const widths = ["92%", "78%", "88%", "65%", "85%", "55%"];
  return (
    <div className="space-y-2.5">
      {widths.map((w, i) => (
        <div
          key={i}
          className="h-3.5 rounded animate-pulse"
          style={{ width: w, background: "var(--aria-card)" }}
        />
      ))}
    </div>
  );
}

/** Subscribe to the user's prefers-reduced-motion setting.
 *
 *  Uses useSyncExternalStore so we read the current value WITHOUT calling
 *  setState inside an effect (the React team's recommended pattern for
 *  external state subscriptions — avoids the cascading-render warning
 *  that the naive useEffect + setState approach triggers).
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === "undefined" || !window.matchMedia) {
        return () => {};
      }
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const handler = () => callback();
      // addEventListener is the modern API; addListener is the deprecated
      // Safari < 14 fallback.
      if (mq.addEventListener) {
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener?.("change", handler);
      }
      if (mq.addListener) {
        mq.addListener(handler);
        return () => mq.removeListener?.(handler);
      }
      return () => {};
    },
    // Client snapshot.
    () => {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
    // SSR snapshot — assume no preference (matches the client's first paint).
    () => false,
  );
}
