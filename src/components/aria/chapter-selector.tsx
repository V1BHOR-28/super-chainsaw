"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { X, Check, Loader2, Clock, Sparkles, RotateCcw } from "lucide-react";
import { AmbientGlow } from "./primitives";
import {
  generate,
  getVoices,
  type AnalyzeResponse,
  type VoicesResponse,
  type AbmVoice,
  type AbmLanguageGroup,
} from "@/lib/abm-api";
import { toast } from "@/hooks/use-toast";

interface ChapterSelectorProps {
  /**
   * The result from `analyzeEpub`. When provided, the chapter list is
   * shown with per-chapter checkboxes. When null (e.g. re-clicking an
   * "analyzed" job from the library), the selector runs in "whole-book"
   * mode — just voice selection + a Convert button that generates the
   * whole book.
   */
  analyzeResponse: AnalyzeResponse | null;
  jobId: string;
  title: string;
  author: string;
  onClose: () => void;
  onConvertStarted?: () => void;
}

/**
 * ChapterSelector — modal that lets the user pick which chapters to
 * convert and which edge-tts voice to use, then calls /api/generate.
 *
 * Modeled on the audiobook-maker.com chapter selection UX. Differences
 * vs the legacy ARIA selector:
 *   - Voice list comes from the Flask /api/voices endpoint (edge-tts
 *     catalog grouped by language) instead of a hardcoded Neural2 list.
 *   - Cost estimate is always "$0.00 — edge-tts is free" (Google Neural2
 *     has been removed from this build).
 *   - The Convert call goes to the Flask /api/generate endpoint with
 *     output_format="mp3" for browser-playable single-file output.
 *   - The "whole-book" mode (no analyzeResponse) handles re-clicking an
 *     analyzed job whose chapter data was lost when the modal closed.
 */
export function ChapterSelector({
  analyzeResponse,
  jobId,
  title,
  author,
  onClose,
  onConvertStarted,
}: ChapterSelectorProps) {
  const [voices, setVoices] = useState<VoicesResponse | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [voice, setVoice] = useState<string>("en-US-AriaNeural");
  const [converting, setConverting] = useState(false);

  // Default voice depends on the book's detected language — but we only
  // know it after voices load, so set it in that effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getVoices();
        if (cancelled) return;
        setVoices(data);
        // Pick a sensible default voice based on the book's language.
        const bookLang = (analyzeResponse?.language || "en").slice(0, 2).toLowerCase();
        const group = data[bookLang] as AbmLanguageGroup | undefined;
        if (group && Array.isArray(group.voices) && group.voices.length > 0) {
          // Prefer en-US-AriaNeural when available (matches the ARIA theme)
          const aria = group.voices.find(
            (v) => v.id === "en-US-AriaNeural" || v.id.toLowerCase().includes("arianeural"),
          );
          setVoice((aria ?? group.voices[0]).id);
        } else {
          // Fallback: first English voice, or first voice of the first language
          const enGroup = data.en as AbmLanguageGroup | undefined;
          if (enGroup && enGroup.voices.length > 0) {
            const aria = enGroup.voices.find((v) => v.id === "en-US-AriaNeural");
            setVoice((aria ?? enGroup.voices[0]).id);
          }
        }
      } catch (err) {
        console.error("[chapter-selector] voices fetch failed", err);
        // Non-fatal — the user can still type a voice ID, though the dropdown will be empty.
      } finally {
        if (!cancelled) setVoicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analyzeResponse]);

  // ── Build a flat list of voices grouped by language, English first ──
  const voiceGroups = useMemo(() => {
    if (!voices) return [] as { langCode: string; langName: string; voices: AbmVoice[] }[];
    const groups: { langCode: string; langName: string; voices: AbmVoice[] }[] = [];
    for (const [langCode, group] of Object.entries(voices)) {
      if (langCode.startsWith("_")) continue; // skip _premium_status, _translate_available
      if (!group || typeof group !== "object") continue;
      if (!Array.isArray((group as AbmLanguageGroup).voices)) continue;
      const g = group as AbmLanguageGroup;
      if (!g.voices.length) continue;
      groups.push({ langCode, langName: g.name || langCode, voices: g.voices });
    }
    // English first, then alphabetical by language name
    groups.sort((a, b) => {
      if (a.langCode === "en") return -1;
      if (b.langCode === "en") return 1;
      return a.langName.localeCompare(b.langName);
    });
    return groups;
  }, [voices]);

  const chapters = analyzeResponse?.chapters ?? [];

  // Default-select every chapter when the analyzeResponse first lands.
  useEffect(() => {
    if (chapters.length > 0 && selected.size === 0) {
      setSelected(new Set(chapters.map((c) => c.index)));
    }
  }, [chapters, selected]);

  // ── Selection helpers ──
  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(chapters.map((c) => c.index)));
  const selectNone = () => setSelected(new Set());
  const selectInvert = () => {
    setSelected((prev) => {
      const next = new Set<number>();
      for (const c of chapters) {
        if (!prev.has(c.index)) next.add(c.index);
      }
      return next;
    });
  };

  // ── Live estimate ──
  const estimate = useMemo(() => {
    const selectedChapters = chapters.filter((c) => selected.has(c.index));
    const totalChars = selectedChapters.reduce((sum, c) => sum + (c.chars || 0), 0);
    const estMinutes =
      selectedChapters.reduce((sum, c) => sum + (c.estimated_minutes || 0), 0) ||
      Math.max(1, Math.round(totalChars / 750));
    return { count: selectedChapters.length, totalChars, estMinutes };
  }, [chapters, selected]);

  const handleConvert = async () => {
    // In chapter-list mode, require at least one chapter. In whole-book
    // mode, send an empty array (the Flask app treats that as "all chapters").
    if (analyzeResponse && selected.size === 0) {
      toast({ title: "No chapters selected", description: "Pick at least one chapter to convert." });
      return;
    }
    setConverting(true);
    try {
      const selectedArr = analyzeResponse ? Array.from(selected).sort((a, b) => a - b) : [];
      await generate(jobId, voice, selectedArr, "mp3");
      toast({
        title: "Conversion started",
        description: analyzeResponse
          ? `${selectedArr.length} chapter${selectedArr.length === 1 ? "" : "s"} queued for TTS.`
          : "Whole book queued for TTS.",
      });
      onConvertStarted?.();
    } catch (err) {
      console.error("[chapter-selector] convert failed", err);
      toast({
        title: "Could not start conversion",
        description: err instanceof Error ? err.message : "Try again",
      });
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <AmbientGlow color="#f59e0b" opacity={0.15} size={600} className="top-1/4 left-1/4" />

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
              {analyzeResponse ? "Select chapters" : "Convert whole book"}
            </div>
            <h2 className="font-serif text-2xl leading-tight truncate">{title}</h2>
            <p className="text-xs mt-1" style={{ color: "var(--aria-fg-muted)" }}>
              {author ? `by ${author}` : "Author unknown"}
              {analyzeResponse && ` · ${chapters.length} chapters total`}
              {analyzeResponse?.language && ` · ${analyzeResponse.language}`}
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
        <div className="flex items-center gap-2 px-5 sm:px-6 py-3 border-b flex-wrap" style={{ borderColor: "var(--aria-border)" }}>
          {analyzeResponse && chapters.length > 0 && (
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
              disabled={voicesLoading}
              className="text-xs px-2 py-1.5 rounded-md bg-transparent cursor-pointer max-w-[220px]"
              style={{
                color: "var(--aria-fg)",
                border: "1px solid var(--aria-border)",
                background: "var(--aria-bg)",
              }}
            >
              {voicesLoading && <option>Loading voices…</option>}
              {!voicesLoading &&
                voiceGroups.map((g) => (
                  <optgroup key={g.langCode} label={`${g.langName} (${g.langCode})`}>
                    {g.voices.map((v) => (
                      <option key={v.id} value={v.id} style={{ background: "var(--aria-bg)" }}>
                        {v.name} ({v.gender}) — {v.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </div>
        </div>

        {/* Chapter list (only in chapter-list mode) */}
        {analyzeResponse ? (
          <div className="flex-1 overflow-y-auto px-2 sm:px-3 py-2" style={{ maxHeight: "50vh" }}>
            {chapters.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
                  No chapters found. Try re-uploading the EPUB.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {chapters.map((ch, idx) => {
                  const isSelected = selected.has(ch.index);
                  const charCount = ch.chars || 0;
                  const estMin = ch.estimated_minutes || Math.max(1, Math.round(charCount / 750));
                  return (
                    <label
                      key={ch.index}
                      className={`flex items-center gap-3 p-3 rounded-lg transition-colors cursor-pointer hover:bg-white/5 ${
                        isSelected ? "bg-white/5" : ""
                      }`}
                    >
                      <div className="flex items-center justify-center flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(ch.index)}
                          className="w-4 h-4 rounded cursor-pointer"
                          style={{ accentColor: "var(--aria-accent-glow)" }}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono" style={{ color: "var(--aria-fg-dim)" }}>
                            {String(idx + 1).padStart(2, "0")}
                          </span>
                          <span className="text-sm font-medium truncate" style={{ color: "var(--aria-fg)" }}>
                            {ch.title || `Chapter ${ch.index + 1}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-[10px]" style={{ color: "var(--aria-fg-dim)" }}>
                            {charCount.toLocaleString()} chars · ~{estMin} min
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-6" style={{ color: "var(--aria-fg-muted)" }}>
            <p className="text-sm leading-relaxed">
              The Flask app analyzed this book but the chapter list isn&apos;t
              available anymore (it was shown when you first uploaded). You can
              still narrate the <span className="font-medium" style={{ color: "var(--aria-fg)" }}>whole book</span> with
              your selected voice — pick one above and hit Convert.
            </p>
            <p className="text-xs mt-3" style={{ color: "var(--aria-fg-dim)" }}>
              To choose specific chapters, re-upload the EPUB from the library.
            </p>
          </div>
        )}

        {/* Footer — estimate + convert button */}
        <div className="p-5 sm:p-6 border-t" style={{ borderColor: "var(--aria-border)" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4 text-xs" style={{ color: "var(--aria-fg-muted)" }}>
              <span className="flex items-center gap-1.5">
                <Sparkles size={12} style={{ color: "var(--aria-accent-glow)" }} />
                {analyzeResponse
                  ? `${estimate.count} of ${chapters.length} selected`
                  : "Whole book"}
              </span>
              {analyzeResponse && estimate.count > 0 && (
                <span className="flex items-center gap-1.5">
                  <Clock size={12} />
                  ~{estimate.estMinutes} min
                </span>
              )}
              <span className="flex items-center gap-1.5" style={{ color: "#22c55e" }} title="edge-tts is free, no Google Cloud TTS">
                <Check size={12} />
                $0.00 — edge-tts is free
              </span>
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
              disabled={converting || (!!analyzeResponse && selected.size === 0)}
              className="flex-[2] px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background:
                  converting || (!!analyzeResponse && selected.size === 0)
                    ? "transparent"
                    : "var(--aria-accent-glow)",
                border: `1px solid ${
                  converting || (!!analyzeResponse && selected.size === 0)
                    ? "var(--aria-border)"
                    : "var(--aria-accent-glow)"
                }`,
                color:
                  converting || (!!analyzeResponse && selected.size === 0)
                    ? "var(--aria-fg-muted)"
                    : "var(--aria-bg)",
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
                  {analyzeResponse
                    ? `Convert ${selected.size > 0 ? `${selected.size} chapter${selected.size === 1 ? "" : "s"}` : "selected"}`
                    : "Convert whole book"}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
