"use client";

import { cn } from "@/lib/utils";

/**
 * Book cover — shows an AI-generated cover image when available, otherwise
 * falls back to a gradient + monogram cover generated from the title's first
 * letter and the book's accent color.
 *
 * The AI cover is generated on upload via /api/cover-art (z-ai-web-dev-sdk
 * image generation). It's stored as a data URL in localStorage
 * (aria-cover-<jobId>) and passed in as coverUrl.
 */
export function BookCover({
  title,
  accent = "#f59e0b",
  coverUrl,
  className,
}: {
  title: string;
  accent?: string;
  /** Optional AI-generated cover image (data URL or regular URL).
   *  When provided, the image is shown instead of the CSS monogram. */
  coverUrl?: string;
  className?: string;
}) {
  // If we have an AI-generated cover, show it with a subtle gradient overlay
  // + the ARIA Audiobooks label at the top (for brand consistency).
  if (coverUrl) {
    return (
      <div className={cn("relative overflow-hidden", className)}>
        <img
          src={coverUrl}
          alt={`Cover art for ${title}`}
          className="absolute inset-0 w-full h-full object-cover"
        />
        {/* Gradient overlay for readability + brand consistency */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" />
        <div className="absolute inset-0 flex flex-col justify-between p-5">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/70">
            ARIA Audiobooks
          </div>
        </div>
      </div>
    );
  }

  // Fallback: CSS monogram cover
  const monogram = (title.trim()[0] || "A").toUpperCase();
  const subtitle = title.length > 60 ? title.slice(0, 57) + "…" : title;

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={{
        background: `radial-gradient(circle at 30% 20%, ${accent}33 0%, transparent 50%), linear-gradient(160deg, #1c0f06 0%, #0c0a08 60%, #050403 100%)`,
      }}
    >
      {/* Diagonal line texture */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background: `repeating-linear-gradient(115deg, transparent 0px, transparent 18px, ${accent}0d 18px, ${accent}0d 19px)`,
        }}
      />
      {/* Ambient glow blob */}
      <div
        className="absolute -top-10 -right-10 w-40 h-40 rounded-full blur-3xl opacity-30"
        style={{ background: accent }}
      />
      {/* Decorative circle (sun/moon motif) */}
      <div
        className="absolute top-6 right-6 w-10 h-10 rounded-full opacity-70"
        style={{
          background: `radial-gradient(circle at 32% 28%, rgba(255,251,235,0.95) 0%, transparent 30%), radial-gradient(circle at 50% 50%, ${accent} 0%, ${accent}88 50%, #1c0a01 100%)`,
          boxShadow: `0 0 24px ${accent}66`,
        }}
      />
      <div className="absolute inset-0 flex flex-col justify-between p-5">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--aria-fg-dim)]">
          ARIA Audiobooks
        </div>
        {/* Large monogram letter */}
        <div
          className="font-serif text-7xl leading-none flex-1 flex items-center justify-center opacity-80"
          style={{ color: accent, textShadow: `0 0 30px ${accent}44` }}
        >
          {monogram}
        </div>
        <div>
          <div className="w-8 h-px mb-3" style={{ background: accent }} />
          <h3 className="font-serif text-lg leading-tight text-[var(--aria-fg)]">
            {subtitle}
          </h3>
        </div>
      </div>
    </div>
  );
}
