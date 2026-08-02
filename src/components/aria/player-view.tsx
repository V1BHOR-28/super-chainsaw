"use client";

import { useState, useRef, useEffect } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  ChevronLeft,
  ListMusic,
  Bookmark,
  BookmarkCheck,
  Settings2,
  Gauge,
  Moon,
  Volume2,
  VolumeX,
  X,
  Plus,
  Trash2,
  Clock,
  Star,
  CheckCircle2,
  Headphones,
} from "lucide-react";
import { useAudioEngine } from "@/hooks/use-audio-engine";
import { usePlayerStore } from "@/lib/player-store";
import { BOOKS, formatTime, formatDuration } from "@/lib/audiobooks";
import { cn } from "@/lib/utils";
import { AmbientGlow, GradientText, StatusPill, AriaDivider } from "./primitives";
import { DecorativeWaveform, NowPlayingBars } from "./waveform";
import { BookCover } from "./book-cover";
import { toast } from "@/hooks/use-toast";

export function PlayerView() {
  // drive the audio engine
  useAudioEngine();

  const book = usePlayerStore((s) => (s.currentBookId ? BOOKS.find((b) => b.id === s.currentBookId) : undefined));
  const chapterIndex = usePlayerStore((s) => s.chapterIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const showChapterList = usePlayerStore((s) => s.showChapterList);
  const showBookmarks = usePlayerStore((s) => s.showBookmarks);
  const showSettings = usePlayerStore((s) => s.showSettings);
  const sleepTimerMinutes = usePlayerStore((s) => s.sleepTimerMinutes);

  const toggle = usePlayerStore((s) => s.toggle);
  const skip = usePlayerStore((s) => s.skip);
  const seek = usePlayerStore((s) => s.seek);
  const nextChapter = usePlayerStore((s) => s.nextChapter);
  const prevChapter = usePlayerStore((s) => s.prevChapter);
  const closePlayer = usePlayerStore((s) => s.closePlayer);

  if (!book) return null;
  const chapter = book.chapters[chapterIndex];
  if (!chapter) return null;

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="relative min-h-screen flex flex-col overflow-hidden">
      {/* ambient background tinted to the book's accent */}
      <AmbientGlow color={book.accent} opacity={0.18} size={700} className="-top-40 left-1/2 -translate-x-1/2" />
      <AmbientGlow color="#92400e" opacity={0.12} size={500} className="bottom-0 right-0" />

      {/* ============ Top bar ============ */}
      <header className="relative z-20 flex items-center justify-between px-4 sm:px-8 pt-6 pb-4">
        <button
          onClick={closePlayer}
          className="flex items-center gap-2 text-sm text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] transition-colors group"
        >
          <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          <span className="hidden sm:inline">Back to library</span>
          <span className="sm:hidden">Library</span>
        </button>

        <div className="flex items-center gap-2">
          <StatusPill className="!text-[10px]">
            <NowPlayingBars active={isPlaying} />
            {isPlaying ? "Now playing" : "Paused"}
          </StatusPill>
        </div>

        <div className="flex items-center gap-1">
          <SidePanelToggle kind="chapterList" active={showChapterList} icon={ListMusic} label="Chapters" />
          <SidePanelToggle kind="bookmarks" active={showBookmarks} icon={Bookmark} label="Bookmarks" />
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
                book={book}
                className="absolute inset-0"
                imgClassName="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

              {/* now playing badge */}
              <div className="absolute top-3 left-3 status-pill !py-1 !px-2.5 !text-[9px]">
                <span className="status-dot" />
                {isPlaying ? "Playing" : "Paused"}
              </div>

              {/* visualizer overlay at bottom */}
              {isPlaying && (
                <div className="absolute bottom-3 left-3 right-3">
                  <DecorativeWaveform bars={40} active height={28} />
                </div>
              )}
            </div>

            {/* glow ring behind cover */}
            <div
              className="absolute -inset-3 -z-10 rounded-3xl blur-2xl opacity-40"
              style={{ background: `radial-gradient(circle, ${book.accent}, transparent 70%)` }}
            />
          </div>

          {/* Book meta */}
          <div className="text-center lg:text-left w-full">
            <div className="flex items-center justify-center lg:justify-start gap-2 mb-2">
              {book.genres.map((g) => (
                <span key={g} className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--aria-fg-dim)]">
                  {g}
                </span>
              ))}
            </div>
            <h1 className="font-serif text-2xl sm:text-3xl leading-tight text-[var(--aria-fg)]">
              {book.title}
            </h1>
            <p className="text-sm text-[var(--aria-fg-muted)] mt-1">
              by <span className="text-[var(--aria-fg)]">{book.author}</span>
            </p>
            <p className="text-xs text-[var(--aria-fg-dim)] mt-1 flex items-center gap-1.5 justify-center lg:justify-start">
              <Headphones className="w-3.5 h-3.5" />
              Narrated by {book.narrator}
            </p>
            <div className="flex items-center gap-3 mt-3 justify-center lg:justify-start text-[11px] text-[var(--aria-fg-dim)]">
              <span className="flex items-center gap-1">
                <Star className="w-3 h-3 fill-[var(--aria-accent)] text-[var(--aria-accent)]" />
                {book.rating}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDuration(book.totalDuration)}
              </span>
              <span>{book.chapters.length} chapters</span>
            </div>
          </div>
        </div>

        {/* Player controls */}
        <div className="flex-1 flex flex-col justify-center gap-7 lg:py-6">
          {/* Chapter info */}
          <div>
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[var(--aria-accent-glow)] mb-1.5">
              Chapter {chapterIndex + 1} of {book.chapters.length}
            </div>
            <h2 className="font-serif text-3xl sm:text-4xl leading-tight">
              {chapter.title}
            </h2>
            <p className="text-sm text-[var(--aria-fg-muted)] mt-2 leading-relaxed max-w-xl">
              {chapter.summary}
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
              onClick={() => prevChapter()}
              className="transport-btn w-11 h-11"
              title="Previous chapter"
              aria-label="Previous chapter"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
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
              onClick={() => skip(30)}
              className="transport-btn w-12 h-12 relative"
              title="Forward 30 seconds"
              aria-label="Forward 30 seconds"
            >
              <FastForward className="w-5 h-5" />
              <span className="absolute -bottom-0.5 text-[8px] font-mono font-medium">30</span>
            </button>
            <button
              onClick={() => nextChapter()}
              className="transport-btn w-11 h-11"
              title="Next chapter"
              aria-label="Next chapter"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
          </div>

          {/* Secondary controls */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <SpeedControl rate={playbackRate} />
            <SleepTimerControl minutes={sleepTimerMinutes} />
            <BookmarkButton bookId={book.id} chapterIndex={chapterIndex} time={currentTime} />
            <VolumeControl volume={volume} muted={muted} />
          </div>

          {/* decorative waveform strip */}
          <div className="hidden sm:block opacity-50 mt-2">
            <DecorativeWaveform bars={80} active={isPlaying} height={36} />
          </div>
        </div>
      </main>

      {/* ============ Side panels ============ */}
      <SidePanel open={showChapterList} side="right">
        <ChapterListPanel />
      </SidePanel>
      <SidePanel open={showBookmarks} side="right">
        <BookmarksPanel />
      </SidePanel>
      <SidePanel open={showSettings} side="right">
        <SettingsPanel />
      </SidePanel>

      {/* ============ Mini player on mobile when scrolled (simple) ============ */}
    </div>
  );
}

/* ============ Sub-components ============ */

function SidePanelToggle({
  kind,
  active,
  icon: Icon,
  label,
}: {
  kind: "chapterList" | "bookmarks" | "settings";
  active: boolean;
  icon: React.ElementType;
  label: string;
}) {
  const toggle = usePlayerStore((s) =>
    kind === "chapterList"
      ? s.toggleChapterList
      : kind === "bookmarks"
        ? s.toggleBookmarks
        : s.toggleSettings
  );
  return (
    <button
      onClick={toggle}
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

function BookmarkButton({
  bookId,
  chapterIndex,
  time,
}: {
  bookId: string;
  chapterIndex: number;
  time: number;
}) {
  const bookmarks = usePlayerStore((s) => s.bookmarks);
  const addBookmark = usePlayerStore((s) => s.addBookmark);

  const existing = bookmarks.find(
    (b) => b.bookId === bookId && b.chapterIndex === chapterIndex && Math.abs(b.time - time) < 3
  );

  return (
    <button
      onClick={() => {
        if (existing) return;
        addBookmark();
        toast({
          title: "Bookmark added",
          description: `Saved at ${formatTime(time)}`,
        });
      }}
      disabled={!!existing}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 rounded-full border text-xs transition-colors",
        existing
          ? "border-[rgba(245,158,11,0.3)] text-[var(--aria-accent-glow)] bg-[rgba(245,158,11,0.08)]"
          : "border-[var(--aria-border)] text-[var(--aria-fg-muted)] hover:text-[var(--aria-accent-glow)] hover:border-[rgba(245,158,11,0.3)]"
      )}
      title={existing ? "Bookmarked here" : "Add bookmark"}
    >
      {existing ? <BookmarkCheck className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
      {existing ? "Saved" : "Bookmark"}
    </button>
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
  const toggleChapterList = usePlayerStore((s) => s.toggleChapterList);
  const toggleBookmarks = usePlayerStore((s) => s.toggleBookmarks);
  const toggleSettings = usePlayerStore((s) => s.toggleSettings);
  const close = () => {
    if (usePlayerStore.getState().showChapterList) toggleChapterList();
    if (usePlayerStore.getState().showBookmarks) toggleBookmarks();
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

function ChapterListPanel() {
  const toggle = usePlayerStore((s) => s.toggleChapterList);
  const book = usePlayerStore((s) => (s.currentBookId ? BOOKS.find((b) => b.id === s.currentBookId) : undefined));
  const chapterIndex = usePlayerStore((s) => s.chapterIndex);
  const goToChapter = usePlayerStore((s) => s.goToChapter);
  const progress = usePlayerStore((s) => s.progress);
  const completed = book ? progress[book.id]?.completedChapters ?? [] : [];

  if (!book) return null;

  return (
    <>
      <PanelHeader
        title="Chapters"
        subtitle={`${book.chapters.length} chapters · ${formatDuration(book.totalDuration)}`}
        onClose={toggle}
      />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {book.chapters.map((ch, i) => {
          const active = i === chapterIndex;
          const done = completed.includes(ch.id);
          return (
            <button
              key={ch.id}
              onClick={() => {
                goToChapter(i);
                toggle();
              }}
              className={cn("chapter-item w-full text-left mb-1", active && "active")}
            >
              <div
                className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 font-mono text-xs border transition-colors",
                  active
                    ? "bg-[rgba(245,158,11,0.15)] border-[rgba(245,158,11,0.3)] text-[var(--aria-accent-glow)]"
                    : done
                      ? "bg-[rgba(245,158,11,0.05)] border-[rgba(245,158,11,0.15)] text-[var(--aria-accent)]"
                      : "bg-[var(--aria-card)] border-[var(--aria-border)] text-[var(--aria-fg-dim)]"
                )}
              >
                {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm truncate",
                      active ? "text-[var(--aria-accent-glow)]" : "text-[var(--aria-fg)]"
                    )}
                  >
                    {ch.title}
                  </span>
                  {active && <NowPlayingBars active />}
                </div>
                <p className="text-xs text-[var(--aria-fg-muted)] truncate mt-0.5">{ch.summary}</p>
              </div>
              <span className="font-mono text-[10px] text-[var(--aria-fg-dim)] shrink-0">
                {formatTime(ch.duration)}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function BookmarksPanel() {
  const toggle = usePlayerStore((s) => s.toggleBookmarks);
  const bookmarks = usePlayerStore((s) => s.bookmarks);
  const removeBookmark = usePlayerStore((s) => s.removeBookmark);
  const jumpToBookmark = usePlayerStore((s) => s.jumpToBookmark);
  const addBookmark = usePlayerStore((s) => s.addBookmark);
  const currentBookId = usePlayerStore((s) => s.currentBookId);

  const bookMarks = bookmarks.filter((b) => b.bookId === currentBookId);
  const allMarks = bookmarks;

  return (
    <>
      <PanelHeader
        title="Bookmarks"
        subtitle={`${bookMarks.length} in this book · ${allMarks.length} total`}
        onClose={toggle}
      />
      <div className="px-5 py-3 border-b border-[var(--aria-border)]">
        <button
          onClick={() => {
            addBookmark();
            toast({ title: "Bookmark added", description: "Saved at current position" });
          }}
          className="btn-ghost w-full !py-2.5 !text-xs justify-center"
        >
          <Plus className="w-3.5 h-3.5" />
          Add bookmark at current position
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {bookMarks.length === 0 ? (
          <div className="text-center py-12 px-6">
            <Bookmark className="w-8 h-8 mx-auto text-[var(--aria-fg-dim)] mb-3" />
            <p className="text-sm text-[var(--aria-fg-muted)]">
              No bookmarks in this book yet.
            </p>
            <p className="text-xs text-[var(--aria-fg-dim)] mt-1">
              Tap a passage, mark it, come back.
            </p>
          </div>
        ) : (
          bookMarks.map((b) => {
            const book = BOOKS.find((bk) => bk.id === b.bookId);
            const ch = book?.chapters[b.chapterIndex];
            return (
              <div
                key={b.id}
                className="chapter-item w-full text-left mb-1 group"
                onClick={() => {
                  jumpToBookmark(b);
                  toggle();
                }}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.2)] text-[var(--aria-accent-glow)]">
                  <Bookmark className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[var(--aria-fg)] truncate">{b.note}</div>
                  <div className="text-xs text-[var(--aria-fg-dim)] mt-0.5 truncate">
                    {ch?.title} · {formatTime(b.time)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBookmark(b.id);
                  }}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[var(--aria-fg-dim)] hover:text-[var(--destructive)] hover:bg-[rgba(239,68,68,0.08)] transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Remove bookmark"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
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
  const [autoResume, setAutoResume] = useState(true);
  const [skipSilence, setSkipSilence] = useState(false);

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

        {/* Toggles */}
        <ToggleRow
          label="Auto-resume"
          desc="Continue from where you left off"
          checked={autoResume}
          onChange={setAutoResume}
        />
        <ToggleRow
          label="Skip silence"
          desc="Jump past long pauses in narration"
          checked={skipSilence}
          onChange={setSkipSilence}
        />

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
              ["J / L", "Skip -15s / +30s"],
              ["↑ / ↓", "Next / prev chapter"],
              ["M", "Mute / unmute"],
              ["B", "Add bookmark"],
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

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm text-[var(--aria-fg)]">{label}</div>
        <div className="text-xs text-[var(--aria-fg-muted)] mt-0.5">{desc}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          "relative w-11 h-6 rounded-full transition-colors shrink-0",
          checked ? "bg-[var(--aria-accent)]" : "bg-[var(--aria-card)] border border-[var(--aria-border)]"
        )}
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span
          className={cn(
            "absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-[var(--aria-fg)] transition-transform",
            checked ? "left-6" : "left-1"
          )}
        />
      </button>
    </div>
  );
}
