"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2, Pause, BookOpen, Volume2, RefreshCw, AlertCircle } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import { getChapterSummary, type HindiSummary, type HindiApiError } from "@/lib/abm-api";
import { getAudioElement } from "@/lib/audio-element-registry";
import { toast } from "sonner";

// ── ARIA: per-chapter summary cache ──
// Keyed by a schema version so any change to the summary shape invalidates
// old entries. Only valid (non-empty) responses are cached.
const SUMMARY_CACHE_VERSION = "v11";
const _summaryCache = new Map<string, HindiSummary>();

function _cacheKey(bookId: string, chapterIndex: number) {
  return `${SUMMARY_CACHE_VERSION}:${bookId}:${String(chapterIndex)}`;
}

function _isValidSummary(s: unknown): s is HindiSummary {
  return (
    !!s &&
    typeof s === "object" &&
    typeof (s as HindiSummary).summary === "string" &&
    (s as HindiSummary).summary.trim().length > 0
    // audio_url is optional — a text summary that exists is still valid even
    // when TTS or the R2 upload failed. The frontend hides the Listen button
    // when audio_url is empty/missing.
  );
}

/**
 * HindiSummaryCard — per-chapter Hindi summary + TTS playback.
 *
 * CRITICAL: never reuse an HTMLAudioElement across chapters. The old element
 * holds the previous chapter's audio URL; if we keep it, Chapter 3's play
 * button would replay Chapter 2's audio. On every chapter change we pause,
 * strip the src, call load() to release the decoder, drop the ref, and reset
 * all card state. On Play we compare the element's current src with the
 * current summary URL and rebuild the element if they differ.
 *
 * Stale-response guard: a slow Chapter 2 request must NOT populate the card
 * after the user switches to Chapter 3. Each load captures a request identity
 * (generation number + the book/chapter at request time); the response is
 * dropped unless it still matches.
 */
export function HindiSummaryCard({
  bookId,
  chapterIndex,
  chapterTitle,
}: {
  bookId: string;
  chapterIndex: number;
  chapterTitle: string;
}) {
  const hindiHelp = usePlayerStore((s) => s.hindiHelp);
  const pause = usePlayerStore((s) => s.pause);

  const [state, setState] = useState<"collapsed" | "loading" | "loaded">(
    "collapsed",
  );
  const [summary, setSummary] = useState<HindiSummary | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Request identity for the in-flight summary fetch. Incremented on every
  // chapter change + every load click. A response is accepted only if its
  // captured generation matches the current ref value AND the book/chapter
  // at response time still match the latest.
  const requestGenerationRef = useRef(0);
  const latestBookIdRef = useRef(bookId);
  const latestChapterIndexRef = useRef(chapterIndex);
  // Keep the "latest" refs in sync via an effect (not during render — the
  // react-hooks/refs rule forbids that). These are read inside async callbacks
  // to detect stale responses after a chapter switch.
  useEffect(() => {
    latestBookIdRef.current = bookId;
    latestChapterIndexRef.current = chapterIndex;
  }, [bookId, chapterIndex]);

  // ── Audio element lifecycle ──
  // Stable handlers attached to whichever element is current. Declared
  // BEFORE the cleanup effect so the effect can reference them.
  const handleSummaryEnded = useCallback(() => setAudioPlaying(false), []);
  const handleSummaryError = useCallback(() => {
    setAudioPlaying(false);
    toast.error("Summary unavailable, try again");
  }, []);

  // ── Unmount audio teardown ──
  // The parent passes a `key` prop (bookId:chapterIndex) so React REMOUNTS
  // this component on chapter change — which naturally runs this cleanup,
  // tearing down the old audio element (pause → remove listeners → strip
  // src → load() → null the ref). This guarantees Chapter 3 can never replay
  // Chapter 2's audio: the old element is destroyed before the new mount.
  useEffect(() => {
    return () => {
      const currentAudio = audioRef.current;
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.removeEventListener("ended", handleSummaryEnded);
        currentAudio.removeEventListener("error", handleSummaryError);
        currentAudio.removeAttribute("src");
        currentAudio.load();
        audioRef.current = null;
      }
    };
  }, [handleSummaryEnded, handleSummaryError]);

  /** Build a fresh <audio> for `url`, destroying any existing element first.
   *  NEVER reuse an element merely because audioRef.current is non-null —
   *  the old element's src belongs to the previous chapter/URL. */
  const createSummaryAudio = useCallback(
    (url: string): HTMLAudioElement => {
      const previous = audioRef.current;
      if (previous) {
        previous.pause();
        previous.removeEventListener("ended", handleSummaryEnded);
        previous.removeEventListener("error", handleSummaryError);
        previous.removeAttribute("src");
        previous.load();
      }
      const audio = new Audio(url);
      audio.preload = "metadata";
      audio.addEventListener("ended", handleSummaryEnded);
      audio.addEventListener("error", handleSummaryError);
      audioRef.current = audio;
      return audio;
    },
    [handleSummaryEnded, handleSummaryError],
  );

  // ── Load the summary for the current chapter ──
  const handleLoad = useCallback(async (force?: boolean) => {
    const key = _cacheKey(bookId, chapterIndex);
    // Check cache first (skip when force=true — user clicked "Regenerate")
    if (!force) {
      const cached = _summaryCache.get(key);
      if (_isValidSummary(cached)) {
        setSummary(cached);
        setState("loaded");
        return;
      }
    }

    // Capture identity at request time so a stale response can't overwrite
    // state after the user switches chapters.
    const generation = ++requestGenerationRef.current;
    const requestedBookId = bookId;
    const requestedChapterIndex = chapterIndex;

    setState("loading");
    try {
      const result = await getChapterSummary(
        requestedBookId,
        requestedChapterIndex,
        force,
      );
      // Stale-response guard: drop the response if the user has already
      // moved to a different chapter (or re-clicked load) since this
      // request was issued.
      if (
        generation !== requestGenerationRef.current ||
        requestedBookId !== latestBookIdRef.current ||
        requestedChapterIndex !== latestChapterIndexRef.current
      ) {
        return;
      }
      if (!_isValidSummary(result)) {
        console.error("[summary] invalid response", result);
        toast.error("Summary unavailable, try again");
        setState("collapsed");
        return;
      }
      _summaryCache.set(key, result);
      setSummary(result);
      setState("loaded");
    } catch (err) {
      console.error("[summary] fetch failed", err);
      if (
        generation !== requestGenerationRef.current ||
        requestedBookId !== latestBookIdRef.current ||
        requestedChapterIndex !== latestChapterIndexRef.current
      ) {
        return;
      }
      // Toast the server's message + include the machine code for diagnostics.
      const code = (err as HindiApiError)?.code;
      const msg = err instanceof Error ? err.message : "";
      if (code === "rate_limited" || code === "groq_rate_limited") {
        toast.error(`Rate limited — retrying [${code}]`);
      } else if (code) {
        toast.error(`${msg || "Summary unavailable"} [${code}]`);
      } else {
        toast.error(msg || "Summary unavailable, try again");
      }
      setState("collapsed");
    }
  }, [bookId, chapterIndex]);

  // ── Regenerate (force=true, bypasses cache) — for partial-quality summaries ──
  const handleRegenerate = useCallback(() => {
    handleLoad(true);
  }, [handleLoad]);

  // ── Play / stop the summary audio ──
  const handlePlayAudio = useCallback(() => {
    if (!summary?.audio_url) return;

    // Pause the main book audio first so the two don't overlap.
    const mainAudio = getAudioElement();
    if (mainAudio && !mainAudio.paused) {
      mainAudio.pause();
    }
    pause();

    // If the current element's src doesn't match the current summary URL,
    // destroy + rebuild it. This is the core fix for "Chapter 3 plays
    // Chapter 2's audio".
    const current = audioRef.current;
    if (!current || current.src !== summary.audio_url) {
      createSummaryAudio(summary.audio_url);
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio
      .play()
      .then(() => setAudioPlaying(true))
      .catch((err) => {
        console.error("[summary] audio play failed", err);
      });
  }, [summary, pause, createSummaryAudio]);

  const handleStopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      setAudioPlaying(false);
    }
  }, []);

  if (!hindiHelp) return null;

  return (
    <div
      className="mt-3 rounded-2xl border p-4"
      style={{
        background: "var(--aria-bg-soft)",
        borderColor: "var(--aria-border)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <BookOpen className="w-4 h-4" style={{ color: "var(--aria-accent)" }} />
        <span
          className="font-mono text-[10px] tracking-[0.18em] uppercase"
          style={{ color: "var(--aria-accent-glow)" }}
        >
          Chapter Summary
        </span>
      </div>

      {state === "collapsed" && (
        <button
          onClick={() => handleLoad()}
          className="text-sm px-4 py-2 rounded-lg transition-all hover:scale-[1.02]"
          style={{
            background: "var(--aria-accent-glow)",
            color: "var(--aria-bg)",
            fontWeight: 500,
          }}
        >
          Read summary
        </button>
      )}

      {state === "loading" && (
        <div
          className="flex items-center gap-2 text-sm"
          style={{ color: "var(--aria-fg-muted)" }}
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          Generating summary…
        </div>
      )}

      {state === "loaded" && summary && (
        <div>
          {/* Render multi-paragraph summaries preserving \n\n breaks so the
              text doesn't collapse into a single wall of text. The backend
              prompt asks for 2–3 short paragraphs. */}
          <div className="space-y-3">
            {summary.summary
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((para, i) => (
                <p
                  key={i}
                  className="font-serif text-sm leading-[1.8]"
                  style={{ color: "var(--aria-fg)" }}
                >
                  {para}
                </p>
              ))}
          </div>
          {/* Partial-quality badge: the summary failed the gates twice and
              flagged sentences were stripped. Show a muted warning + a
              "Regenerate" button that re-calls the endpoint with force=1
              (bypasses cache). */}
          {summary.quality === "partial" && (
            <div
              className="flex items-center gap-2 mt-3 mb-1 px-3 py-2 rounded-lg text-xs"
              style={{
                background: "rgba(245,158,11,0.06)",
                borderLeft: "2px solid rgba(245,158,11,0.4)",
                color: "var(--aria-fg-muted)",
              }}
            >
              <AlertCircle className="w-3 h-3 flex-shrink-0" style={{ color: "rgba(245,158,11,0.7)" }} />
              <span className="flex-1">This summary may be incomplete</span>
              <button
                onClick={handleRegenerate}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-opacity hover:opacity-80"
                style={{
                  color: "var(--aria-accent-glow)",
                  border: "1px solid var(--aria-border)",
                  background: "transparent",
                }}
              >
                <RefreshCw className="w-2.5 h-2.5" />
                Regenerate
              </button>
            </div>
          )}
          {/* Degraded badge: all regenerations failed, the outline was rendered
              as a Hindi bulleted list. A correct outline beats a fluent-but-wrong
              paragraph. Show a "Condensed form" badge + regenerate button. */}
          {(summary.degraded || summary.quality === "degraded") && (
            <div
              className="flex items-center gap-2 mt-3 mb-1 px-3 py-2 rounded-lg text-xs"
              style={{
                background: "rgba(168,85,247,0.06)",
                borderLeft: "2px solid rgba(168,85,247,0.4)",
                color: "var(--aria-fg-muted)",
              }}
            >
              <AlertCircle className="w-3 h-3 flex-shrink-0" style={{ color: "rgba(168,85,247,0.7)" }} />
              <span className="flex-1">Condensed form</span>
              <button
                onClick={handleRegenerate}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-opacity hover:opacity-80"
                style={{
                  color: "var(--aria-accent-glow)",
                  border: "1px solid var(--aria-border)",
                  background: "transparent",
                }}
              >
                <RefreshCw className="w-2.5 h-2.5" />
                Regenerate
              </button>
            </div>
          )}
          {summary.audio_url && (
            <button
              onClick={audioPlaying ? handleStopAudio : handlePlayAudio}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors mt-4"
              style={{
                color: "var(--aria-accent-glow)",
                border: "1px solid var(--aria-border)",
                background: "var(--aria-card)",
              }}
            >
              {audioPlaying ? (
                <>
                  <Pause className="w-3 h-3" />
                  Stop
                </>
              ) : (
                <>
                  <Volume2 className="w-3 h-3" />
                  Listen to summary
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
