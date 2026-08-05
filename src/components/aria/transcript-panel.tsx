"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { usePlayerStore } from "@/lib/player-store";
import { estimateSentenceTimings, findActiveSentence } from "@/lib/transcript";
import { getJobChapters, type AnalyzeChapter } from "@/lib/abm-api";
import { cn } from "@/lib/utils";
import { AlignLeft, Loader2, X } from "lucide-react";

/**
 * TranscriptPanel — Spotify-style lyrics panel for audiobook chapters.
 *
 * Displays the current chapter's text as a scrollable list of sentences.
 * The active sentence (matching the audio's current position) is highlighted
 * and auto-scrolled into view. Tap any sentence to seek to that point.
 *
 * Timestamps are estimated proportionally by character count (Phase 1 — no
 * per-word timing data from the TTS engine). Accuracy: ±2-4 seconds per
 * sentence, which is good enough for sentence-level highlighting + tap-to-seek.
 *
 * The panel fetches chapter text from /api/job_chapters on first open, then
 * caches it in memory. When the chapter changes, it refetches.
 */
export function TranscriptPanel() {
  const currentJob = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seek = usePlayerStore((s) => s.seek);
  const toggleTranscript = usePlayerStore((s) => s.toggleTranscript);

  const [chaptersData, setChaptersData] = useState<AnalyzeChapter[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastFetchKey = useRef<string>("");

  // The actual chapter index in the book (chapterMp3s may skip unselected chapters)
  const chapterMp3s = currentJob?.chapterMp3s;
  const actualChapterIndex = chapterMp3s && currentChapterIdx >= 0 && currentChapterIdx < chapterMp3s.length
    ? chapterMp3s[currentChapterIdx].index
    : -1;

  // Fetch chapter text when the chapter changes
  useEffect(() => {
    if (!currentJob || actualChapterIndex < 0) return;
    const fetchKey = `${currentJob.jobId}:${actualChapterIndex}`;
    if (fetchKey === lastFetchKey.current) return; // already fetched
    lastFetchKey.current = fetchKey;

    let cancelled = false;
    // These state setters are stable — the react-hooks/set-state-in-effect
    // rule is a false positive here (we're setting loading state before an
    // async fetch, not deriving state from props/state during render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    getJobChapters(currentJob.jobId)
      .then((resp) => {
        if (cancelled) return;
        setChaptersData(resp.chapters);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[transcript] failed to load chapters", err);
        setError("Could not load transcript");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [currentJob, actualChapterIndex]);

  // Get the current chapter's text + duration
  const chapterInfo = useMemo(() => {
    if (!chaptersData || actualChapterIndex < 0) return null;
    const ch = chaptersData.find((c) => c.index === actualChapterIndex);
    if (!ch || !ch.text) return null;

    // Get the chapter's duration from chapterMp3s
    const mp3Info = chapterMp3s?.find((c) => c.index === actualChapterIndex);
    const durationMs = mp3Info?.duration_ms ?? 0;
    if (durationMs <= 0) return null;

    return { text: ch.text, durationMs };
  }, [chaptersData, actualChapterIndex, chapterMp3s]);

  // Estimate sentence timings
  const sentences = useMemo(() => {
    if (!chapterInfo) return [];
    return estimateSentenceTimings(chapterInfo.text, chapterInfo.durationMs);
  }, [chapterInfo]);

  // Compute the current chapter's start time (absolute, across all chapters)
  const chapterStartSec = useMemo(() => {
    if (!chapterMp3s || currentChapterIdx < 0) return 0;
    return chapterMp3s
      .slice(0, currentChapterIdx)
      .reduce((sum, ch) => sum + (ch.duration_ms || 0), 0) / 1000;
  }, [chapterMp3s, currentChapterIdx]);

  // Current time relative to the chapter start (in ms)
  const currentChapterTimeMs = useMemo(() => {
    return Math.max(0, (currentTime - chapterStartSec) * 1000);
  }, [currentTime, chapterStartSec]);

  // Find the active sentence
  const activeIdx = useMemo(() => {
    return findActiveSentence(sentences, currentChapterTimeMs);
  }, [sentences, currentChapterTimeMs]);

  // Auto-scroll the active sentence into view
  useEffect(() => {
    if (activeIdx < 0 || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeIdx]);

  // Handle sentence tap → seek
  const handleSentenceClick = (sentenceIdx: number) => {
    if (sentenceIdx < 0 || sentenceIdx >= sentences.length) return;
    const targetMs = sentences[sentenceIdx].start_ms;
    // Convert from chapter-relative ms to absolute seconds
    const absoluteSec = chapterStartSec + targetMs / 1000;
    seek(absoluteSec);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--aria-fg-dim)]">
        <Loader2 size={18} className="animate-spin mr-2" />
        <span className="text-xs">Loading transcript…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-[var(--aria-fg-dim)]">
        <p className="text-xs">{error}</p>
      </div>
    );
  }

  if (!chapterInfo || sentences.length === 0) {
    return (
      <div className="text-center py-8 text-[var(--aria-fg-dim)]">
        <AlignLeft size={18} className="mx-auto mb-2 opacity-40" />
        <p className="text-xs">No transcript available for this chapter.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.15em] text-[var(--aria-fg-dim)]">
          <AlignLeft size={11} />
          Transcript
        </div>
        <button
          onClick={toggleTranscript}
          className="text-[var(--aria-fg-dim)] hover:text-[var(--aria-fg)] transition-colors"
          title="Close transcript"
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable sentence list */}
      <div
        ref={scrollRef}
        className="transcript-scroll max-h-[280px] overflow-y-auto pr-2 space-y-1.5 scroll-smooth"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "var(--aria-border) transparent",
        }}
      >
        {sentences.map((s, i) => (
          <button
            key={i}
            data-idx={i}
            onClick={() => handleSentenceClick(i)}
            className={cn(
              "block w-full text-left text-sm leading-relaxed transition-colors duration-200 px-2 py-1 rounded",
              i === activeIdx
                ? "text-[var(--aria-accent-glow)] font-medium"
                : "text-[var(--aria-fg-muted)] hover:text-[var(--aria-fg)] hover:bg-white/[0.03]",
            )}
            style={{
              opacity: i === activeIdx ? 1 : Math.max(0.4, 1 - Math.abs(i - activeIdx) * 0.12),
            }}
          >
            {s.text}
          </button>
        ))}
      </div>
    </div>
  );
}
