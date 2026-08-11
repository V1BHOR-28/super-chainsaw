"use client";

import { useState, useCallback } from "react";
import { Loader2, BookOpen, RefreshCw } from "lucide-react";
import { fetchChapterSummary, type ChapterSummaryResponse } from "@/lib/abm-api";

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
    </div>
  );
}
