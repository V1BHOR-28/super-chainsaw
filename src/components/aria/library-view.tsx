"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Play,
  BookOpen,
  ArrowLeft,
  ListChecks,
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  RotateCcw,
  Coffee,
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
  getCoverUrl,
  sendHeartbeat,
  getJobChapters,
  deleteJob,
  isPollingStatus,
  type MyJob,
  type AnalyzeResponse,
  type AnalyzeChapter,
  type JobStatus,
  type ChapterMp3Info,
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
  /** ARIA: "synthesizing" | "finalizing" — when finalizing, the bar creeps 90→100. */
  progressPhase?: "synthesizing" | "finalizing";
  /** 0-100 — finalization sub-progress. */
  progressFinalizePct?: number;
  /** Unix timestamp of the last progress update (for stall detection). */
  progressUpdatedAt?: number;
  narrationLanguage?: "en" | "hinglish";
  selectedChapters?: number[];
  totalChapters?: number;
  chapterMp3s?: ChapterMp3Info[];
  /** Complete parsed chapter catalog (every chapter in the book). Carried
   *  through from /api/my_jobs so the player can render the full Chapters
   *  drawer without an extra round-trip when available. */
  chapterCatalog?: AnalyzeChapter[];
  /** Whether the EPUB had an embedded cover. When true, coverImgUrl is set. */
  hasCover?: boolean;
  /** URL to the Flask /api/cover/<jobId> endpoint. Empty string when no cover. */
  coverImgUrl?: string;
}

function toCard(job: MyJob): LibraryCard {
  const jobId = job.job_id;
  const title = job.title || "Untitled";
  const hasCover = job.has_cover ?? false;
  return {
    jobId,
    title,
    author: job.author ?? null,
    accent: accentForTitle(title || jobId),
    status: job.status,
    outputFormat: job.output_format,
    createdAt: job.created_at,
    progressCurrent: job.progress_current,
    progressTotal: job.progress_total,
    progressMessage: job.progress_message,
    progressPhase: job.progress_phase,
    progressFinalizePct: job.progress_finalize_pct,
    progressUpdatedAt: job.progress_updated_at,
    narrationLanguage: job.narration_language,
    selectedChapters: job.selected_chapters,
    totalChapters: job.total_chapters,
    chapterMp3s: job.chapter_mp3s,
    chapterCatalog: job.chapter_catalog,
    hasCover,
    // Cover URL from the Flask /api/cover endpoint — available immediately
    // after upload (the Flask app extracts it from the EPUB during analyze).
    coverImgUrl: getCoverUrl(jobId, hasCover) || undefined,
  };
}

function progressPct(card: LibraryCard): number {
  if (card.status === "done") return 100;
  // ARIA: during finalization, creep 90→100 based on the sub-progress
  // instead of freezing at N/N (the chunk counter is done).
  if (card.progressPhase === "finalizing") {
    const fin = card.progressFinalizePct ?? 0;
    return Math.max(90, Math.min(99, 90 + Math.round(fin * 0.1)));
  }
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
  // Scope localStorage by userId so admin's library doesn't leak to new users
  // on the same browser. Falls back to "anon" if user isn't loaded yet.
  const userId = useAriaStore((s) => s.user?.id) || "anon";
  const STORAGE_KEY = `aria-audiobook-library:${userId}`;
  const DELETED_KEY = `aria-audiobook-deleted:${userId}`;

  // ── Tombstone helpers (module-level, pure) ──
  function loadTombstones(key: string): Set<string> {
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }
  function persistTombstones(key: string, set: Set<string>) {
    try {
      // cap so it can't grow unbounded; keep most recent 500
      const arr = [...set].slice(-500);
      localStorage.setItem(key, JSON.stringify(arr));
    } catch {
      // non-blocking
    }
  }

  // ── Ref-backed tombstone store (single source of truth) ──
  // NEVER cleared on mount, user change, or logout. Only written to by
  // handleDelete (add) and handleFileSelected (remove on re-upload).
  const deletedRef = useRef<Set<string>>(
    typeof window !== "undefined" ? loadTombstones(DELETED_KEY) : new Set(),
  );
  const [deletedVersion, setDeletedVersion] = useState(0); // re-render trigger

  // ── Cards state ──
  // Load from localStorage on mount — instant display before the API responds.
  // Filter tombstones AND write the filtered array back so stale entries are
  // physically dropped from localStorage.
  const [cards, setCards] = useState<LibraryCard[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const parsed: LibraryCard[] = stored ? JSON.parse(stored) : [];
      const tomb = loadTombstones(DELETED_KEY);
      const filtered = parsed.filter((c) => !tomb.has(c.jobId));
      // Write the filtered array back so stale entries are physically dropped.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
      return filtered;
    } catch {
      return [];
    }
  });

  // Clear cards and re-trigger fetch when the user changes (login/logout/switch)
  // so stale localStorage from a previous user doesn't flash before the API responds.
  // Also reset loading=true so the user sees the loading indicator (not the
  // empty "No audiobooks yet" state) while the fresh fetch is in flight.
  // CRITICAL: also reset isFetchingRef so the new fetch isn't blocked by the
  // guard in fetchJobsWithRetry. Without this, when userId changes from "anon"
  // to the real ID while the first fetch is still in flight, the guard
  // prevents the second fetch from running, and the first fetch's .finally()
  // sets loading=false prematurely — the user sees "No audiobooks yet" instead
  // of the loading/waking-up UI.
  useEffect(() => {
    deletedRef.current = loadTombstones(`aria-audiobook-deleted:${userId}`);
    setDeletedVersion((v) => v + 1);
    setCards([]);
    setLoading(true);
    setError(null);
    setWakingUp(false);
    isFetchingRef.current = false;
  }, [userId]);

  // One-time migration: remove old unscoped localStorage keys so admin's
  // library doesn't leak to new users on browsers that had the old format.
  // This runs on every mount (not gated) so it cleans up even if the
  // migration flag was set in a previous session but old keys reappeared.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      // Always remove old unscoped keys — they should never be used again.
      localStorage.removeItem("aria-audiobook-library");
      localStorage.removeItem("aria-audiobook-deleted");
      localStorage.setItem("aria-audiobook-migrated", "v2");
    } catch {
      // non-blocking
    }
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ARIA cold-start state: the Flask service on Render's free tier spins down
  // after ~15 min idle. The first getMyJobs() call can take 30-90+ seconds
  // (cold start) or hit Vercel's 60s function timeout. Without a distinct
  // 'wakingUp' state, the user stares at a bare 'Loading your library…'
  // with no indication that a cold start is happening (not a hang/crash).
  // Set when the first fetch exceeds ~8s OR fails with 502/timeout/network
  // error (then we retry with backoff before surfacing the real error).
  const [wakingUp, setWakingUp] = useState(false);
  const [hoveredJob, setHoveredJob] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzeResponse, setAnalyzeResponse] = useState<AnalyzeResponse | null>(null);
  const [wholeBookJob, setWholeBookJob] = useState<LibraryCard | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isFetchingRef = useRef(false);

  // Persist cards to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    } catch {
      // localStorage may be full — non-blocking
    }
  }, [cards]);

  // ── Single chokepoint for setCards ──
  // Every setCards call MUST go through applyCards so tombstones are always
  // filtered. The ONLY exception is the setCards([]) reset in the [userId] effect.
  const applyCards = useCallback((updater: (prev: LibraryCard[]) => LibraryCard[]) => {
    setCards((prev) => updater(prev).filter((c) => !deletedRef.current.has(c.jobId)));
  }, []);

  // ARIA: fetch with cold-start awareness. The Flask service on Render's
  // free tier spins down after ~15 min idle, so the first request after idle
  // can take 30-90+ seconds (or hit Vercel's 60s function timeout). Instead
  // of surfacing a generic error, we:
  //   1. Show a 'wakingUp' message if the first fetch exceeds ~8s.
  //   2. On failure (502/timeout/network error), retry with backoff
  //      (5s, 15s, 30s) BEFORE surfacing the error — cold starts are the
  //      EXPECTED common case, not an exceptional error.
  // The retry loop only runs for the INITIAL fetch (loading=true, no cards
  // yet). Polling retries (during generation) use the simpler fetchJobs()
  // path below — a failed poll just skips that cycle and tries again next
  // interval, which is fine because the user already has cards on screen.
  const fetchJobsWithRetry = useCallback(async (isInitial: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
    const RETRY_DELAYS = isInitial ? [5000, 15000, 30000] : [];
    const WAKEUP_THRESHOLD = 3000; // show 'waking up' after 3s (was 8s — too slow)
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        // Race the fetch against the wakeup threshold so we can show the
        // 'waking up' message WITHOUT aborting the fetch (the fetch keeps
        // running — we just flip the UI state after 8s).
        const fetchPromise = getMyJobs();
        if (isInitial && attempt === 0) {
          const timer = new Promise<void>((resolve) =>
            setTimeout(() => resolve(), WAKEUP_THRESHOLD),
          );
          await Promise.race([fetchPromise.then(() => undefined), timer]);
          // If the fetch hasn't resolved yet, show the waking-up message.
          // The fetch continues in the background — we await it next.
          setWakingUp(true);
        }
        const data = await fetchPromise;
        setWakingUp(false);
        // Filter out job_ids the user has explicitly deleted.
        const tomb = deletedRef.current;
        const apiCards = data.jobs.map(toCard).filter((c) => !tomb.has(c.jobId));
        applyCards((prev) => {
          const apiIds = new Set(apiCards.map((c) => c.jobId));
          const _ACTIVE = new Set(["generating", "optimizing", "translating"]);
          const staleCards = prev.filter(
            (c) => !apiIds.has(c.jobId) && !tomb.has(c.jobId) && !_ACTIVE.has(c.status),
          );
          return [...apiCards, ...staleCards];
        });
        setError(null);
        return; // success — exit the retry loop
      } catch (err) {
        lastErr = err;
        console.error(`[library-view] fetch attempt ${attempt + 1} failed:`, err);
        // If this was the initial fetch and we haven't shown the waking-up
        // message yet, show it now (the failure is likely a cold start).
        if (isInitial) setWakingUp(true);
        if (attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          console.log(`[library-view] retrying in ${delay / 1000}s (attempt ${attempt + 2}/${RETRY_DELAYS.length + 1})`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    // All retries exhausted — surface the error to the user.
    setWakingUp(false);
    if (isInitial && cards.length === 0) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      // Friendlier message for the common cold-start timeout case.
      const isTimeout =
        /timeout|502|503|504|network|fetch failed/i.test(msg);
      setError(
        isTimeout
          ? "The audiobook service is still waking up. Please try again in a moment."
          : msg,
      );
    }
    } finally {
      isFetchingRef.current = false;
    }
  }, [applyCards, cards.length]);

  // Simple fetch (no retry) for polling — a failed poll just skips that cycle.
  const fetchJobs = useCallback(async () => {
    await fetchJobsWithRetry(false);
  }, [fetchJobsWithRetry]);

  useEffect(() => {
    // Don't fetch until the real userId is available (not "anon").
    // Without this, the component fetches with "anon" first (returns 0 jobs
    // immediately), sets loading=false, then when the session loads and
    // userId changes to the real ID, loading is set to true again but the
    // fetch may return quickly with 0 jobs for a new user — the user sees
    // "No audiobooks yet" instead of the loading/waking-up UI.
    if (userId === "anon") return;
    // Initial fetch with cold-start retry logic.
    // Re-runs when userId changes (login/logout/switch) so the new user's
    // library is fetched fresh.
    // Enforce a minimum 1.5s loading time so the user always sees the loading
    // UI (not a jarring flash of "No audiobooks yet" when the backend is
    // responsive but the user has 0 jobs).
    const minLoadTimer = new Promise<void>((r) => setTimeout(r, 1500));
    Promise.all([
      fetchJobsWithRetry(true),
      minLoadTimer,
    ]).finally(() => setLoading(false));
  }, [fetchJobsWithRetry, userId]);

  // Poll while any job is still generating / optimizing / translating.
  // Also send heartbeats to keep generating jobs alive (the Flask app cancels
  // jobs with no heartbeat for 60+ seconds).
  useEffect(() => {
    const polling = cards.filter((c) => isPollingStatus(c.status));
    if (polling.length === 0) return;
    const generating = cards.filter((c) => c.status === "generating");

    const interval = setInterval(() => {
      fetchJobs();
      // Send a heartbeat only to generating jobs (the heartbeat endpoint
      // is what prevents the 60s cancel timeout — optimizing/translating
      // don't have this constraint).
      generating.forEach((c) => sendHeartbeat(c.jobId));
    }, 10000);
    return () => clearInterval(interval);
  }, [cards, fetchJobs]);

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file fires onChange
    if (!file) return;

    // Reject files > 50MB client-side to save a round-trip
    if (file.size > 50 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)}MB. Maximum is 50MB.`,
      });
      return;
    }

    setUploading(true);
    // Persistent "analyzing" toast — only dismissed in the finally block
    const analyzingToast = toast({
      title: `Analyzing ${file.name}…`,
      description: file.name.toLowerCase().endsWith(".pdf")
        ? "PDFs can take a few minutes to parse. Please wait."
        : "This can take a few seconds.",
    });
    try {
      const resp = await analyzeEpub(file);
      // If the user previously deleted this job_id (e.g. the old backend
      // resurrected it via file_hash dedup), un-delete it so it shows in
      // the library again. The user explicitly re-uploaded the EPUB, so
      // they want it back.
      if (deletedRef.current.has(resp.job_id)) {
        deletedRef.current.delete(resp.job_id);
        persistTombstones(`aria-audiobook-deleted:${userId}`, deletedRef.current);
        setDeletedVersion((v) => v + 1);
      }
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
      // Dismiss the persistent "analyzing" toast
      if (analyzingToast && typeof analyzingToast.dismiss === "function") {
        analyzingToast.dismiss();
      }
    }
  };

  const handleOpen = async (card: LibraryCard) => {
    if (card.status === "done") {
      // Fetch the chapter list so the player can show a chapter browser
      // with "which chapters are in this audiobook" badges. Non-blocking —
      // if it fails, the player still works without the browser.
      let chaptersResp: AnalyzeResponse | null = null;
      try {
        chaptersResp = await getJobChapters(card.jobId);
      } catch (err) {
        console.warn("[library-view] could not pre-fetch chapters for player", err);
      }
      openPlayer({
        jobId: card.jobId,
        title: card.title,
        author: card.author ?? "",
        accent: card.accent,
        downloadUrl: getDownloadUrl(card.jobId),
        selectedChapters: chaptersResp?.selected_chapters ?? card.selectedChapters,
        totalChapters: chaptersResp?.total_chapters ?? card.totalChapters,
        chapters: chaptersResp?.chapters,
        chapterCatalog: chaptersResp?.chapter_catalog ?? card.chapterCatalog,
        chapterMp3s: chaptersResp?.chapter_mp3s ?? card.chapterMp3s,
        coverImgUrl: card.coverImgUrl,
      });
      return;
    }
    if (card.status === "analyzed" || card.status === "optimized") {
      // Fetch the chapter list from the Flask app so the selector opens
      // with per-chapter checkboxes (not the 'whole book' fallback).
      setResetting(card.jobId);
      try {
        const chaptersResp = await getJobChapters(card.jobId);
        setAnalyzeResponse(chaptersResp);
      } catch (err) {
        console.error("[library-view] could not load chapters", err);
        // Fall back to whole-book mode if the chapter data is unavailable
        setWholeBookJob(card);
      } finally {
        setResetting(null);
      }
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

  // Reset a done job back to 'analyzed' so the user can pick different
  // chapters + voice and re-generate. Fetches the chapter list from the
  // Flask app's in-memory state (job['info'].chapters) so the selector
  // opens with per-chapter checkboxes, not the 'whole book' fallback.
  //
  // If the job is only in download tokens (after Flask restart), we can't
  // reset it — but we can still open the selector with the chapter data
  // from the token. The user picks chapters + voice, and the generate
  // call creates a fresh job via re-upload or the existing token.
  const handleConvertMore = async (card: LibraryCard) => {
    setResetting(card.jobId);
    try {
      // Fetch the chapter list. The Flask /api/generate endpoint now
      // accepts jobs with status='done' directly (no resetToChapters needed).
      // The gen_epoch mechanism creates a new output directory for each
      // generation, preserving previous audio.
      const chaptersResp = await getJobChapters(card.jobId);
      setAnalyzeResponse(chaptersResp);
      toast({
        title: "Ready for new chapters",
        description: `${chaptersResp.total_chapters} chapters available — pick which to convert.`,
      });
    } catch (err) {
      console.error("[library-view] could not load chapters", err);
      toast({
        title: "Could not load chapters",
        description: err instanceof Error ? err.message : "The book data may have expired. Re-upload the EPUB.",
      });
    } finally {
      setResetting(null);
    }
  };

  const handleDelete = async (jobId: string) => {
    // 1. tombstone FIRST (before the network call) so any in-flight poll
    //    that resolves later is already filtered.
    deletedRef.current.add(jobId);
    persistTombstones(`aria-audiobook-deleted:${userId}`, deletedRef.current);
    setDeletedVersion((v) => v + 1);
    applyCards((prev) => prev.filter((c) => c.jobId !== jobId));
    setConfirmDelete(null);
    try {
      await deleteJob(jobId);
    } catch (e) {
      console.warn("[library-view] backend delete failed, tombstone kept", e);
    }
    toast({ title: "Audiobook removed" });
  };

  const handleCloseSelector = () => {
    setAnalyzeResponse(null);
    setWholeBookJob(null);
  };

  const handleConvertStarted = () => {
    // The user has clicked "Convert" in the chapter selector.
    // The resetToChapters call happens inside the selector's handleConvert
    // (before generate()), not here. This callback just flips the UI status
    // and refreshes the job list.
    const jobId = analyzeResponse?.job_id ?? wholeBookJob?.jobId;
    if (jobId) {
      applyCards((prev) =>
        prev.map((c) => (c.jobId === jobId ? { ...c, status: "generating" } : c)),
      );
    }
    handleCloseSelector();
    fetchJobs();
  };

  // ── Final render-time guard ──
  // visibleCards is the tombstone-filtered list used for rendering.
  // `cards` is still used for the polling effect (which doesn't need filtering).
  const visibleCards = useMemo(
    () => cards.filter((c) => !deletedRef.current.has(c.jobId)),
    [cards, deletedVersion],
  );

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
                Upload an EPUB or PDF and ARIA narrates it — free, fast,
                and yours to keep.
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

        {loading && wakingUp && visibleCards.length === 0 ? (
          // ARIA cold-start state: the Flask service on Render's free tier is
          // spinning up (takes 30-90s). Show a dedicated, visually distinct UI
          // so the user knows this is expected, not a hang or a blank screen.
          <div className="flex flex-col items-center justify-center py-24 px-6">
            <div className="relative w-20 h-20 mb-6">
              {/* Pulsing rings around the coffee cup */}
              <div className="absolute inset-0 rounded-full animate-ping opacity-20" style={{ background: "var(--aria-accent)" }} />
              <div className="absolute inset-2 rounded-full animate-pulse opacity-30" style={{ background: "var(--aria-accent)" }} />
              <div className="absolute inset-0 flex items-center justify-center">
                <Coffee
                  size={36}
                  strokeWidth={1.5}
                  className="relative z-10"
                  style={{ color: "var(--aria-accent-glow)" }}
                />
              </div>
            </div>
            <h3 className="text-lg font-serif mb-2" style={{ color: "var(--aria-fg)" }}>
              Waking up the audiobook service
            </h3>
            <p className="text-sm text-center max-w-sm" style={{ color: "var(--aria-fg-muted)" }}>
              The server spins down when idle to save resources. It&apos;s starting back up now — this usually takes 30–60 seconds.
            </p>
            <div className="flex items-center gap-1.5 mt-4">
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--aria-accent-glow)", animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--aria-accent-glow)", animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--aria-accent-glow)", animationDelay: "300ms" }} />
            </div>
          </div>
        ) : loading && !wakingUp ? (
          <div className="flex flex-col items-center justify-center py-24" style={{ color: "var(--aria-fg-dim)" }}>
            <Loader2 size={32} strokeWidth={1.5} className="mx-auto mb-4 animate-spin" style={{ color: "var(--aria-accent-glow)" }} />
            <p className="text-sm">Loading your library…</p>
          </div>
        ) : error && visibleCards.length === 0 ? (
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
        ) : visibleCards.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen size={40} strokeWidth={1} className="mx-auto mb-4 opacity-30" style={{ color: "var(--aria-fg-dim)" }} />
            <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
              No audiobooks yet.
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--aria-fg-dim)" }}>
              Click <span className="font-medium">Upload book</span> above to pick an
              EPUB or PDF — ARIA will analyze it and let you choose which chapters to narrate.
            </p>
          </div>
        ) : (
          <div>
            {/* ARIA cold-start banner: cards are showing (from localStorage or
                a previous fetch), but a refresh is retrying due to a cold
                start. Non-blocking — the user can still interact with their
                library while the refresh runs in the background. */}
            {wakingUp && (
              <div
                className="text-center mb-4 py-2 px-4 rounded-lg"
                style={{
                  background: "var(--aria-bg-elevated)",
                  border: "1px solid var(--aria-border)",
                }}
              >
                <p className="text-xs" style={{ color: "var(--aria-fg-muted)" }}>
                  <Coffee
                    size={12}
                    className="inline animate-pulse mr-1.5"
                    style={{ color: "var(--aria-accent-glow)" }}
                  />
                  Refreshing your library — the service is waking up, this can take up to a minute.
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5 sm:gap-7">
            {visibleCards.map((card, i) => {
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
                        coverImgUrl={card.coverImgUrl}
                        jobId={card.jobId}
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
                      <div className="absolute top-3 right-3 flex items-center gap-1.5">
                        {card.narrationLanguage === "hinglish" && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-mono uppercase tracking-wider" style={{ background: "rgba(168,85,247,0.18)", color: "#a855f7" }}>
                            Hinglish
                          </span>
                        )}
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

                      {/* delete button (top-left, hover only) */}
                      {confirmDelete === card.jobId ? (
                        <div className="absolute top-3 left-3 flex items-center gap-1 z-10">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(card.jobId); }}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium bg-[rgba(239,68,68,0.2)] border border-[rgba(239,68,68,0.4)] text-[#ef4444]"
                          >
                            Delete
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium bg-[var(--aria-card)] border border-[var(--aria-border)] text-[var(--aria-fg-muted)]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(card.jobId); }}
                          className={`absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                            hoveredJob === card.jobId ? "opacity-100" : "opacity-0"
                          } bg-black/50 text-[var(--aria-fg-muted)] hover:text-[#ef4444] z-10`}
                          title="Delete audiobook"
                          aria-label="Delete audiobook"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    <div className="mt-3.5">
                      <h3 className="font-serif text-lg leading-snug text-[var(--aria-fg)] group-hover:text-[var(--aria-accent-glow)] transition-colors">
                        {card.title}
                      </h3>
                      <p className="text-xs text-[var(--aria-fg-muted)] mt-0.5">
                        {card.author ? `by ${card.author}` : "Author unknown"}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {isDone ? (
                          <>
                            <p className="text-[11px] text-[var(--aria-accent-glow)]">
                              {card.outputFormat?.toUpperCase() || "MP3"} · tap to play
                            </p>
                            {/* ARIA: prefer chapterMp3s.length (the merged,
                                authoritative count) over selectedChapters.length
                                (which is overwritten per generation). Falls back
                                to selectedChapters if chapterMp3s is missing. */}
                            {(() => {
                              const chCount = card.chapterMp3s?.length || card.selectedChapters?.length || 0;
                              return chCount > 0 && card.totalChapters ? (
                                <span className="text-[11px] flex items-center gap-1" style={{ color: "#22c55e" }} title="Chapters already in this audiobook">
                                  <ListChecks size={10} />
                                  {chCount}/{card.totalChapters} chapters
                                </span>
                              ) : null;
                            })()}
                            {resetting === card.jobId ? (
                              <span className="text-[11px] text-[var(--aria-fg-muted)] flex items-center gap-1">
                                <Loader2 size={10} className="animate-spin" /> Loading…
                              </span>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleConvertMore(card); }}
                                className="text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1 transition-colors hover:bg-white/5"
                                style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                                title="Convert more chapters"
                              >
                                <RotateCcw size={10} /> More chapters
                              </button>
                            )}
                          </>
                        ) : isGenerating ? (
                          <div className="flex flex-col gap-1">
                            <p className="text-[11px] text-[var(--aria-accent-glow)] flex items-center gap-1">
                              <span className="status-dot" />
                              {card.progressMessage || `Converting… ${pct}%`}
                            </p>
                            {(() => {
                              // ARIA: stall banner — if no progress for 4+ min,
                              // the free-tier server may be waking up or restarting.
                              const pu = card.progressUpdatedAt ?? 0;
                              if (pu > 0 && Date.now() / 1000 - pu > 240) {
                                return (
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-[var(--aria-fg-dim)]">
                                      No progress for a few minutes — the free-tier server may be waking up or restarting
                                    </span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); fetchJobs(); }}
                                      className="text-[10px] px-1.5 py-0.5 rounded-md flex items-center gap-1 transition-colors hover:bg-white/5"
                                      style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                                    >
                                      Refresh
                                    </button>
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        ) : isError ? (
                          <div className="flex items-center gap-2">
                            <p className="text-[11px] text-[#ef4444]">
                              {card.status === "cancelled" ? "Cancelled" : "Generation failed"}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleConvertMore(card); }}
                              className="text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1 transition-colors hover:bg-white/5"
                              style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                              title="Try again"
                            >
                              <RotateCcw size={10} /> Retry
                            </button>
                          </div>
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
          </div>
        )}
      </div>

      {/* Chapter selector modal — opened either after upload (with analyzeResponse)
          or when re-clicking an analyzed job (whole-book mode). */}
      {selectorProps && <ChapterSelector {...selectorProps} />}
    </div>
  );
}
