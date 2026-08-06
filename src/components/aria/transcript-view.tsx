"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useCallback } from "react";
import { Loader2, FileQuestion, Minus, Plus } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import {
  useTranscriptStore,
  useTranscriptEntry,
} from "@/lib/transcript-store";
import { useWordSync, getSyncOffset, setSyncOffset } from "@/hooks/use-word-sync";
import { getAudioElement } from "@/lib/audio-element-registry";
import { cn } from "@/lib/utils";

const DEFAULT_OFFSET_MS = 180;

export function TranscriptView() {
  const job = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const seek = usePlayerStore((s) => s.seek);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const fetchTranscript = useTranscriptStore((s) => s.fetchTranscript);

  const chapterMp3s = job?.chapterMp3s;
  const chapterInfo =
    chapterMp3s && currentChapterIdx >= 0 && currentChapterIdx < chapterMp3s.length
      ? chapterMp3s[currentChapterIdx]
      : null;
  const chapterIndex = chapterInfo?.index ?? -1;
  const jobId = job?.jobId;

  const chapterStartSec =
    chapterMp3s && currentChapterIdx >= 0
      ? chapterMp3s
          .slice(0, currentChapterIdx)
          .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000
      : 0;

  useEffect(() => {
    if (!jobId || chapterIndex < 0) return;
    fetchTranscript(jobId, chapterIndex);
  }, [jobId, chapterIndex, fetchTranscript]);

  const entry = useTranscriptEntry(jobId, chapterIndex);
  const cues = entry?.data?.cues ?? null;
  const words = entry?.data?.words ?? null;
  const { activeWordIdx } = useWordSync(cues);

  // ── Sync offset control ──
  const [syncOffset, setSyncOffsetState] = useState(getSyncOffset());
  const adjustOffset = (delta: number) => {
    const next = Math.max(-500, Math.min(1000, syncOffset + delta));
    setSyncOffsetState(next);
    setSyncOffset(next);
  };

  // ── Click-to-seek (Bug 2 fix) ──
  const handleWordClick = useCallback(
    (cueIdx: number) => {
      if (!cues || cueIdx < 0 || cueIdx >= cues.length) return;
      const startMs = cues[cueIdx][0];
      const audio = getAudioElement();

      if (audio) {
        // Seek the audio element directly (chapter-relative — no offset needed).
        // This avoids the store's absolute-time → chapter re-derivation which
        // can swap chapters near boundaries due to metadata imprecision.
        audio.currentTime = startMs / 1000;

        // Reconcile the store clock so the progress bar matches.
        const absSec = chapterStartSec + startMs / 1000;
        setCurrentTime(absSec);

        // Force one immediate sync tick so the highlight lands within a frame.
        requestAnimationFrame(() => {
          // The rAF loop in useWordSync will pick this up automatically.
        });
      } else {
        // Fallback: use the store's seek (cross-chapter path).
        const absSec = chapterStartSec + startMs / 1000;
        seek(absSec);
      }
    },
    [cues, chapterStartSec, seek, setCurrentTime],
  );

  // ── Auto-scroll (Bug 1 fix) ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef<number>(0);
  const userScrolledRef = useRef<number>(0);
  const reducedMotion = usePrefersReducedMotion();

  // Re-enable auto-follow when the user presses play or seeks.
  useEffect(() => {
    userScrolledRef.current = 0;
  }, [isPlaying, currentChapterIdx]);

  // Track genuine user scrolls (ignore programmatic ones).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore scroll events that were caused by our own scrollTo().
      if (performance.now() - programmaticScrollRef.current < 700) return;
      userScrolledRef.current = Date.now();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // When the active word changes, scroll it into view using direct container
  // scroll (NOT scrollIntoView which scrolls every ancestor).
  useEffect(() => {
    if (activeWordIdx < 0) return;
    const el = scrollRef.current;
    if (!el) return;

    // Respect the 4s manual-scroll suppression.
    if (userScrolledRef.current && Date.now() - userScrolledRef.current < 4000) return;

    const node = el.querySelector<HTMLElement>(`[data-cue-index="${activeWordIdx}"]`);
    if (!node) return;

    // Direct container scroll — never scrolls window/document.
    const target =
      node.offsetTop - el.clientHeight / 2 + node.offsetHeight / 2;
    const clamped = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));

    programmaticScrollRef.current = performance.now();
    el.scrollTo({
      top: clamped,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeWordIdx, reducedMotion]);

  // ── Render states ──
  if (!job || currentChapterIdx < 0 || !chapterInfo) {
    return (
      <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
        <div className="px-5 py-8 text-sm text-[var(--aria-fg-muted)] text-center">
          No chapter selected.
        </div>
      </TranscriptFrame>
    );
  }

  if (entry?.status === "loading" || entry?.status === "idle") {
    return (
      <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
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
      <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
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
      <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
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
    <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
      <div
        ref={scrollRef}
        className="transcript-scroll relative px-5 py-5 max-h-[55vh] overflow-y-auto overscroll-contain"
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
        {/* Bottom spacer so the final lines can be centred and the list can
            scroll all the way down. */}
        <div style={{ height: "28vh" }} />
      </div>
    </TranscriptFrame>
  );
}

/* ──────────────────── Sub-components ──────────────────── */

function TranscriptFrame({
  children,
  syncOffset,
  onAdjustOffset,
}: {
  children: React.ReactNode;
  syncOffset: number;
  onAdjustOffset: (delta: number) => void;
}) {
  return (
    <div
      className="mt-2 rounded-2xl border overflow-hidden"
      style={{
        background: "var(--aria-bg-soft)",
        borderColor: "var(--aria-border)",
      }}
    >
      <div
        className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: "var(--aria-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: "var(--aria-accent-glow)" }}
          >
            Transcript
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Sync offset control (Bug 3 fix) */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => onAdjustOffset(-20)}
              className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:bg-[var(--aria-card)] transition-colors"
              title="Sync earlier (-20ms)"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="font-mono text-[9px] text-[var(--aria-fg-dim)] w-10 text-center">
              {syncOffset > 0 ? "+" : ""}{syncOffset}ms
            </span>
            <button
              onClick={() => onAdjustOffset(20)}
              className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:bg-[var(--aria-card)] transition-colors"
              title="Sync later (+20ms)"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          <span className="text-[10px] text-[var(--aria-fg-dim)] hidden sm:inline">
            Click any word to jump
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}

function TranscriptSkeleton() {
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

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === "undefined" || !window.matchMedia) {
        return () => {};
      }
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const handler = () => callback();
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
    () => {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
    () => false,
  );
}
