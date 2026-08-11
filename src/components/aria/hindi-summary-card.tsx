"use client";

import { useState, useRef, useCallback } from "react";
import { Loader2, Play, Pause, BookOpen, Volume2 } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import { getChapterSummary, type HindiSummary } from "@/lib/abm-api";
import { getAudioElement } from "@/lib/audio-element-registry";
import { toast } from "sonner";

// Per-chapter cache: Map<"bookId:chapterIdx", HindiSummary>
const _summaryCache = new Map<string, HindiSummary>();

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
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const pause = usePlayerStore((s) => s.pause);

  const [state, setState] = useState<"collapsed" | "loading" | "loaded">("collapsed");
  const [summary, setSummary] = useState<HindiSummary | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cacheKey = `${bookId}:${chapterIndex}`;

  const handleLoad = useCallback(async () => {
    // Check cache first
    const cached = _summaryCache.get(cacheKey);
    if (cached) {
      setSummary(cached);
      setState("loaded");
      return;
    }

    setState("loading");
    try {
      const result = await getChapterSummary(bookId, chapterIndex);
      _summaryCache.set(cacheKey, result);
      setSummary(result);
      setState("loaded");
    } catch (err) {
      toast.error("अभी उपलब्ध नहीं है, बाद में कोशिश करें");
      setState("collapsed");
    }
  }, [bookId, chapterIndex, cacheKey]);

  const handlePlayAudio = useCallback(() => {
    if (!summary?.audio_url) return;

    // Pause main book audio first
    const mainAudio = getAudioElement();
    if (mainAudio && !mainAudio.paused) {
      mainAudio.pause();
    }
    pause();

    // Play summary audio
    if (!audioRef.current) {
      audioRef.current = new Audio(summary.audio_url);
      audioRef.current.addEventListener("ended", () => {
        setAudioPlaying(false);
        // Do NOT auto-resume the book
      });
    }
    audioRef.current.play().then(() => {
      setAudioPlaying(true);
    }).catch(() => {
      toast.error("अभी उपलब्ध नहीं है, बाद में कोशिश करें");
    });
  }, [summary, pause]);

  const handleStopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      setAudioPlaying(false);
    }
  }, []);

  // Reset when chapter changes — use a key-based approach instead of effect.
  // The parent passes a new chapterIndex, which changes the component's
  // props. We track the previous value and reset state during render
  // (React allows this if guarded by a condition).
  const [prevChapter, setPrevChapter] = useState(chapterIndex);
  if (prevChapter !== chapterIndex) {
    setPrevChapter(chapterIndex);
    setState("collapsed");
    setSummary(null);
    setAudioPlaying(false);
  }

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
          इस अध्याय का सारांश
        </span>
      </div>

      {state === "collapsed" && (
        <button
          onClick={handleLoad}
          className="text-sm px-4 py-2 rounded-lg transition-all hover:scale-[1.02]"
          style={{
            background: "var(--aria-accent-glow)",
            color: "var(--aria-bg)",
            fontWeight: 500,
          }}
        >
          सारांश पढ़ें
        </button>
      )}

      {state === "loading" && (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--aria-fg-muted)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          सारांश तैयार हो रहा है…
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
                  रोकें
                </>
              ) : (
                <>
                  <Volume2 className="w-3 h-3" />
                  सारांश सुनें
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
