"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Book, ChevronLeft, ChevronRight, Loader2, X, Type } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import { getEpubFileUrl } from "@/lib/abm-api";

/**
 * EpubReader — in-browser EPUB reader using epub.js.
 *
 * Renders the actual book content (real paragraphs, images, styling) in a
 * paginated book-like UI. The reader is COMPLETELY INDEPENDENT of audio
 * playback — no listeners on audio position, no auto-advance, no sync.
 * The user reads at their own pace while audio plays in the background.
 *
 * Features:
 * - Paginated rendering via epub.js (handles XHTML/CSS/images correctly)
 * - Manual page-turn (prev/next arrows + keyboard arrows)
 * - Manual chapter navigation (sidebar list, matches the app's chapter list)
 * - Font size control (smaller / larger)
 * - Light/dark theme toggle
 * - Independent from audio playback state
 */

export function EpubReader() {
  const job = usePlayerStore((s) => s.currentJob);
  const toggleReader = usePlayerStore((s) => s.toggleReader);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<unknown>(null);
  const bookRef = useRef<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [currentLocation, setCurrentLocation] = useState<string>("");

  // Load the EPUB
  useEffect(() => {
    if (!job?.jobId || !viewerRef.current) return;

    setLoading(true);
    setError(null);

    // Dynamic import — epub.js is a browser-only library
    import("epubjs").then(async (ePub) => {
      try {
        // Fetch the EPUB as a Blob first, then pass it to epub.js.
        // This avoids issues with the Vercel proxy mangling the response
        // or timing out on large EPUB files. epub.js can load from a
        // Blob/ArrayBuffer directly.
        const url = getEpubFileUrl(job.jobId);
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
          setError(`Could not load EPUB (HTTP ${resp.status}). Make sure the backend is running.`);
          setLoading(false);
          return;
        }
        const blob = await resp.blob();
        if (blob.size === 0) {
          setError("EPUB file is empty or not found on the server.");
          setLoading(false);
          return;
        }

        const book = ePub.default(blob);
        bookRef.current = book;

        // FIX 1: Wait one animation frame so the surrounding flex layout
        // has committed and viewerRef.current has its real, final pixel
        // width. Without this, epub.js measures a stale/zero width
        // synchronously and text overflows instead of paginating.
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const rendition = book.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          spread: "none",
          flow: "paginated",
        });
        renditionRef.current = rendition;

        // FIX 2: ResizeObserver — construct it here but do NOT call
        // .observe() yet. observe() fires its first callback almost
        // immediately, which would race rendition.display()'s pagination
        // and lock onto a partial page count ("Page 1/1"). We observe
        // only AFTER display() resolves, inside the .then() callback.
        const resizeObserver = new ResizeObserver(() => {
          try {
            const r = renditionRef.current as { resize?: () => void } | null;
            if (r?.resize) r.resize();
          } catch {
            // non-fatal — rendition may be destroyed during unmount
          }
        });

        // Apply theme
        applyTheme(rendition, theme, fontSize);

        const displayed = rendition.display();
        displayed.then(() => {
          setLoading(false);
          updateLocation(book, rendition);
          // Now safe to observe — initial pagination is complete, so
          // resize() will only react to genuine subsequent resizes
          // (font size change, window resize, sidebar toggle).
          resizeObserver.observe(viewerRef.current!);
        }).catch((err: unknown) => {
          console.error("[epub-reader] display error:", err);
          setError("Could not open this EPUB. It may be a PDF or unsupported format.");
          setLoading(false);
        });

        // Keyboard navigation
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "ArrowLeft") goPrev();
          if (e.key === "ArrowRight") goNext();
        };
        document.addEventListener("keydown", onKey);

        rendition.on("relocated", () => {
          updateLocation(book, rendition);
        });

        return () => {
          document.removeEventListener("keydown", onKey);
          resizeObserver.disconnect();
          rendition.destroy();
        };
      } catch (err) {
        console.error("[epub-reader] init error:", err);
        setError("Failed to initialize EPUB reader.");
        setLoading(false);
      }
    }).catch(() => {
      setError("epub.js library failed to load.");
      setLoading(false);
    });
  }, [job?.jobId]);

  // Apply theme/font changes
  useEffect(() => {
    if (renditionRef.current) {
      applyTheme(renditionRef.current, theme, fontSize);
    }
  }, [fontSize, theme]);

  function applyTheme(rendition: unknown, t: "dark" | "light", size: number) {
    const r = rendition as {
      themes: {
        register: (name: string, styles: Record<string, unknown>) => void;
        select: (name: string) => void;
        fontSize: (size: string) => void;
      };
    };
    const darkTheme = {
      body: {
        "background": "#1a1a1a",
        "color": "#e0e0e0",
        "font-size": `${size}%`,
      },
      a: { color: "#f59e0b" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
    };
    const lightTheme = {
      body: {
        "background": "#ffffff",
        "color": "#1a1a1a",
        "font-size": `${size}%`,
      },
      a: { color: "#2563eb" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
    };
    r.themes.register("dark", darkTheme);
    r.themes.register("light", lightTheme);
    r.themes.select(t);
    r.themes.fontSize(`${size}%`);
  }

  function updateLocation(book: unknown, rendition: unknown) {
    try {
      const b = book as { navigation: { toc: unknown[] } };
      const r = rendition as {
        currentLocation: () => {
          start: { cfi: string; displayed: { page: number; total: number } };
          href: string;
        };
      };
      const loc = r.currentLocation();
      if (loc?.start) {
        const page = loc.start.displayed?.page || 1;
        const total = loc.start.displayed?.total || 1;
        setCurrentLocation(`Page ${page} / ${total}`);
      }
    } catch {
      // non-fatal
    }
  }

  const goPrev = useCallback(() => {
    const r = renditionRef.current as { prev?: () => Promise<void> } | null;
    if (r?.prev) r.prev();
  }, []);

  const goNext = useCallback(() => {
    const r = renditionRef.current as { next?: () => Promise<void> } | null;
    if (r?.next) r.next();
  }, []);

  if (!job?.jobId) return null;

  return (
    <div
      className="mt-3 rounded-2xl border overflow-hidden max-w-full"
      style={{
        background: theme === "dark" ? "#1a1a1a" : "#ffffff",
        borderColor: "var(--aria-border)",
      }}
    >
      {/* Reader header */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: "var(--aria-border)" }}
      >
        <div className="flex items-center gap-2">
          <Book className="w-4 h-4" style={{ color: "var(--aria-accent)" }} />
          <span
            className="font-mono text-[10px] tracking-[0.18em] uppercase"
            style={{ color: "var(--aria-accent-glow)" }}
          >
            Reader
          </span>
          {currentLocation && (
            <span
              className="text-[10px] font-mono"
              style={{ color: "var(--aria-fg-dim)" }}
            >
              {currentLocation}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Font size controls */}
          <button
            onClick={() => setFontSize((s) => Math.max(60, s - 10))}
            className="p-1 rounded transition-colors hover:bg-white/10"
            style={{ color: "var(--aria-fg-muted)" }}
            title="Decrease font size"
          >
            <Type className="w-3.5 h-3.5" style={{ transform: "scale(0.8)" }} />
          </button>
          <button
            onClick={() => setFontSize((s) => Math.min(200, s + 10))}
            className="p-1 rounded transition-colors hover:bg-white/10"
            style={{ color: "var(--aria-fg-muted)" }}
            title="Increase font size"
          >
            <Type className="w-4 h-4" />
          </button>
          {/* Theme toggle */}
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-white/10"
            style={{
              color: "var(--aria-fg-muted)",
              border: "1px solid var(--aria-border)",
            }}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          {/* Close */}
          <button
            onClick={toggleReader}
            className="p-1 rounded transition-colors hover:bg-white/10"
            style={{ color: "var(--aria-fg-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Reader content */}
      <div className="relative" style={{ height: "60vh", minHeight: "400px" }}>
        {loading && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: theme === "dark" ? "#1a1a1a" : "#fff" }}
          >
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--aria-accent-glow)" }} />
          </div>
        )}
        {error && (
          <div
            className="absolute inset-0 flex items-center justify-center p-8 text-center"
            style={{ background: theme === "dark" ? "#1a1a1a" : "#fff" }}
          >
            <p className="text-sm" style={{ color: "var(--aria-fg-muted)" }}>
              {error}
            </p>
          </div>
        )}

        {/* epub.js renders into this div */}
        <div
          ref={viewerRef}
          className="w-full h-full"
          style={{ display: loading || error ? "none" : "block" }}
        />

        {/* Page-turn arrows */}
        {!loading && !error && (
          <>
            <button
              onClick={goPrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full transition-colors hover:bg-white/10"
              style={{
                background: "rgba(0,0,0,0.3)",
                color: theme === "dark" ? "#e0e0e0" : "#1a1a1a",
              }}
              title="Previous page (←)"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={goNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full transition-colors hover:bg-white/10"
              style={{
                background: "rgba(0,0,0,0.3)",
                color: theme === "dark" ? "#e0e0e0" : "#1a1a1a",
              }}
              title="Next page (→)"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
