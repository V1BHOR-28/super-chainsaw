"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Loader2, BookOpen, RefreshCw, Play, Pause } from "lucide-react";
import {
  fetchChapterSummary,
  fetchChapterSummaryAudio,
  type ChapterSummaryResponse,
} from "@/lib/abm-api";
import { usePlayerStore } from "@/lib/player-store";
import { toast } from "@/hooks/use-toast";

export function ChapterSummaryCard({
  jobId,
  chapterIndex,
}: {
  jobId: string;
  chapterIndex: number;
}) {
  const [state, setState] = useState<"collapsed" | "loading" | "loaded" | "error">("collapsed");
  const [summary, setSummary] = useState<ChapterSummaryResponse | null>(null);
  const [errorStatus, setErrorStatus] = useState("");

  // Summary audio state
  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track which chapter the current audio element belongs to, so a chapter
  // change tears down the old element (stale refs used to keep a chapter's
  // audio playing over the next chapter).
  const audioChapterRef = useRef<{ jobId: string; chapterIndex: number } | null>(null);

  const handleLoad = useCallback(async () => {
    setState("loading");
    try {
      const result = await fetchChapterSummary(jobId, chapterIndex);
      setSummary(result);
      setState("loaded");
    } catch (err) {
      setErrorStatus(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  }, [jobId, chapterIndex]);

  // ── Tear down the summary audio element on chapter change or unmount ──
  // This is mandatory: stale audio refs caused a chapter's audio to keep
  // playing over the next chapter before.
  const teardownAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
        a.src = "";
      } catch {
        /* ignore */
      }
    }
    audioRef.current = null;
    audioChapterRef.current = null;
    setAudioState("idle");
  }, []);

  // Chapter change → teardown. Also fires on unmount (jobId/chapterIndex are
  // stable for a given card instance, but the parent swaps the card when the
  // chapter changes, which unmounts this instance).
  useEffect(() => {
    return () => {
      teardownAudio();
    };
  }, [jobId, chapterIndex, teardownAudio]);

  const handleListenClick = useCallback(async () => {
    const summaryHash = summary?.text_sha;
    // Already have an audio element for this chapter → toggle play/pause.
    if (audioRef.current && audioChapterRef.current?.jobId === jobId
        && audioChapterRef.current?.chapterIndex === chapterIndex) {
      const a = audioRef.current;
      if (a.paused) {
        // Pause the main chapter audio before playing the summary. Do NOT
        // auto-resume it — the user explicitly chose to listen to the summary.
        usePlayerStore.getState().pause();
        a.play().catch(() => { /* ignore play rejection */ });
        setAudioState("playing");
      } else {
        a.pause();
        setAudioState("idle");
      }
      return;
    }

    // First click for this chapter: fetch the audio URL, create a NEW Audio
    // element, play it, keep it in a ref.
    setAudioState("loading");
    try {
      const url = await fetchChapterSummaryAudio(jobId, chapterIndex, summaryHash);
      // Tear down any previous element first (defensive — shouldn't exist
      // here, but guards against double-click races).
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch { /* */ }
        audioRef.current = null;
      }
      const a = new Audio(url);
      a.preload = "auto";
      audioRef.current = a;
      audioChapterRef.current = { jobId, chapterIndex };

      // When the summary audio ends naturally, flip back to idle so the
      // button shows "Listen to summary" again.
      a.addEventListener("ended", () => {
        setAudioState("idle");
        try { a.currentTime = 0; } catch { /* */ }
      });
      a.addEventListener("pause", () => {
        // Keep the button in sync if paused externally (e.g. another play).
        // Only flip if we were showing "playing".
        setAudioState((prev) => (prev === "playing" ? "idle" : prev));
      });

      // Pause the main chapter audio. No auto-resume.
      usePlayerStore.getState().pause();
      await a.play().catch(() => { /* ignore play rejection */ });
      setAudioState("playing");
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      toast({
        title: "Summary audio failed",
        description: `Summary audio failed (${code})`,
      });
      setAudioState("idle");
    }
  }, [jobId, chapterIndex, summary]);

  if (state === "collapsed") {
    return (
      <div className="mt-3">
        <button
          onClick={handleLoad}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg transition-all hover:scale-[1.02]"
          style={{
            background: "var(--aria-accent-glow)",
            color: "var(--aria-bg)",
            fontWeight: 500,
          }}
        >
          <BookOpen className="w-4 h-4" />
          Show summary
        </button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div
        className="mt-3 flex items-center gap-2 text-sm"
        style={{ color: "var(--aria-fg-muted)" }}
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        Generating summary…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="mt-3">
        <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
          Summary unavailable ({errorStatus})
        </p>
        <button
          onClick={handleLoad}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg mt-2 transition-colors"
          style={{
            color: "var(--aria-accent-glow)",
            border: "1px solid var(--aria-border)",
            background: "var(--aria-card)",
          }}
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      </div>
    );
  }

  // loaded
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
          Chapter summary
        </span>
      </div>
      <div className="space-y-3">
        {summary?.summary
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

      {/* Listen to summary — English-only edge-tts synthesis of the summary
          text. Three states: idle / loading / playing. */}
      <div className="mt-4">
        <button
          onClick={handleListenClick}
          disabled={audioState === "loading"}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
          style={{
            background: "var(--aria-accent-glow)",
            color: "var(--aria-bg)",
            fontWeight: 500,
          }}
          aria-label={
            audioState === "playing"
              ? "Pause summary audio"
              : audioState === "loading"
                ? "Preparing summary audio"
                : "Listen to summary"
          }
        >
          {audioState === "loading" ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Preparing audio…
            </>
          ) : audioState === "playing" ? (
            <>
              <Pause className="w-4 h-4" />
              Pause
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Listen to summary
            </>
          )}
        </button>
      </div>
    </div>
  );
}
