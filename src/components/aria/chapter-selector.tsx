"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { X, Check, Loader2, Clock, DollarSign, Sparkles, RotateCcw } from "lucide-react";
import { AmbientGlow, GradientText } from "./primitives";
import { ScrollReveal } from "./scroll-reveal";
import { usePlayerStore, type PlayerChapter } from "@/lib/player-store";
import { toast } from "@/hooks/use-toast";

interface ChapterSelectorProps {
  audiobookId: string;
  title: string;
  author: string | null;
  accent: string;
  onClose: () => void;
  onConvertStarted?: () => void;
  /** When true, a "Listen Now" button is shown (some chapters are already ready). */
  showListenNow?: boolean;
}

// Available Google Cloud TTS Neural2 voices for en-US.
// All are standard-tier (no TPU overload issues like Journey voices).
const NEURAL2_VOICES = [
  { id: 'en-US-Neural2-A', label: 'A — Female (warm)', gender: 'female' },
  { id: 'en-US-Neural2-B', label: 'B — Male (deep)', gender: 'male' },
  { id: 'en-US-Neural2-C', label: 'C — Male (narrative)', gender: 'male' },
  { id: 'en-US-Neural2-D', label: 'D — Male (deep, steady)', gender: 'male' },
  { id: 'en-US-Neural2-E', label: 'E — Female (clear)', gender: 'female' },
  { id: 'en-US-Neural2-F', label: 'F — Female (default, conversational)', gender: 'female' },
  { id: 'en-US-Neural2-G', label: 'G — Female (mature)', gender: 'female' },
  { id: 'en-US-Neural2-H', label: 'H — Female (bright)', gender: 'female' },
  { id: 'en-US-Neural2-I', label: 'I — Male (friendly)', gender: 'male' },
];

/**
 * ChapterSelector — modal that lets the user pick which chapters to convert.
 *
 * Fetches the chapter list from /api/audiobooks/[id]/chapters, shows one row
 * per chapter with a checkbox, title, word count, estimated minutes, and
 * status pill (ready / pending / generating / failed). Ready chapters are
 * shown but disabled (already converted). The user selects pending/failed
 * chapters and hits "Convert Selected" which calls /api/audiobooks/[id]/convert.
 *
 * Live estimate shows total characters, estimated minutes, and estimated cost
 * (Google Neural2 TTS at ~$0.000016/char).
 *
 * Modeled on the audiobook-maker.com chapter selection UX.
 */
export function ChapterSelector({
  audiobookId,
  title,
  author,
  accent,
  onClose,
  onConvertStarted,
  showListenNow,
}: ChapterSelectorProps) {
  const openPlayer = usePlayerStore((s) => s.openPlayer);
  const [chapters, setChapters] = useState<PlayerChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [converting, setConverting] = useState(false);
  const [voice, setVoice] = useState('en-US-Neural2-F');

  const fetchChapters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/audiobooks/${audiobookId}/chapters`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setChapters(data.chapters || []);
    } catch (err) {
      console.error("[chapter-selector] failed to load chapters", err);
      toast({ title: "Could not load chapters", description: err instanceof Error ? err.message : "Try again" });
    } finally {
      setLoading(false);
    }
  }, [audiobookId]);

  useEffect(() => {
    fetchChapters();
  }, [fetchChapters]);

  // Poll for status updates while any chapter is generating
  useEffect(() => {
    const hasGenerating = chapters.some(c => c.status === "generating");
    if (!hasGenerating) return;
    const interval = setInterval(fetchChapters, 5000);
    return () => clearInterval(interval);
  }, [chapters, fetchChapters]);

  // ── Selection helpers ──
  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableChapters = chapters.filter(c => c.status !== "ready" && c.status !== "generating");
  const selectAll = () => setSelected(new Set(selectableChapters.map(c => c.id)));
  const selectNone = () => setSelected(new Set());
  const selectInvert = () => {
    setSelected(prev => {
      const next = new Set<string>();
      for (const c of selectableChapters) {
        if (!prev.has(c.id)) next.add(c.id);
      }
      return next;
    });
  };

  // ── Live estimate ──
  const estimate = useMemo(() => {
    const selectedChapters = chapters.filter(c => selected.has(c.id));
    const totalChars = selectedChapters.reduce((sum, c) => sum + (c.cleanedText?.length || 0), 0);
    // 150 words/min narration speed; avg 5 chars/word → 750 chars/min
    const estMinutes = Math.max(1, Math.round(totalChars / 750));
    // Google Neural2 TTS: ~$0.000016 per character
    const estCost = totalChars * 0.000016;
    return { count: selectedChapters.length, totalChars, estMinutes, estCost };
  }, [chapters, selected]);

  const handleConvert = async () => {
    if (selected.size === 0) {
      toast({ title: "No chapters selected", description: "Pick at least one chapter to convert." });
      return;
    }
    setConverting(true);
    try {
      const res = await fetch(`/api/audiobooks/${audiobookId}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed (${res.status})`);
      }
      const data = await res.json();
      if (data.message) {
        // All selected chapters were already ready
        toast({ title: "Nothing to convert", description: data.message });
      } else {
        toast({
          title: "Conversion started",
          description: `${data.chapterCount} chapter${data.chapterCount === 1 ? "" : "s"} queued for TTS generation.`,
        });
      }
      setSelected(new Set());
      onConvertStarted?.();
      // Refresh the chapter list to show the new 'generating' statuses
      setTimeout(fetchChapters, 500);
    } catch (err) {
      console.error("[chapter-selector] convert failed", err);
      toast({ title: "Could not start conversion", description: err instanceof Error ? err.message : "Try again" });
    } finally {
      setConverting(false);
    }
  };

  const handleListenNow = async () => {
    try {
      // Chapters are already loaded — open the player directly
      const current = {
        id: audiobookId,
        title,
        author,
        accent,
        documentId: "", // not needed for playback
      };
      openPlayer(current, chapters, 0);
      onClose();
    } catch (err) {
      console.error("[chapter-selector] listen now failed", err);
      toast({ title: "Could not open player" });
    }
  };

  const readyCount = chapters.filter(c => c.status === "ready").length;
  const generatingCount = chapters.filter(c => c.status === "generating").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <AmbientGlow color={accent} opacity={0.15} size={600} className="top-1/4 left-1/4" />

      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border"
        style={{
          background: "var(--aria-bg)",
          borderColor: "var(--aria-border)",
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 sm:p-6 border-b" style={{ borderColor: "var(--aria-border)" }}>
          <div className="flex-1 min-w-0 pr-4">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase mb-1.5" style={{ color: "var(--aria-fg-dim)" }}>
              Select chapters
            </div>
            <h2 className="font-serif text-2xl leading-tight truncate">{title}</h2>
            <p className="text-xs mt-1" style={{ color: "var(--aria-fg-muted)" }}>
              {author ? `by ${author}` : "Author unknown"} · {chapters.length} chapters total
              {readyCount > 0 && ` · ${readyCount} ready`}
              {generatingCount > 0 && ` · ${generatingCount} generating`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors hover:bg-white/5"
            style={{ color: "var(--aria-fg-muted)" }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Bulk actions + voice selection */}
        {!loading && chapters.length > 0 && (
          <div className="flex items-center gap-2 px-5 sm:px-6 py-3 border-b flex-wrap" style={{ borderColor: "var(--aria-border)" }}>
            {selectableChapters.length > 0 && (
              <>
                <button
                  onClick={selectAll}
                  className="text-xs px-3 py-1.5 rounded-md transition-colors hover:bg-white/5"
                  style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                >
                  Select all
                </button>
                <button
                  onClick={selectNone}
                  className="text-xs px-3 py-1.5 rounded-md transition-colors hover:bg-white/5"
                  style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                >
                  None
                </button>
                <button
                  onClick={selectInvert}
                  className="text-xs px-3 py-1.5 rounded-md transition-colors hover:bg-white/5"
                  style={{ color: "var(--aria-fg-muted)", border: "1px solid var(--aria-border)" }}
                >
                  Invert
                </button>
              </>
            )}
            <div className="flex-1" />
            {/* Voice selector */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono tracking-wider uppercase" style={{ color: "var(--aria-fg-dim)" }}>
                Voice
              </label>
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-md bg-transparent cursor-pointer"
                style={{
                  color: "var(--aria-fg)",
                  border: "1px solid var(--aria-border)",
                  background: "var(--aria-bg)",
                }}
              >
                {NEURAL2_VOICES.map(v => (
                  <option key={v.id} value={v.id} style={{ background: "var(--aria-bg)" }}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            {showListenNow && readyCount > 0 && (
              <button
                onClick={handleListenNow}
                className="text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5"
                style={{
                  background: "rgba(245,158,11,0.15)",
                  border: "1px solid rgba(245,158,11,0.3)",
                  color: "var(--aria-accent-glow)",
                }}
              >
                Listen now
              </button>
            )}
          </div>
        )}

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto px-2 sm:px-3 py-2" style={{ maxHeight: "50vh" }}>
          {loading ? (
            <div className="flex items-center justify-center py-12" style={{ color: "var(--aria-fg-dim)" }}>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              <span className="text-sm">Loading chapters…</span>
            </div>
          ) : chapters.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
                No chapters found. Try re-uploading the EPUB.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {chapters.map((ch, idx) => {
                const isReady = ch.status === "ready";
                const isGenerating = ch.status === "generating";
                const isFailed = ch.status === "failed";
                const isSelected = selected.has(ch.id);
                const isDisabled = isReady || isGenerating;
                const charCount = ch.cleanedText?.length || 0;
                const estMin = Math.max(1, Math.round(charCount / 750));

                return (
                  <label
                    key={ch.id}
                    className={`flex items-center gap-3 p-3 rounded-lg transition-colors cursor-pointer ${
                      isDisabled ? "opacity-60 cursor-not-allowed" : "hover:bg-white/5"
                    } ${isSelected ? "bg-white/5" : ""}`}
                  >
                    <div className="flex items-center justify-center flex-shrink-0">
                      {isReady ? (
                        <div className="w-4 h-4 rounded flex items-center justify-center" style={{ background: "rgba(34,197,94,0.2)", border: "1px solid rgba(34,197,94,0.4)" }}>
                          <Check size={11} className="text-green-400" />
                        </div>
                      ) : isGenerating ? (
                        <Loader2 size={16} className="animate-spin" style={{ color: "var(--aria-accent-glow)" }} />
                      ) : (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(ch.id)}
                          disabled={isDisabled}
                          className="w-4 h-4 rounded cursor-pointer"
                          style={{ accentColor: "var(--aria-accent-glow)" }}
                        />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono" style={{ color: "var(--aria-fg-dim)" }}>
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <span className="text-sm font-medium truncate" style={{ color: "var(--aria-fg)" }}>
                          {ch.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[10px]" style={{ color: "var(--aria-fg-dim)" }}>
                          {charCount.toLocaleString()} chars · ~{estMin} min
                        </span>
                        {isFailed && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>
                            Failed — retry?
                          </span>
                        )}
                      </div>
                    </div>

                    {isReady && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
                        <Check size={9} /> Ready
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — estimate + convert button */}
        {!loading && (
          <div className="p-5 sm:p-6 border-t" style={{ borderColor: "var(--aria-border)" }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4 text-xs" style={{ color: "var(--aria-fg-muted)" }}>
                <span className="flex items-center gap-1.5">
                  <Sparkles size={12} style={{ color: "var(--aria-accent-glow)" }} />
                  {estimate.count} selected
                </span>
                {estimate.count > 0 && (
                  <>
                    <span className="flex items-center gap-1.5">
                      <Clock size={12} />
                      ~{estimate.estMinutes} min
                    </span>
                    <span className="flex items-center gap-1.5">
                      <DollarSign size={12} />
                      ~${estimate.estCost.toFixed(2)}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  background: "transparent",
                  border: "1px solid var(--aria-border)",
                  color: "var(--aria-fg-muted)",
                }}
              >
                Close
              </button>
              <button
                onClick={handleConvert}
                disabled={selected.size === 0 || converting}
                className="flex-[2] px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: selected.size === 0 ? "transparent" : "var(--aria-accent-glow)",
                  border: `1px solid ${selected.size === 0 ? "var(--aria-border)" : "var(--aria-accent-glow)"}`,
                  color: selected.size === 0 ? "var(--aria-fg-muted)" : "var(--aria-bg)",
                }}
              >
                {converting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <RotateCcw size={14} />
                    Convert {selected.size > 0 ? `${selected.size} chapter${selected.size === 1 ? "" : "s"}` : "selected"}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
