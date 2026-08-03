"use client";

import { useState, useRef, useEffect } from "react";
import {
  Play,
  Pause,
  Rewind,
  FastForward,
  ChevronLeft,
  ArrowLeft,
  Settings2,
  Gauge,
  Moon,
  Volume2,
  VolumeX,
  X,
  Clock,
  ListChecks,
  Check,
} from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import { useAriaStore } from "@/lib/store";
import { formatTime } from "@/lib/audiobooks";
import { cn } from "@/lib/utils";
import { AmbientGlow, StatusPill, AriaDivider } from "./primitives";
import { NowPlayingBars } from "./waveform";
import { BookCover } from "./book-cover";
import { getJobChapters, type AnalyzeResponse, type ChapterMp3Info } from "@/lib/abm-api";

/**
 * PlayerView — plays the single MP3 produced by the audiobook-maker Flask
 * app for a finished job. No chapter list, no bookmarks (the Flask app
 * produces a single MP3, not per-chapter files). Settings drawer holds
 * playback rate, volume, sleep timer, and keyboard shortcut reference.
 *
 * Audio playback itself is driven by `useAudioEngine`, which is mounted
 * at the workspace root (audiobook-workspace.tsx) so it survives view
 * switches.
 */
export function PlayerView() {
  const job = usePlayerStore((s) => s.currentJob);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const showSettings = usePlayerStore((s) => s.showSettings);
  const sleepTimerMinutes = usePlayerStore((s) => s.sleepTimerMinutes);

  const toggle = usePlayerStore((s) => s.toggle);
  const skip = usePlayerStore((s) => s.skip);
  const seek = usePlayerStore((s) => s.seek);
  const seekToChapter = usePlayerStore((s) => s.seekToChapter);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const closePlayer = usePlayerStore((s) => s.closePlayer);
  const toggleSettings = usePlayerStore((s) => s.toggleSettings);
  const setActiveWorkspace = useAriaStore((s) => s.setActiveWorkspace);

  // Chapter browser drawer state
  const [showChapters, setShowChapters] = useState(false);
  const [chaptersData, setChaptersData] = useState<AnalyzeResponse | null>(null);
  const [chaptersLoading, setChaptersLoading] = useState(false);

  // Lazy-load chapter data when the user opens the browser (or use what was
  // passed in from the library via job.chapters / job.selectedChapters)
  const loadChapters = async () => {
    if (chaptersData || !job) return;
    setChaptersLoading(true);
    try {
      const resp = await getJobChapters(job.jobId);
      setChaptersData(resp);
    } catch (err) {
      console.error("[player-view] could not load chapters", err);
    } finally {
      setChaptersLoading(false);
    }
  };

  const toggleChapters = () => {
    const next = !showChapters;
    setShowChapters(next);
    if (next) {
      // Close settings if open (mutually exclusive drawers)
      if (usePlayerStore.getState().showSettings) toggleSettings();
      loadChapters();
    }
  };

  if (!job) return null;

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="relative min-h-screen flex flex-col overflow-hidden">
      {/* ambient background tinted to the book's accent */}
      <AmbientGlow color={job.accent} opacity={0.18} size={700} className="-top-40 left-1/2 -translate-x-1/2" />
      <AmbientGlow color="#92400e" opacity={0.12} size={500} className="bottom-0 right-0" />

      {/* ============ Top bar ============ */}
      <header className="relative z-20 flex items-center justify-between px-4 sm:px-8 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={closePlayer}
            className="flex items-center gap-2 text-sm text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] transition-colors group"
          >
            <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            <span className="hidden sm:inline">Back to library</span>
            <span className="sm:hidden">Library</span>
          </button>
          {/* Back to chat — secondary, exits the audiobook workspace entirely */}
          <button
            onClick={() => setActiveWorkspace("chat")}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors"
            style={{ color: "var(--aria-fg-dim)" }}
            title="Exit to chat"
          >
            <ArrowLeft size={13} />
            <span className="hidden sm:inline">Back to chat</span>
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2">
          <StatusPill className="!text-[10px]">
            <NowPlayingBars active={isPlaying} />
            {isPlaying ? "Now playing" : "Paused"}
          </StatusPill>
        </div>

        <div className="flex items-center gap-1">
          <SidePanelToggle kind="chapters" active={showChapters} icon={ListChecks} label="Chapters" onClick={toggleChapters} />
          <SidePanelToggle kind="settings" active={showSettings} icon={Settings2} label="Settings" />
        </div>
      </header>

      {/* ============ Main ============ */}
      <main className="relative z-10 flex-1 flex flex-col lg:flex-row gap-8 lg:gap-12 px-4 sm:px-8 pb-8 max-w-7xl w-full mx-auto">
        {/* Cover + visualizer */}
        <div className="flex flex-col items-center lg:items-start gap-5 lg:w-[42%]">
          <div className="relative w-full max-w-[280px] sm:max-w-[340px]">
            <div
              className={cn(
                "book-cover aspect-[3/5] relative",
                isPlaying && "animate-[aria-float-y_6s_ease-in-out_infinite]"
              )}
            >
              <BookCover
                title={job.title}
                accent={job.accent}
                className="absolute inset-0"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
            </div>

            {/* glow ring behind cover */}
            <div
              className="absolute -inset-3 -z-10 rounded-3xl blur-2xl opacity-40"
              style={{ background: `radial-gradient(circle, ${job.accent}, transparent 70%)` }}
            />
          </div>

          {/* Book meta */}
          <div className="text-center lg:text-left w-full">
            <h1 className="font-serif text-2xl sm:text-3xl leading-tight text-[var(--aria-fg)]">
              {job.title}
            </h1>
            <p className="text-sm text-[var(--aria-fg-muted)] mt-1">
              {job.author ? (
                <>
                  by <span className="text-[var(--aria-fg)]">{job.author}</span>
                </>
              ) : (
                <span className="italic">Author unknown</span>
              )}
            </p>
            <div className="flex items-center gap-3 mt-3 justify-center lg:justify-start text-[11px] text-[var(--aria-fg-dim)]">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {duration > 0 ? formatTime(duration) : "—"}
              </span>
              <span>Single MP3 · edge-tts</span>
            </div>
          </div>
        </div>

        {/* Player controls */}
        <div className="flex-1 flex flex-col justify-center gap-7 lg:py-6">
          {/* Now playing info */}
          <div>
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[var(--aria-accent-glow)] mb-1.5">
              Now playing
            </div>
            <h2 className="font-serif text-3xl sm:text-4xl leading-tight">
              {job.title}
            </h2>
            <p className="text-sm text-[var(--aria-fg-muted)] mt-2 leading-relaxed max-w-xl">
              {job.author ? `Narrated by edge-tts · ${job.author}` : "Narrated by edge-tts"}
            </p>
          </div>

          {/* Progress bar */}
          <ProgressBar
            current={currentTime}
            duration={duration}
            progressPct={progressPct}
            onSeek={seek}
          />

          {/* Transport controls */}
          <div className="flex items-center justify-center gap-2 sm:gap-4">
            <button
              onClick={() => skip(-15)}
              className="transport-btn w-12 h-12 relative"
              title="Back 15 seconds"
              aria-label="Back 15 seconds"
            >
              <Rewind className="w-5 h-5" />
              <span className="absolute -bottom-0.5 text-[8px] font-mono font-medium">15</span>
            </button>
            <button
              onClick={toggle}
              className="transport-btn transport-btn-lg"
              title={isPlaying ? "Pause" : "Play"}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-7 h-7 fill-current" />
              ) : (
                <Play className="w-7 h-7 fill-current ml-0.5" />
              )}
            </button>
            <button
              onClick={() => skip(15)}
              className="transport-btn w-12 h-12 relative"
              title="Forward 15 seconds"
              aria-label="Forward 15 seconds"
            >
              <FastForward className="w-5 h-5" />
              <span className="absolute -bottom-0.5 text-[8px] font-mono font-medium">15</span>
            </button>
          </div>

          {/* Secondary controls */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <SpeedControl rate={playbackRate} />
            <SleepTimerControl minutes={sleepTimerMinutes} />
            <VolumeControl volume={volume} muted={muted} />
          </div>
        </div>
      </main>

      {/* ============ Side panels ============ */}
      <SidePanel open={showChapters} side="right">
        <ChaptersPanel
          loading={chaptersLoading}
          chaptersData={chaptersData}
          passedChapters={job.chapters}
          passedSelected={job.selectedChapters ?? chaptersData?.selected_chapters}
          chapterMp3s={job.chapterMp3s ?? chaptersData?.chapter_mp3s}
          currentChapterIdx={currentChapterIdx}
          currentTime={currentTime}
          duration={duration}
          onSeek={seek}
          onSeekToChapter={seekToChapter}
          onClose={toggleChapters}
        />
      </SidePanel>
      <SidePanel open={showSettings} side="right">
        <SettingsPanel />
      </SidePanel>
    </div>
  );
}

/* ============ Sub-components ============ */

function SidePanelToggle({
  kind,
  active,
  icon: Icon,
  label,
  onClick,
}: {
  kind: "settings" | "chapters";
  active: boolean;
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
}) {
  const toggleSettings = usePlayerStore((s) => s.toggleSettings);
  const handleClick = onClick ?? toggleSettings;
  return (
    <button
      onClick={handleClick}
      className={cn(
        "w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center transition-all border",
        active
          ? "bg-[rgba(245,158,11,0.12)] border-[rgba(245,158,11,0.4)] text-[var(--aria-accent-glow)]"
          : "border-transparent text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:bg-[var(--aria-card)]"
      )}
      title={label}
      aria-label={label}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

function ProgressBar({
  current,
  duration,
  progressPct,
  onSeek,
}: {
  current: number;
  duration: number;
  progressPct: number;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const seekFromEvent = (clientX: number) => {
    const el = ref.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onSeek(ratio * duration);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => seekFromEvent(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, duration]);

  return (
    <div className="select-none">
      <div
        ref={ref}
        className="progress-track group"
        onMouseDown={(e) => {
          setDragging(true);
          seekFromEvent(e.clientX);
        }}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(current)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onSeek(current - 5);
          if (e.key === "ArrowRight") onSeek(current + 5);
        }}
      >
        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
        <div className="progress-thumb" style={{ left: `${progressPct}%` }} />
      </div>
      <div className="flex items-center justify-between mt-2 font-mono text-[11px] text-[var(--aria-fg-dim)]">
        <span>{formatTime(current)}</span>
        <span className="text-[var(--aria-fg-muted)]">
          -{formatTime(Math.max(0, duration - current))}
        </span>
      </div>
    </div>
  );
}

function SpeedControl({ rate }: { rate: number }) {
  const [open, setOpen] = useState(false);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const rates = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--aria-border)] text-xs text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:border-[rgba(245,158,11,0.3)] transition-colors"
      >
        <Gauge className="w-3.5 h-3.5" />
        {rate}×
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-bubble p-2 z-40 grid grid-cols-4 gap-1 w-[260px]">
            {rates.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setPlaybackRate(r);
                  setOpen(false);
                }}
                className={cn(
                  "px-2 py-1.5 rounded-lg text-xs font-mono transition-colors",
                  r === rate
                    ? "bg-[rgba(245,158,11,0.15)] text-[var(--aria-accent-glow)] border border-[rgba(245,158,11,0.3)]"
                    : "text-[var(--aria-fg-muted)] hover:text-[var(--aria-fg)] hover:bg-[var(--aria-card)] border border-transparent"
                )}
              >
                {r}×
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SleepTimerControl({ minutes }: { minutes: number | null }) {
  const [open, setOpen] = useState(false);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const [now, setNow] = useState(() => Date.now());
  const endsAt = usePlayerStore((s) => s.sleepTimerEndsAt);

  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [endsAt]);

  const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : null;

  const opts = [5, 10, 15, 30, 45, 60];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 rounded-full border text-xs transition-colors",
          minutes
            ? "border-[rgba(245,158,11,0.3)] text-[var(--aria-accent-glow)] bg-[rgba(245,158,11,0.08)]"
            : "border-[var(--aria-border)] text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:border-[rgba(245,158,11,0.3)]"
        )}
      >
        <Moon className="w-3.5 h-3.5" />
        {remaining !== null && minutes
          ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
          : "Sleep"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass-bubble p-2 z-40 w-[160px]">
            <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--aria-fg-dim)]">
              Sleep timer
            </div>
            {opts.map((m) => (
              <button
                key={m}
                onClick={() => {
                  setSleepTimer(m);
                  setOpen(false);
                }}
                className="block w-full text-left px-2 py-1.5 rounded-lg text-xs text-[var(--aria-fg-muted)] hover:text-[var(--aria-fg)] hover:bg-[var(--aria-card)] transition-colors"
              >
                {m} minutes
              </button>
            ))}
            {minutes && (
              <button
                onClick={() => {
                  setSleepTimer(null);
                  setOpen(false);
                }}
                className="block w-full text-left px-2 py-1.5 rounded-lg text-xs text-[var(--destructive)] hover:bg-[rgba(239,68,68,0.08)] transition-colors"
              >
                Turn off
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function VolumeControl({ volume, muted }: { volume: number; muted: boolean }) {
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={toggleMute}
        className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:bg-[var(--aria-card)] transition-colors"
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted || volume === 0 ? (
          <VolumeX className="w-4 h-4" />
        ) : (
          <Volume2 className="w-4 h-4" />
        )}
      </button>
      <div
        className={cn(
          "overflow-hidden transition-all duration-300",
          open ? "w-24 opacity-100" : "w-0 opacity-0"
        )}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-20 accent-[var(--aria-accent)]"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}

/* ============ Side panels ============ */

function SidePanel({
  open,
  side = "right",
  children,
}: {
  open: boolean;
  side?: "right" | "left";
  children: React.ReactNode;
}) {
  const toggleSettings = usePlayerStore((s) => s.toggleSettings);
  const close = () => {
    if (usePlayerStore.getState().showSettings) toggleSettings();
  };

  return (
    <>
      {/* backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={close}
      />
      <aside
        className={cn(
          "fixed top-0 bottom-0 z-50 w-full sm:w-[420px] bg-[var(--aria-bg-soft)] border-l border-[var(--aria-border)] shadow-[0_0_60px_rgba(0,0,0,0.6)] transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.2,1)] flex flex-col",
          side === "right" ? "right-0" : "left-0 border-l-0 border-r",
          open
            ? "translate-x-0"
            : side === "right"
              ? "translate-x-full"
              : "-translate-x-full"
        )}
      >
        {children}
      </aside>
    </>
  );
}

function PanelHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-5 border-b border-[var(--aria-border)]">
      <div>
        <h3 className="font-serif text-2xl text-[var(--aria-fg)]">{title}</h3>
        {subtitle && (
          <p className="text-xs text-[var(--aria-fg-dim)] mt-0.5">{subtitle}</p>
        )}
      </div>
      <button
        onClick={onClose}
        className="w-9 h-9 rounded-full flex items-center justify-center text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:bg-[var(--aria-card)] transition-colors"
        aria-label="Close panel"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function SettingsPanel() {
  const toggle = usePlayerStore((s) => s.toggleSettings);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const muted = usePlayerStore((s) => s.muted);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  return (
    <>
      <PanelHeader title="Settings" subtitle="Tune your listening" onClose={toggle} />
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-7">
        {/* Speed */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm text-[var(--aria-fg)] flex items-center gap-2">
              <Gauge className="w-4 h-4 text-[var(--aria-accent)]" />
              Playback speed
            </label>
            <span className="font-mono text-sm text-[var(--aria-accent-glow)]">{playbackRate}×</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
            className="w-full accent-[var(--aria-accent)]"
          />
          <div className="flex justify-between mt-1 font-mono text-[10px] text-[var(--aria-fg-dim)]">
            <span>0.5×</span>
            <span>1×</span>
            <span>2×</span>
          </div>
        </div>

        {/* Volume */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm text-[var(--aria-fg)] flex items-center gap-2">
              {muted ? <VolumeX className="w-4 h-4 text-[var(--aria-accent)]" /> : <Volume2 className="w-4 h-4 text-[var(--aria-accent)]" />}
              Volume
            </label>
            <button
              onClick={toggleMute}
              className="font-mono text-xs text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)]"
            >
              {muted ? "unmute" : "mute"}
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-full accent-[var(--aria-accent)]"
          />
        </div>

        <AriaDivider />

        {/* Keyboard shortcuts */}
        <div>
          <h4 className="font-mono text-[11px] uppercase tracking-[0.15em] text-[var(--aria-fg-dim)] mb-3">
            Keyboard shortcuts
          </h4>
          <div className="space-y-2">
            {[
              ["Space", "Play / pause"],
              ["← / →", "Seek -5s / +5s"],
              ["J / L", "Skip -15s / +15s"],
              ["M", "Mute / unmute"],
              ["Esc", "Back to library"],
            ].map(([k, d]) => (
              <div key={k} className="flex items-center justify-between text-xs">
                <span className="text-[var(--aria-fg-muted)]">{d}</span>
                <kbd className="font-mono text-[10px] px-2 py-1 rounded-md bg-[var(--aria-card)] border border-[var(--aria-border)] text-[var(--aria-fg)]">
                  {k}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============ Chapters browser panel ============ */

function ChaptersPanel({
  loading,
  chaptersData,
  passedChapters,
  passedSelected,
  chapterMp3s,
  currentChapterIdx,
  currentTime,
  duration,
  onSeek,
  onSeekToChapter,
  onClose,
}: {
  loading: boolean;
  chaptersData: AnalyzeResponse | null;
  passedChapters?: { index: number; title: string; chars: number; estimated_minutes: number }[];
  passedSelected?: number[];
  chapterMp3s?: ChapterMp3Info[];
  currentChapterIdx: number;
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
  onSeekToChapter: (idx: number) => void;
  onClose: () => void;
}) {
  const chapters = chaptersData?.chapters ?? passedChapters ?? [];
  const selectedSet = new Set(
    chaptersData?.selected_chapters ?? passedSelected ?? []
  );
  const totalChapters = chaptersData?.total_chapters ?? chapters.length;
  const inAudioCount = selectedSet.size;
  const hasChapterMp3s = !!chapterMp3s && chapterMp3s.length > 0;

  // When chapterMp3s is available, use exact durations. Otherwise fall back
  // to proportional estimates from char counts (backward compat).
  const audioChapters = hasChapterMp3s
    ? chapterMp3s!
    : selectedSet.size > 0
      ? chapters.filter((c) => selectedSet.has(c.index))
      : chapters;

  const chapterStarts = hasChapterMp3s
    ? chapterMp3s!.map((_, i) =>
        chapterMp3s!.slice(0, i).reduce((s, ch) => s + (ch.duration_ms || 0), 0) / 1000
      )
    : (() => {
        const totalAudioChars = audioChapters.reduce((sum, c) => sum + ((c as any).chars || 0), 0);
        let cum = 0;
        return audioChapters.map((ch) => {
          const t = totalAudioChars > 0 && duration > 0 ? (cum / totalAudioChars) * duration : 0;
          cum += (ch as any).chars || 0;
          return t;
        });
      })();

  // Use currentChapterIdx from the store when available (exact, no computation
  // needed). Fall back to computing from currentTime for backward compat.
  const activeIdx = currentChapterIdx >= 0
    ? currentChapterIdx
    : (() => {
        if (duration <= 0 || chapterStarts.length === 0) return -1;
        for (let i = chapterStarts.length - 1; i >= 0; i--) {
          if (currentTime >= chapterStarts[i]) return i;
        }
        return -1;
      })();

  const handleChapterClick = (audioIdx: number) => {
    if (hasChapterMp3s) {
      // Per-chapter mode: directly switch to the chapter
      onSeekToChapter(audioIdx);
    } else if (chapterStarts[audioIdx] !== undefined) {
      // Single-file mode: seek to the estimated position
      onSeek(chapterStarts[audioIdx]);
    }
  };

  const handlePrevChapter = () => {
    if (activeIdx > 0) {
      handleChapterClick(activeIdx - 1);
    } else if (activeIdx === 0) {
      onSeek(0);
    }
  };
  const handleNextChapter = () => {
    if (activeIdx >= 0 && activeIdx < chapterStarts.length - 1) {
      handleChapterClick(activeIdx + 1);
    }
  };

  return (
    <>
      <PanelHeader
        title="Chapters"
        subtitle={
          inAudioCount > 0
            ? `${inAudioCount} of ${totalChapters} in this audiobook`
            : `${totalChapters} chapters`
        }
        onClose={onClose}
      />
      {audioChapters.length > 1 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--aria-border)]">
          <button
            onClick={handlePrevChapter}
            disabled={activeIdx <= 0}
            className="flex-1 text-xs py-1.5 rounded-md transition-colors disabled:opacity-40"
            style={{ border: "1px solid var(--aria-border)", color: "var(--aria-fg-muted)" }}
          >
            ← Prev chapter
          </button>
          <button
            onClick={handleNextChapter}
            disabled={activeIdx >= chapterStarts.length - 1}
            className="flex-1 text-xs py-1.5 rounded-md transition-colors disabled:opacity-40"
            style={{ border: "1px solid var(--aria-border)", color: "var(--aria-fg-muted)" }}
          >
            Next chapter →
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1">
        {loading ? (
          <div className="text-center py-8 text-[var(--aria-fg-muted)] text-sm">Loading chapters…</div>
        ) : chapters.length === 0 ? (
          <div className="text-center py-8 text-[var(--aria-fg-muted)] text-sm">
            Chapter data unavailable. The job may have expired (18h retention) — re-upload the EPUB to browse chapters.
          </div>
        ) : (
          chapters.map((ch, idx) => {
            const inAudio = selectedSet.size === 0 || selectedSet.has(ch.index);
            const audioIdx = audioChapters.findIndex((c) =>
              hasChapterMp3s
                ? (c as ChapterMp3Info).index === ch.index
                : c.index === ch.index
            );
            const isCurrent = audioIdx === activeIdx;
            const chapterTime = audioIdx >= 0 ? chapterStarts[audioIdx] : undefined;

            return (
              <button
                key={ch.index}
                onClick={() => audioIdx >= 0 && handleChapterClick(audioIdx)}
                disabled={!inAudio}
                className="w-full flex items-start gap-2.5 p-2.5 rounded-lg transition-colors text-left disabled:cursor-not-allowed"
                style={{
                  background: isCurrent ? "rgba(245,158,11,0.1)" : inAudio ? "rgba(34,197,94,0.04)" : "transparent",
                  border: isCurrent ? "1px solid rgba(245,158,11,0.3)" : inAudio ? "1px solid rgba(34,197,94,0.15)" : "1px solid transparent",
                  cursor: inAudio ? "pointer" : "default",
                }}
              >
                <div className="flex items-center justify-center flex-shrink-0 mt-0.5">
                  {inAudio ? (
                    isCurrent ? (
                      <div className="w-4 h-4 rounded flex items-center justify-center" style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.5)" }}>
                        <Play size={9} className="fill-current text-[var(--aria-accent-glow)]" />
                      </div>
                    ) : (
                      <div className="w-4 h-4 rounded flex items-center justify-center" style={{ background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)" }}>
                        <Check size={10} className="text-green-400" />
                      </div>
                    )
                  ) : (
                    <span className="text-[10px] font-mono w-4 text-center" style={{ color: "var(--aria-fg-dim)" }}>
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {inAudio && (
                      <span className="text-[10px] font-mono w-4 text-center" style={{ color: "var(--aria-fg-dim)" }}>
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                    )}
                    <span className="text-sm font-medium truncate" style={{ color: isCurrent ? "var(--aria-accent-glow)" : inAudio ? "var(--aria-fg)" : "var(--aria-fg-muted)" }}>
                      {ch.title || `Chapter ${ch.index + 1}`}
                    </span>
                  </div>
                  <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: "var(--aria-fg-dim)" }}>
                    <span>
                      {(ch.chars || 0).toLocaleString()} chars · ~{ch.estimated_minutes || Math.max(1, Math.round((ch.chars || 0) / 750))} min
                    </span>
                    {isCurrent && <span style={{ color: "var(--aria-accent-glow)" }}>· playing</span>}
                    {!inAudio && <span>· not narrated</span>}
                    {chapterTime !== undefined && inAudio && !isCurrent && <span>· {formatTime(chapterTime)}</span>}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
      {inAudioCount > 0 && (
        <div className="px-4 py-3 border-t text-[11px]" style={{ borderColor: "var(--aria-border)", color: "var(--aria-fg-muted)" }}>
          <span style={{ color: "#22c55e" }}>✓ {inAudioCount}</span> of {totalChapters} chapters narrated.
          Click any chapter to jump there. Use &quot;More chapters&quot; in the library to narrate the rest.
        </div>
      )}
    </>
  );
}
