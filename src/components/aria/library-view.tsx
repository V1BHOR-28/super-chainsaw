"use client";

import { useState } from "react";
import { Play, Star, Clock } from "lucide-react";
import { AmbientGlow, GradientText } from "./primitives";
import { NowPlayingBars } from "./waveform";
import { ScrollReveal } from "./scroll-reveal";
import { BookCover } from "./book-cover";
import { usePlayerStore } from "@/lib/player-store";
import { BOOKS, formatDuration } from "@/lib/audiobooks";
import { cn } from "@/lib/utils";

/**
 * LibraryView — the audiobook browsing grid, lifted out of the standalone
 * audiobook prototype's marketing landing page (which also had a hero,
 * marquee, features, and CTA section that we deliberately did NOT bring
 * over). This is just the book grid, now the root screen of the Audiobooks
 * workspace inside ARIA.
 */
export function LibraryView() {
  const openPlayer = usePlayerStore((s) => s.openPlayer);
  const progress = usePlayerStore((s) => s.progress);
  const [hoveredBook, setHoveredBook] = useState<string | null>(null);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <AmbientGlow color="#f59e0b" opacity={0.1} size={600} className="top-0 right-0" />

      <div className="relative z-10 max-w-7xl mx-auto px-5 sm:px-8 pt-10 sm:pt-14 pb-16">
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
              Six carefully narrated books. Each one a complete world you can
              carry in your ears.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5 sm:gap-7">
          {BOOKS.map((book, i) => {
            const p = progress[book.id];
            const pct =
              p && book.totalDuration > 0
                ? Math.min(
                    100,
                    ((p.chapterIndex * 60 * 30 + p.time) / book.totalDuration) * 100
                  )
                : 0;
            return (
              <ScrollReveal key={book.id} delay={i * 80}>
                <button
                  onClick={() => openPlayer(book.id)}
                  onMouseEnter={() => setHoveredBook(book.id)}
                  onMouseLeave={() => setHoveredBook(null)}
                  className="group text-left w-full"
                >
                  <div className="book-cover aspect-[3/5] relative">
                    <BookCover
                      book={book}
                      className="absolute inset-0"
                      imgClassName="w-full h-full object-cover"
                    />
                    {/* gradient overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />

                    {/* play button on hover */}
                    <div
                      className={cn(
                        "absolute inset-0 flex items-center justify-center transition-all duration-500",
                        hoveredBook === book.id
                          ? "opacity-100 backdrop-blur-[2px] bg-black/30"
                          : "opacity-0"
                      )}
                    >
                      <span className="w-14 h-14 rounded-full bg-[var(--aria-fg)] text-[var(--aria-bg)] flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.5)] group-hover:scale-110 transition-transform duration-500">
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                      </span>
                    </div>

                    {/* progress bar */}
                    {pct > 0 && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                        <div
                          className="h-full bg-gradient-to-r from-[#f59e0b] to-[#fcd34d]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}

                    {/* now playing badge */}
                    {p && pct > 0 && pct < 100 && (
                      <div className="absolute top-3 right-3 status-pill !py-1 !px-2.5 !text-[9px]">
                        <NowPlayingBars active />
                        {Math.round(pct)}%
                      </div>
                    )}
                  </div>

                  <div className="mt-3.5">
                    <h3 className="font-serif text-lg leading-snug text-[var(--aria-fg)] group-hover:text-[var(--aria-accent-glow)] transition-colors">
                      {book.title}
                    </h3>
                    <p className="text-xs text-[var(--aria-fg-muted)] mt-0.5">
                      {book.author} · narrated by {book.narrator}
                    </p>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-[var(--aria-fg-dim)]">
                      <span className="flex items-center gap-1">
                        <Star className="w-3 h-3 fill-[var(--aria-accent)] text-[var(--aria-accent)]" />
                        {book.rating}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDuration(book.totalDuration)}
                      </span>
                      <span>{book.chapters.length} ch.</span>
                    </div>
                  </div>
                </button>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </div>
  );
}
