"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { getCachedCover, cacheCover } from "@/lib/cover-cache";

/**
 * Book cover — shows the EPUB's embedded cover image (extracted by the Flask
 * app during /api/analyze) when available, otherwise falls back to a gradient
 * + monogram cover generated from the title's first letter and the book's
 * accent color.
 *
 * The cover image is served by the Flask endpoint /api/cover/<job_id>,
 * which extracts the cover from the EPUB on upload. No AI generation —
 * consistent, instant, always available.
 *
 * Fail-soft: if the network image fails to load (e.g. Flask restart wiped
 * the cover), falls back to the IndexedDB cache (if available) or the CSS
 * monogram. Never leaves an empty dark box.
 */
export function BookCover({
  title,
  accent = "#f59e0b",
  coverImgUrl,
  jobId,
  className,
}: {
  title: string;
  accent?: string;
  /** Optional cover image URL (from /api/cover/<job_id>). When provided,
   *  the EPUB's embedded cover is shown instead of the CSS monogram. */
  coverImgUrl?: string;
  /** Job ID — used to look up the IndexedDB cover cache when the network
   *  image fails. Optional but recommended for cache resilience. */
  jobId?: string;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [cachedCover, setCachedCover] = useState<string | null>(null);
  const [prevUrl, setPrevUrl] = useState(coverImgUrl);

  // Reset error state when the URL changes (e.g. switching books).
  // React-recommended pattern: adjust state during render when a prop changes,
  // avoiding setState-in-effect cascading renders.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (prevUrl !== coverImgUrl) {
    setPrevUrl(coverImgUrl);
    setImgFailed(false);
  }

  // On mount, try to load a cached cover from IndexedDB (instant display
  // even if the backend is cold/restarted). Fail-soft: if IndexedDB is
  // unavailable, cachedCover stays null and we fall through to the network.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    getCachedCover(jobId).then((cached) => {
      if (!cancelled && cached) setCachedCover(cached);
    });
    return () => { cancelled = true; };
  }, [jobId]);

  // Determine which image source to use:
  // 1. If the network image hasn't failed, use it (and cache it on success).
  // 2. If the network image failed but we have a cached cover, use that.
  // 3. Otherwise fall back to the monogram.
  const networkUrl = coverImgUrl && !imgFailed ? coverImgUrl : null;
  const fallbackUrl = imgFailed && cachedCover ? cachedCover : null;
  const activeUrl = networkUrl || fallbackUrl;

  // If we're showing the network image, try to refresh the cache in the
  // background so the next cold start has a fresh copy.
  useEffect(() => {
    if (networkUrl && jobId) {
      cacheCover(jobId, networkUrl);
    }
  }, [networkUrl, jobId]);

  if (activeUrl) {
    return (
      <div className={cn("relative overflow-hidden", className)}>
        <img
          src={activeUrl}
          alt={`Cover art for ${title}`}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => {
            // If the network image fails, try the cache; if no cache,
            // fall through to the monogram on next render.
            setImgFailed(true);
          }}
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
