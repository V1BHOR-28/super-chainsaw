"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useCallback } from "react";
import { Loader2, FileQuestion, Minus, Plus, Locate, Volume2, X, Sparkles } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import {
  useTranscriptStore,
  useTranscriptEntry,
} from "@/lib/transcript-store";
import { useWordSync, getSyncOffset, setSyncOffset } from "@/hooks/use-word-sync";
import { getAudioElement } from "@/lib/audio-element-registry";
import { getGlossaryEntry, explainParagraph, type HindiGlossary } from "@/lib/abm-api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function TranscriptView() {
  const job = usePlayerStore((s) => s.currentJob);
  const currentChapterIdx = usePlayerStore((s) => s.currentChapterIdx);
  const seek = usePlayerStore((s) => s.seek);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const hindiHelp = usePlayerStore((s) => s.hindiHelp);
  const pause = usePlayerStore((s) => s.pause);
  const fetchTranscript = useTranscriptStore((s) => s.fetchTranscript);

  // ── Glossary state ──
  const [glossary, setGlossary] = useState<{ word: string; result: HindiGlossary | null; loading: boolean; x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  // ── Explain state ──
  const [explainState, setExplainState] = useState<{ paragraphIdx: number; result: HindiGlossary | null; loading: boolean } | null>(null);
  const explainAudioRef = useRef<HTMLAudioElement | null>(null);

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

  // ── Follow playback state ──
  const [followPlayback, setFollowPlayback] = useState(true);
  const followRef = useRef(true);
  const activeWordIdxRef = useRef(-1);

  useEffect(() => { followRef.current = followPlayback; }, [followPlayback]);
  useEffect(() => { activeWordIdxRef.current = activeWordIdx; }, [activeWordIdx]);

  // Reset follow on chapter change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing: reset follow state when the chapter changes (legitimate sync, not a derived-state cascade)
    setFollowPlayback(true);
  }, [currentChapterIdx]);

  // ── Auto-scroll ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef<number>(0);
  const reducedMotion = usePrefersReducedMotion();

  // Center a word in the scroll container (direct scrollTo, never scrollIntoView)
  const centerWord = useCallback(
    (idx: number) => {
      const el = scrollRef.current;
      if (!el || idx < 0) return;
      const node = el.querySelector<HTMLElement>(`[data-cue-index="${idx}"]`);
      if (!node) return;
      const target =
        node.offsetTop - el.clientHeight / 2 + node.offsetHeight / 2;
      const clamped = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
      programmaticScrollRef.current = performance.now();
      el.scrollTo({
        top: clamped,
        behavior: reducedMotion ? "auto" : "smooth",
      });
    },
    [reducedMotion],
  );

  // ── Click-to-seek ──
  const handleWordClick = useCallback(
    (cueIdx: number) => {
      if (!cues || cueIdx < 0 || cueIdx >= cues.length) return;
      const startMs = cues[cueIdx][0];
      const audio = getAudioElement();

      if (audio) {
        audio.currentTime = startMs / 1000;
        const absSec = chapterStartSec + startMs / 1000;
        setCurrentTime(absSec);
      } else {
        const absSec = chapterStartSec + startMs / 1000;
        seek(absSec);
      }

      // Resume follow mode and center the clicked word
      followRef.current = true;
      setFollowPlayback(true);
      requestAnimationFrame(() => {
        centerWord(cueIdx);
      });
    },
    [cues, chapterStartSec, seek, setCurrentTime, centerWord],
  );

  // When the active word changes and follow is enabled, center it
  useEffect(() => {
    if (!followRef.current || activeWordIdx < 0) return;
    centerWord(activeWordIdx);
  }, [activeWordIdx, centerWord]);

  // ── User scroll detection ──
  // Detect ALL forms of manual interaction: wheel, touch, pointer, keyboard.
  // Programmatic scrollTo() is ignored via programmaticScrollRef.
  // CRITICAL: deps include `cues` and `words` so the effect re-runs when the
  // scroll container appears (it only renders after cues load). Without this,
  // the effect runs on mount when scrollRef.current is null → listeners never
  // attach → user scrolls are invisible → follow never disables.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isProgrammatic = () =>
      performance.now() - programmaticScrollRef.current < 1000;

    const onScroll = () => {
      if (isProgrammatic()) return;
      if (followRef.current) {
        followRef.current = false;
        setFollowPlayback(false);
      }
    };

    const onWheel = () => {
      if (followRef.current) {
        followRef.current = false;
        setFollowPlayback(false);
      }
    };

    const onTouchMove = () => {
      if (followRef.current) {
        followRef.current = false;
        setFollowPlayback(false);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      // Click on scrollbar (right 16px) or anywhere in the container
      if (followRef.current) {
        followRef.current = false;
        setFollowPlayback(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const scrollKeys = [
        "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ",
      ];
      if (scrollKeys.includes(e.key) && followRef.current) {
        const active = document.activeElement;
        if (el === active || el.contains(active)) {
          followRef.current = false;
          setFollowPlayback(false);
        }
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("keydown", onKeyDown, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [cues, words]);

  // ── Return to current word ──
  const handleReturnToWord = useCallback(() => {
    followRef.current = true;
    setFollowPlayback(true);
    requestAnimationFrame(() => {
      centerWord(activeWordIdxRef.current);
    });
  }, [centerWord]);

  // ── Glossary: long-press / right-click handler ──
  const handleGlossaryRequest = useCallback(async (word: string, contextWords: string[], clientX: number, clientY: number) => {
    if (!jobId) return;
    const context = contextWords.join(" ");
    setGlossary({ word, result: null, loading: true, x: clientX, y: clientY });
    try {
      const result = await getGlossaryEntry(jobId, word, context);
      setGlossary({ word, result, loading: false, x: clientX, y: clientY });
    } catch {
      toast.error("अभी उपलब्ध नहीं है, बाद में कोशिश करें");
      setGlossary(null);
    }
  }, [jobId]);

  const handleWordContextMenu = useCallback((e: React.MouseEvent, word: string, idx: number) => {
    if (!hindiHelp || !words) return;
    e.preventDefault();
    const start = Math.max(0, idx - 7);
    const end = Math.min(words.length, idx + 8);
    handleGlossaryRequest(word, words.slice(start, end), e.clientX, e.clientY);
  }, [hindiHelp, words, handleGlossaryRequest]);

  const handleWordTouchStart = useCallback((e: React.TouchEvent, word: string, idx: number) => {
    if (!hindiHelp || !words) return;
    const touch = e.touches[0];
    longPressStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      if (!longPressStartRef.current || !words) return;
      const start = Math.max(0, idx - 7);
      const end = Math.min(words.length, idx + 8);
      handleGlossaryRequest(word, words.slice(start, end), longPressStartRef.current.x, longPressStartRef.current.y);
    }, 500);
  }, [hindiHelp, words, handleGlossaryRequest]);

  const handleWordTouchMove = useCallback((e: React.TouchEvent) => {
    if (!longPressStartRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - longPressStartRef.current.x);
    const dy = Math.abs(touch.clientY - longPressStartRef.current.y);
    if (dx > 10 || dy > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const handleWordTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // ── Explain: paragraph explain handler ──
  const handleExplain = useCallback(async (paragraphText: string, paraIdx: number) => {
    if (!jobId || chapterIndex < 0) return;
    // Pause main audio
    const mainAudio = getAudioElement();
    if (mainAudio && !mainAudio.paused) { mainAudio.pause(); }
    pause();
    setExplainState({ paragraphIdx: paraIdx, result: null, loading: true });
    try {
      const result = await explainParagraph(jobId, chapterIndex, paragraphText);
      setExplainState({ paragraphIdx: paraIdx, result, loading: false });
    } catch (err) {
      console.error("[explain] fetch failed", err);
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : "";
      if (code === "rate_limited" || code === "groq_rate_limited") {
        toast.error("थोड़ी देर रुकें — बहुत सारे अनुरोध");
      } else {
        toast.error(msg || "अभी उपलब्ध नहीं है, बाद में कोशिश करें");
      }
      setExplainState(null);
    }
  }, [jobId, chapterIndex, pause]);

  const playExplainAudio = useCallback(() => {
    if (!explainState?.result?.audio_url) return;
    const mainAudio = getAudioElement();
    if (mainAudio && !mainAudio.paused) { mainAudio.pause(); }
    // Destroy + rebuild the audio element whenever the URL differs — so a
    // second explain on a different paragraph can't replay the first one's
    // audio. Matches the summary card's element lifecycle.
    const url = explainState.result.audio_url;
    const prev = explainAudioRef.current;
    if (prev) {
      if (prev.src !== url) {
        prev.pause();
        prev.removeAttribute("src");
        prev.load();
        explainAudioRef.current = new Audio(url);
      }
    } else {
      explainAudioRef.current = new Audio(url);
    }
    const audio = explainAudioRef.current;
    if (!audio) return;
    audio.play().catch((err) => {
      console.error("[explain] audio play failed", err);
    });
  }, [explainState]);

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
  // ── ARIA: paragraph breaks for the "हिंदी में समझाओ" explain button ──
  // The Hinglish/edge-tts word cues contain NO sentence punctuation (bare
  // tokens like "karta", "hai", "Phir"), so the old punctuation-only strategy
  // produced zero breaks and the explain button was unreachable dead code.
  // This punctuation-first + length-fallback strategy yields a break every
  // 55–110 words regardless of punctuation, preferring real sentence ends
  // when the source has them.
  //
  // CRITICAL: paragraph breaks must fall on a word boundary from the timing
  // data, never inside a token. The explain control is rendered as its OWN
  // sibling block AFTER each paragraph's closing element — never inside the
  // words array, never between two words of the same paragraph. The words
  // array used for highlight sync contains ONLY transcript words.
  const paragraphBreaks: number[] = [];
  if (hindiHelp && words && words.length > 0) {
    const PARA_MIN = 55;  // don't break sooner than this
    const PARA_MAX = 110; // force a break by this
    let sinceBreak = 0;
    for (let i = 0; i < words.length - 1; i++) {
      sinceBreak++;
      const w = words[i];
      const punctuated = /[.!?।]$/.test(w);
      if ((punctuated && sinceBreak >= PARA_MIN) || sinceBreak >= PARA_MAX) {
        paragraphBreaks.push(i + 1);
        sinceBreak = 0;
      }
    }
  }

  // Build paragraph segments: [{startIdx, endIdx}] from the breaks.
  // Each segment is rendered as its own <p> with the explain button as a
  // sibling <div> AFTER it. This keeps the words array pure (only transcript
  // words) so highlight indices stay aligned with the audio.
  const segments: { startIdx: number; endIdx: number }[] = [];
  if (words && words.length > 0) {
    let segStart = 0;
    for (const br of paragraphBreaks) {
      segments.push({ startIdx: segStart, endIdx: br });
      segStart = br;
    }
    // Trailing segment (from last break to end)
    if (segStart < words.length) {
      segments.push({ startIdx: segStart, endIdx: words.length });
    }
  }

  return (
    <TranscriptFrame syncOffset={syncOffset} onAdjustOffset={adjustOffset}>
      <div className="relative">
        <div
          ref={scrollRef}
          tabIndex={0}
          className="transcript-scroll relative px-5 py-5 max-h-[55vh] overflow-y-auto overscroll-contain outline-none"
        >
          {/* Render each paragraph segment as its own <p>, with the explain
              control as a sibling <div> AFTER the closing </p>. The explain
              button is NEVER inside the words array — it's a separate block
              element, so its label text can never leak into the word stream. */}
          {segments.map((seg, segIdx) => (
            <div key={segIdx} className={segIdx > 0 ? "mt-3" : ""}>
              <p className="font-serif text-base sm:text-[17px] leading-[2] m-0">
                {words.slice(seg.startIdx, seg.endIdx).map((word, j) => {
                  const i = seg.startIdx + j;
                  const isActive = i === activeWordIdx;
                  const isPast = i < activeWordIdx;
                  return (
                    <span
                      key={i}
                      data-cue-index={i}
                      onClick={() => handleWordClick(i)}
                      onContextMenu={(e) => handleWordContextMenu(e, word, i)}
                      onTouchStart={(e) => handleWordTouchStart(e, word, i)}
                      onTouchMove={handleWordTouchMove}
                      onTouchEnd={handleWordTouchEnd}
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
              {/* Explain control — sibling block AFTER the paragraph's closing
                  </p>. Never inside the words array, never between two words.
                  The paraIdx = segIdx so clicking explains THIS segment. */}
              {hindiHelp && (
                <div className="mt-1 mb-1">
                  {explainState && explainState.paragraphIdx === segIdx && (
                    <span
                      className="block mt-2 mb-2 p-3 rounded-lg text-xs leading-relaxed"
                      style={{
                        background: "rgba(168,85,247,0.06)",
                        borderLeft: "2px solid rgba(168,85,247,0.4)",
                        color: "var(--aria-fg-muted)",
                      }}
                    >
                      {explainState.loading ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          समझाया जा रहा है…
                        </span>
                      ) : (
                        <>
                          <span className="font-serif text-sm">{explainState.result?.explanation}</span>
                          <div className="flex items-center gap-2 mt-2">
                            {explainState.result?.audio_url && (
                              <button
                                onClick={playExplainAudio}
                                className="flex items-center gap-1 text-[10px] hover:opacity-80"
                                style={{ color: "rgba(168,85,247,0.8)" }}
                              >
                                <Volume2 className="w-3 h-3" /> सुनें
                              </button>
                            )}
                            <button
                              onClick={() => setExplainState(null)}
                              className="flex items-center gap-1 text-[10px] hover:opacity-80"
                              style={{ color: "var(--aria-fg-dim)" }}
                            >
                              <X className="w-3 h-3" /> बंद करें
                            </button>
                          </div>
                        </>
                      )}
                    </span>
                  )}
                  {!(explainState && explainState.paragraphIdx === segIdx) && (
                    <button
                      onClick={() => {
                        handleExplain(
                          words.slice(seg.startIdx, seg.endIdx).join(" "),
                          segIdx,
                        );
                      }}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-opacity opacity-70 hover:opacity-100"
                      style={{
                        color: "rgba(168,85,247,0.8)",
                        border: "1px solid rgba(168,85,247,0.25)",
                        background: "transparent",
                      }}
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      हिंदी में समझाओ
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {/* Bottom spacer so the final lines can be centred */}
          <div style={{ height: "28vh" }} />
        </div>

        {/* Glossary popover */}
        {glossary && (
          <div
            className="fixed z-50 max-w-xs p-3 rounded-xl shadow-2xl"
            style={{
              left: Math.min(glossary.x, window.innerWidth - 300),
              top: glossary.y + 20,
              background: "var(--aria-bg-soft)",
              border: "1px solid var(--aria-border)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--aria-accent-glow)" }}>
                {glossary.word}
              </span>
              <button onClick={() => setGlossary(null)} className="text-[var(--aria-fg-dim)] hover:text-[var(--aria-fg)]">
                <X className="w-3 h-3" />
              </button>
            </div>
            {glossary.loading ? (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--aria-fg-muted)" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                अर्थ खोजा जा रहा है…
              </div>
            ) : glossary.result ? (
              <div>
                <p className="font-serif text-xs leading-relaxed" style={{ color: "var(--aria-fg)" }}>
                  {glossary.result.explanation}
                </p>
                {glossary.result.audio_url && (
                  <button
                    onClick={() => {
                      const mainAudio = getAudioElement();
                      if (mainAudio && !mainAudio.paused) mainAudio.pause();
                      const a = new Audio(glossary.result!.audio_url);
                      a.play().catch(() => {});
                    }}
                    className="flex items-center gap-1 text-[10px] mt-2 hover:opacity-80"
                    style={{ color: "var(--aria-accent-glow)" }}
                  >
                    <Volume2 className="w-3 h-3" /> सुनें
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* Floating "Return to current word" button — shown when follow is off */}
        {!followPlayback && (
          <button
            onClick={handleReturnToWord}
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium shadow-lg transition-all hover:scale-105"
            style={{
              background: "var(--aria-accent-glow)",
              color: "#1a1208",
              border: "1px solid rgba(245,158,11,0.4)",
            }}
          >
            <Locate className="w-3 h-3" />
            Return to current word
          </button>
        )}
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
          {/* Sync offset control */}
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
