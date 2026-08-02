"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Book } from "@/lib/audiobooks";

/**
 * Book cover with graceful fallback: if the image fails to load, renders an
 * elegant gradient + typographic cover in the ARIA aesthetic so the library
 * never shows a broken/empty image.
 */
export function BookCover({
  book,
  className,
  imgClassName,
}: {
  book: Book;
  className?: string;
  imgClassName?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={cn("relative overflow-hidden", className)}
        style={{
          background: `radial-gradient(circle at 30% 20%, ${book.accent}33 0%, transparent 50%), linear-gradient(160deg, #1c0f06 0%, #0c0a08 60%, #050403 100%)`,
        }}
      >
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background: `repeating-linear-gradient(115deg, transparent 0px, transparent 18px, ${book.accent}0d 18px, ${book.accent}0d 19px)`,
          }}
        />
        <div
          className="absolute -top-10 -right-10 w-40 h-40 rounded-full blur-3xl opacity-30"
          style={{ background: book.accent }}
        />
        <div
          className="absolute top-6 right-6 w-10 h-10 rounded-full opacity-70"
          style={{
            background: `radial-gradient(circle at 32% 28%, rgba(255,251,235,0.95) 0%, transparent 30%), radial-gradient(circle at 50% 50%, ${book.accent} 0%, ${book.accent}88 50%, #1c0a01 100%)`,
            boxShadow: `0 0 24px ${book.accent}66`,
          }}
        />
        <div className="absolute inset-0 flex flex-col justify-between p-5">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--aria-fg-dim)]">
            ARIA Books
          </div>
          <div>
            <div className="w-8 h-px mb-3" style={{ background: book.accent }} />
            <h3 className="font-serif text-2xl leading-tight text-[var(--aria-fg)]">
              {book.title}
            </h3>
            <p className="text-[11px] text-[var(--aria-fg-muted)] mt-2">{book.author}</p>
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-[var(--aria-fg-dim)]">
            {book.genres[0]}
          </div>
        </div>
      </div>
    );
  }

  return (
    <img
      src={book.cover}
      alt={`Cover of ${book.title}`}
      className={cn("w-full h-full object-cover", imgClassName)}
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth === 0) setFailed(true);
      }}
    />
  );
}
