"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  BookOpen,
  ArrowLeft,
  ListChecks,
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { AmbientGlow, GradientText } from "./primitives";
import { ScrollReveal } from "./scroll-reveal";
import { BookCover } from "./book-cover";
import { ChapterSelector } from "./chapter-selector";
import { usePlayerStore } from "@/lib/player-store";
import { useAriaStore } from "@/lib/store";
import {
  getMyJobs,
  analyzeEpub,
  getDownloadUrl,
  isPollingStatus,
  type MyJob,
  type AnalyzeResponse,
  type JobStatus,
} from "@/lib/abm-api";
import { toast } from "@/hooks/use-toast";

/** Deterministic accent color from a job's title — used because the Flask
 *  API doesn't return an accent color per book. */
const ACCENT_PALETTE = [
  "#f59e0b", // amber (default ARIA gold)
  "#d97706",
  "#b45309",
  "#a16207",
  "#92400e",
  "#c2410c",
  "#9a3412",
  "#7c2d12",
  "#9d174d",
  "#831843",
];
function accentForTitle(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return ACCENT_PALETTE[Math.abs(hash) % ACCENT_PALETTE.length];
}

/** State of a job in the library, mapped from the Flask MyJob shape. */
interface LibraryCard {
  jobId: string;
  title: string;
  author: string | null;
  accent: string;
  status: JobStatus;
  outputFormat?: string;
  createdAt?: number;
  progressCurrent?: number;
  progressTotal?: number;
  progressMessage?: string;
}

function toCard(job: MyJob): LibraryCard {
  return {
    jobId: job.job_id,
    title: job.title || "Untitled",
    author: job.author ?? null,
    accent: accentForTitle(job.title || job.job_id),
    status: job.status,
    outputFormat: job.output_format,
    createdAt: job.created_at,
    progressCurrent: job.progress_current,
    progressTotal: job.progress_total,
    progressMessage: job.progress_message,
  };
}

function progressPct(card: LibraryCard): number {
  if (card.status === "done") return 100;
  const cur = card.progressCurrent ?? 0;
  const tot = card.progressTotal ?? 0;
  if (tot <= 0) return 0;
  return Math.max(0, Math.min(99, Math.round((cur / tot) * 100)));
}

/**
 * LibraryView — fetches the user's audiobook jobs from the audiobook-maker
 * Flask app (via /api/my_jobs with XTransformPort=5601).
 *
 * Each job is a single MP3 produced by edge-tts. Click behavior:
 *   analyzed / optimized → open chapter selector (re-pick chapters + voice)
 *   generating / optimizing / translating → show progress (no action)
 *   done → open the player (single MP3 via /api/download/<job_id>)
 *   error / cancelled / interrupted → show error pill (no action)
 */
export function LibraryView() {
  const openPlayer = usePlayerStore((s) => s.openPlayer);
  const setActiveWorkspace = useAriaStore((s) => s.setActiveWorkspace);
  const [cards, setCards] = useState<LibraryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredJob, setHoveredJob] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzeResponse, setAnalyzeResponse] = useState<AnalyzeResponse | null>(null);
  /** For "analyzed" jobs clicked from the grid — we don't have the chapter
   *  data anymore (the upload-time analyzeResponse is long gone), so we open
   *  the selector in "whole-book" mode: just voice + convert. */
  const [wholeBookJob, setWholeBookJob] = useState<LibraryCard | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const data = await getMyJobs();
      setCards(data.jobs.map(toCard));
      setError(null);
    } catch (err) {
      console.error("[library-view] failed to load jobs", err);
      setError(err instanceof Error ? err.message : "Failed to load your library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Poll while any job is still generating / optimizing / translating.
  useEffect(() => {
    if (!cards.some((c) => isPollingStatus(c.status))) return;
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [cards, fetchJobs]);

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file fires onChange
    if (!file) return;
    setUploading(true);
    try {
      const resp = await analyzeEpub(file);
      setAnalyzeResponse(resp);
      toast({
        title: "Book analyzed",
        description: `${resp.title} — ${resp.total_chapters} chapters detected`,
      });
    } catch (err) {
      console.error("[library-view] analyze failed", err);
      toast({
        title: "Could not analyze book",
        description: err instanceof Error ? err.message : "Try again",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleOpen = (card: LibraryCard) => {
    if (card.status === "done") {
      openPlayer({
        jobId: card.jobId,
        title: card.title,
        author: card.author ?? "",
        accent: card.accent,
        downloadUrl: getDownloadUrl(card.jobId),
      });
      return;
    }
    if (card.status === "analyzed" || card.status === "optimized") {
      // We don't have the analyzeResponse anymore — open the selector in
      // "whole-book" mode (just voice + convert the whole book).
      setWholeBookJob(card);
      return;
    }
    if (isPollingStatus(card.status)) {
      toast({
        title: "Still generating",
        description: card.progressMessage || "Hang tight — we'll have audio soon.",
      });
      return;
    }
    // error / cancelled / interrupted
    toast({
      title: "Generation failed",
      description: "Re-upload the EPUB to try again.",
    });
  };

  const handleCloseSelector = () => {
    setAnalyzeResponse(null);
    setWholeBookJob(null);
  };

  const handleConvertStarted = () => {
    // Optimistically flip the job to "generating" so the card shows the
    // spinner immediately, then refresh from the server on the next poll.
    const jobId = analyzeResponse?.job_id ?? wholeBookJob?.jobId;
    if (jobId) {
      setCards((prev) =>
        prev.map((c) => (c.jobId === jobId ? { ...c, status: "generating" } : c)),
      );
    }
    handleCloseSelector();
    fetchJobs();
  };

  // Determine which (if any) selector modal to render.
  const selectorProps = analyzeResponse
    ? {
        analyzeResponse,
        jobId: analyzeResponse.job_id,
        title: analyzeResponse.title,
        author: analyzeResponse.author,
        onClose: handleCloseSelector,
        onConvertStarted: handleConvertStarted,
      }
    : wholeBookJob
      ? {
          analyzeResponse: null as AnalyzeResponse | null,
          jobId: wholeBookJob.jobId,
          title: wholeBookJob.title,
          author: wholeBookJob.author ?? "",
          onClose: handleCloseSelector,
          onConvertStarted: handleConvertStarted,
        }
      : null;

  return (
    <div className="relative min-h-screen overflow-hidden">
      <AmbientGlow color="#f59e0b" opacity={0.1} size={600} className="top-0 right-0" />

      <div className="relative z-10 max-w-7xl mx-auto px-5 sm:px-8 pt-10 sm:pt-14 pb-16">
        {/* Back to chat — exits the audiobook workspace entirely */}
        <button
          onClick={() => setActiveWorkspace("chat")}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors mb-6"
          style={{ color: "var(--aria-fg-muted)" }}
        >
          <ArrowLeft size={15} />
          Back to chat
        </button>
        <ScrollReveal>
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
            <div>
              <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[var(--aria-accent-glow)] mb-3">
                The library
              </div>
              <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-none">
                Stories worth{" "}
                <GradientText as="span" className="italic">
                  your full attention
                </GradientText>
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <p className="text-sm text-[var(--aria-fg-muted)] max-w-xs hidden sm:block">
                Upload an EPUB and ARIA narrates it with edge-tts — free, fast,
                and yours to keep for 18 hours.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".epub,.pdf,.txt,.abm"
                onChange={handleFileSelected}
                className="hidden"
              />
              <button
                onClick={handleUploadClick}
                disabled={uploading}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: "var(--aria-accent-glow)",
                  color: "var(--aria-bg)",
                  boxShadow: "0 0 24px rgba(245,158,11,0.35)",
                }}
              >
                {uploading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    Analyzing…
                  </>
                ) : (
                  <>
                    <Upload size={15} />
                    Upload book
                  </>
                )}
              </button>
            </div>
          </div>
        </ScrollReveal>

        {loading ? (
          <div className="text-center py-20" style={{ color: "var(--aria-fg-dim)" }}>
            <p className="text-sm">Loading your library…</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
              Couldn&apos;t load your library — {error}
            </p>
            <button
              onClick={fetchJobs}
              className="mt-3 text-sm underline"
              style={{ color: "var(--aria-accent-glow)" }}
            >
              Try again
            </button>
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen size={40} strokeWidth={1} className="mx-auto mb-4 opacity-30" style={{ color: "var(--aria-fg-dim)" }} />
            <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
              No audiobooks yet.
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--aria-fg-dim)" }}>
              Click <span className="font-medium">Upload book</span> above to pick an
              EPUB — ARIA will analyze it and let you choose which chapters to narrate.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5 sm:gap-7">
            {cards.map((card, i) => {
              const pct = progressPct(card);
              const isDone = card.status === "done";
              const isGenerating = isPollingStatus(card.status) && card.status !== "analyzed" && card.status !== "optimized";
              const isError = card.status === "error" || card.status === "cancelled" || card.status === "interrupted";
              return (
                <ScrollReveal key={card.jobId} delay={i * 80}>
                  <div
                    className="group text-left w-full relative"
                    onMouseEnter={() => setHoveredJob(card.jobId)}
                    onMouseLeave={() => setHoveredJob(null)}
                  >
                    <div className="book-cover aspect-[3/5] relative cursor-pointer" onClick={() => handleOpen(card)}>
                      <BookCover
                        title={card.title}
                        accent={card.accent}
                        className="absolute inset-0"
                      />
                      {/* gradient overlay */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />

                      {/* play button on hover (only for done jobs) */}
                      {isDone && (
                        <div
                          className={`absolute inset-0 flex items-center justify-center transition-all duration-500 ${
                            hoveredJob === card.jobId
                              ? "opacity-100 backdrop-blur-[2px] bg-black/30"
                              : "opacity-0"
                          }`}
                        >
                          <span className="w-14 h-14 rounded-full bg-[var(--aria-fg)] text-[var(--aria-bg)] flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.5)] group-hover:scale-110 transition-transform duration-500">
                            <Play className="w-5 h-5 fill-current ml-0.5" />
                          </span>
                        </div>
                      )}

                      {/* generating overlay — pulsing center spinner */}
                      {isGenerating && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
                          <div className="flex flex-col items-center gap-2">
                            <Loader2 className="w-7 h-7 animate-spin" style={{ color: "var(--aria-accent-glow)" }} />
                            <span className="text-[10px] font-mono tracking-wider" style={{ color: "var(--aria-accent-glow)" }}>
                              {pct}%
                            </span>
                          </div>
                        </div>
                      )}

                      {/* status pill (top-right) */}
                      <div className="absolute top-3 right-3">
                        {isDone ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}>
                            <CheckCircle2 size={10} /> Ready
                          </span>
                        ) : isGenerating ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "rgba(245,158,11,0.18)", color: "var(--aria-accent-glow)" }}>
                            <span className="status-dot" /> {pct}%
                          </span>
                        ) : isError ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "rgba(239,68,68,0.18)", color: "#ef4444" }}>
                            <AlertCircle size={10} /> Failed
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "rgba(245,158,11,0.15)", color: "var(--aria-accent-glow)" }}>
                            <ListChecks size={10} /> Ready
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-3.5">
                      <h3 className="font-serif text-lg leading-snug text-[var(--aria-fg)] group-hover:text-[var(--aria-accent-glow)] transition-colors">
                        {card.title}
                      </h3>
                      <p className="text-xs text-[var(--aria-fg-muted)] mt-0.5">
                        {card.author ? `by ${card.author}` : "Author unknown"}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {isDone ? (
                          <p className="text-[11px] text-[var(--aria-accent-glow)]">
                            {card.outputFormat?.toUpperCase() || "MP3"} · tap to play
                          </p>
                        ) : isGenerating ? (
                          <p className="text-[11px] text-[var(--aria-accent-glow)] flex items-center gap-1">
                            <span className="status-dot" />
                            {card.progressMessage || `Converting… ${pct}%`}
                          </p>
                        ) : isError ? (
                          <p className="text-[11px] text-[#ef4444]">
                            {card.status === "cancelled" ? "Cancelled" : "Generation failed"}
                          </p>
                        ) : (
                          <p className="text-[11px] text-[var(--aria-accent-glow)] flex items-center gap-1">
                            <ListChecks size={11} />
                            Analyzed · tap to convert
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </ScrollReveal>
              );
            })}
          </div>
        )}
      </div>

      {/* Chapter selector modal — opened either after upload (with analyzeResponse)
          or when re-clicking an analyzed job (whole-book mode). */}
      {selectorProps && <ChapterSelector {...selectorProps} />}
    </div>
  );
}
