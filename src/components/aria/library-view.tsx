"use client";

import { useState, useEffect, useCallback } from "react";
import { Play, Trash2, BookOpen, ArrowLeft } from "lucide-react";
import { AmbientGlow, GradientText } from "./primitives";
import { ScrollReveal } from "./scroll-reveal";
import { BookCover } from "./book-cover";
import { usePlayerStore, type CurrentAudiobook, type PlayerChapter } from "@/lib/player-store";
import { useAriaStore } from "@/lib/store";
import { formatDuration } from "@/lib/audiobooks";
import { toast } from "@/hooks/use-toast";

interface AudiobookListItem {
  id: string;
  title: string;
  author: string | null;
  accent: string;
  documentId: string;
  createdAt: string;
  progressChapter: number;
  progressCharOffset: number;
  chapterCount: number;
  narratedCount: number;
  chaptersReady: boolean;
  prepProgress?: number;
  prepTotal?: number;
}

/**
 * LibraryView — fetches the user's real audiobooks from /api/audiobooks.
 * Audiobooks are auto-created when book-length content is fed via Feed ARIA.
 */
export function LibraryView() {
  const openPlayer = usePlayerStore((s) => s.openPlayer);
  const setActiveWorkspace = useAriaStore((s) => s.setActiveWorkspace);
  const [audiobooks, setAudiobooks] = useState<AudiobookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredBook, setHoveredBook] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchAudiobooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/audiobooks');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setAudiobooks(data.audiobooks || []);
      setError(null);
    } catch (err) {
      console.error('[library-view] failed to load audiobooks', err);
      setError(err instanceof Error ? err.message : 'Failed to load your library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudiobooks();
  }, [fetchAudiobooks]);

  // Drive chapter preparation for audiobooks that aren't ready yet.
  // Polls POST /api/audiobooks/[id]/prep-batch every 3 seconds for one
  // audiobook at a time (sequential, not parallel — avoids overwhelming
  // the LLM provider with concurrent chapter-cleaning calls).
  // Stops polling for an audiobook once its response is { done: true }.
  const [preppingId, setPreppingId] = useState<string | null>(null);

  useEffect(() => {
    // Find audiobooks that still need prep
    const pending = audiobooks.filter(b => !b.chaptersReady);
    if (pending.length === 0) {
      setPreppingId(null);
      return;
    }

    // If we're not currently prepping anything, start with the first pending one
    if (!preppingId || !audiobooks.find(b => b.id === preppingId && !b.chaptersReady)) {
      setPreppingId(pending[0].id);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/audiobooks/${preppingId}/prep-batch`, { method: 'POST' });
        if (!res.ok) return;
        const data = await res.json();

        // Update the audiobook's state in the local list
        setAudiobooks(prev => prev.map(b => {
          if (b.id !== preppingId) return b;
          return {
            ...b,
            chaptersReady: data.done === true,
            prepProgress: data.progress,
            prepTotal: data.total,
            // When done, refresh chapter count from the total
            chapterCount: data.done === true ? (data.total ?? b.chapterCount) : b.chapterCount,
          };
        }));

        // If this one is done, move to the next pending audiobook
        if (data.done === true) {
          setPreppingId(null); // triggers re-evaluation on next render
        }
      } catch (err) {
        console.error('[library-view] prep-batch poll failed for', preppingId, err);
      }
    };

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [audiobooks, preppingId]);

  const handleOpen = async (book: AudiobookListItem) => {
    try {
      // Fetch chapters for this audiobook before opening the player
      const res = await fetch(`/api/audiobooks/${book.id}/chapters`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body?.error || `Request failed (${res.status})`;
        console.error('[library-view] could not load chapters for', book.id, detail);
        toast({ title: "Could not load chapters", description: detail });
        return;
      }
      const data = await res.json();
      const chapters: PlayerChapter[] = data.chapters || [];
      if (chapters.length === 0) {
        toast({ title: "No readable text found", description: "This audiobook has no content" });
        return;
      }
      const current: CurrentAudiobook = {
        id: book.id,
        title: book.title,
        author: book.author,
        accent: book.accent,
        documentId: book.documentId,
      };
      // Resume from saved progress if available
      openPlayer(current, chapters, book.progressChapter || 0);
    } catch (err) {
      console.error('[library-view] failed to open audiobook', book.id, err);
      const detail = err instanceof Error ? err.message : 'Try again';
      toast({ title: "Could not open audiobook", description: detail });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/audiobooks/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      setAudiobooks(prev => prev.filter(b => b.id !== id));
      toast({ title: "Audiobook removed" });
    } catch (err) {
      console.error('[library-view] failed to delete audiobook', id, err);
      const detail = err instanceof Error ? err.message : 'Try again';
      toast({ title: "Could not delete", description: detail });
    }
    setConfirmDelete(null);
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      <AmbientGlow color="#f59e0b" opacity={0.1} size={600} className="top-0 right-0" />

      <div className="relative z-10 max-w-7xl mx-auto px-5 sm:px-8 pt-10 sm:pt-14 pb-16">
        {/* Back to chat — exits the audiobook workspace entirely */}
        <button
          onClick={() => setActiveWorkspace('chat')}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors mb-6"
          style={{ color: 'var(--aria-fg-muted)' }}
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
            <p className="text-sm text-[var(--aria-fg-muted)] max-w-xs">
              Feed ARIA a book-length PDF, URL, or text and it appears here —
              ready to be read aloud.
            </p>
          </div>
        </ScrollReveal>

        {loading ? (
          <div className="text-center py-20" style={{ color: 'var(--aria-fg-dim)' }}>
            <p className="text-sm">Loading your library…</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-sm" style={{ color: 'var(--aria-fg-muted)' }}>
              Couldn&apos;t load your library — {error}
            </p>
            <button
              onClick={fetchAudiobooks}
              className="mt-3 text-sm underline"
              style={{ color: 'var(--aria-accent-glow)' }}
            >
              Try again
            </button>
          </div>
        ) : audiobooks.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen size={40} strokeWidth={1} className="mx-auto mb-4 opacity-30" style={{ color: 'var(--aria-fg-dim)' }} />
            <p className="text-sm" style={{ color: 'var(--aria-fg-muted)' }}>
              No audiobooks yet.
            </p>
            <p className="text-xs mt-2" style={{ color: 'var(--aria-fg-dim)' }}>
              Feed ARIA a book (PDF, URL, or pasted text) from the Feed menu —
              anything long enough becomes an audiobook automatically.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5 sm:gap-7">
            {audiobooks.map((book, i) => {
              const hasProgress = book.progressChapter > 0 || book.progressCharOffset > 0;
              return (
                <ScrollReveal key={book.id} delay={i * 80}>
                  <div
                    className="group text-left w-full relative"
                    onMouseEnter={() => setHoveredBook(book.id)}
                    onMouseLeave={() => setHoveredBook(null)}
                  >
                    <div className="book-cover aspect-[3/5] relative cursor-pointer" onClick={() => handleOpen(book)}>
                      <BookCover
                        title={book.title}
                        accent={book.accent}
                        className="absolute inset-0"
                      />
                      {/* gradient overlay */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />

                      {/* play button on hover */}
                      <div
                        className={`absolute inset-0 flex items-center justify-center transition-all duration-500 ${
                          hoveredBook === book.id
                            ? "opacity-100 backdrop-blur-[2px] bg-black/30"
                            : "opacity-0"
                        }`}
                      >
                        <span className="w-14 h-14 rounded-full bg-[var(--aria-fg)] text-[var(--aria-bg)] flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.5)] group-hover:scale-110 transition-transform duration-500">
                          <Play className="w-5 h-5 fill-current ml-0.5" />
                        </span>
                      </div>

                      {/* now playing / progress badge */}
                      {hasProgress && (
                        <div className="absolute top-3 right-3 status-pill !py-1 !px-2.5 !text-[9px]">
                          <span className="status-dot" />
                          In progress
                        </div>
                      )}

                      {/* delete button (top-left, hover only) */}
                      {confirmDelete === book.id ? (
                        <div className="absolute top-3 left-3 flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(book.id); }}
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
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(book.id); }}
                          className={`absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                            hoveredBook === book.id ? "opacity-100" : "opacity-0"
                          } bg-black/50 text-[var(--aria-fg-muted)] hover:text-[#ef4444]`}
                          title="Delete audiobook"
                          aria-label="Delete audiobook"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    <div className="mt-3.5">
                      <h3 className="font-serif text-lg leading-snug text-[var(--aria-fg)] group-hover:text-[var(--aria-accent-glow)] transition-colors">
                        {book.title}
                      </h3>
                      <p className="text-xs text-[var(--aria-fg-muted)] mt-0.5">
                        {book.author ? `by ${book.author}` : 'Author unknown'}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {!book.chaptersReady ? (
                          <p className="text-[11px] text-[var(--aria-accent-glow)] flex items-center gap-1">
                            <span className="status-dot" />
                            {book.prepTotal && book.prepTotal > 0
                              ? `Preparing… (${book.prepProgress ?? 0}/${book.prepTotal} chapters)`
                              : 'Preparing your audiobook…'}
                          </p>
                        ) : (
                          <>
                            {hasProgress && (
                              <p className="text-[11px] text-[var(--aria-accent-glow)]">
                                Ch. {book.progressChapter + 1} · {formatDuration(book.progressCharOffset)}
                              </p>
                            )}
                            {book.chapterCount > 0 && (
                              <p className="text-[11px] text-[var(--aria-fg-dim)]">
                                {book.narratedCount}/{book.chapterCount} narrated
                              </p>
                            )}
                          </>
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
    </div>
  );
}
