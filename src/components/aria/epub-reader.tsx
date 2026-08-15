"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Book, X, Type, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { ReactReader } from "react-reader";
import type { Rendition } from "epubjs";
import { usePlayerStore } from "@/lib/player-store";
import { getEpubFileUrl } from "@/lib/abm-api";

/**
 * EpubReader — in-browser EPUB reader using react-reader (epub.js wrapper).
 *
 * Renders the actual book content (real paragraphs, images, styling) in a
 * paginated book-like UI. The reader is COMPLETELY INDEPENDENT of audio
 * playback — no listeners on audio position, no auto-advance, no sync.
 *
 * react-reader handles all the epub.js lifecycle internally:
 * - Proper timing for renderTo() + display() (no race conditions)
 * - Built-in ResizeObserver / window resize handling
 * - Built-in keyboard navigation (←/→)
 * - Built-in TOC sidebar
 * - Built-in loading/error states
 *
 * We add: font size control, light/dark theme, page counter, and
 * fetch the EPUB as a Blob (to avoid Vercel proxy issues with large files).
 */

export function EpubReader() {
  const job = usePlayerStore((s) => s.currentJob);
  const toggleReader = usePlayerStore((s) => s.toggleReader);

  const [location, setLocation] = useState<string | null>(null);
  const [hasFirstLocation, setHasFirstLocation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [epubData, setEpubData] = useState<ArrayBuffer | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const renditionRef = useRef<Rendition | null>(null);
  const [pageInfo, setPageInfo] = useState("");

  // Fetch the EPUB as an ArrayBuffer (avoids Vercel proxy issues)
  useEffect(() => {
    if (!job?.jobId) return;
    let cancelled = false;

    const url = getEpubFileUrl(job.jobId);
    fetch(url, { credentials: "include" })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        if (buf.byteLength === 0) throw new Error("empty file");
        setEpubData(buf);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `Could not load EPUB (${err.message}). Make sure the backend is running.`
            : "Could not load EPUB."
        );
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [job?.jobId]);

  // Apply font size + theme whenever they change
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;

    // Register + apply themes
    const darkTheme = {
      body: { background: "#1a1a1a", color: "#e0e0e0" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
      a: { color: "#f59e0b" },
    };
    const lightTheme = {
      body: { background: "#ffffff", color: "#1a1a1a" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
      a: { color: "#2563eb" },
    };
    rendition.themes.register("dark", darkTheme);
    rendition.themes.register("light", lightTheme);
    rendition.themes.select(theme);
    rendition.themes.fontSize(`${fontSize}%`);
  }, [fontSize, theme]);

  const handleRendition = useCallback((rendition: Rendition) => {
    renditionRef.current = rendition;
    // Apply initial theme
    const darkTheme = {
      body: { background: "#1a1a1a", color: "#e0e0e0" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
      a: { color: "#f59e0b" },
    };
    const lightTheme = {
      body: { background: "#ffffff", color: "#1a1a1a" },
      p: { "font-family": "Georgia, serif", "line-height": "1.8" },
      a: { color: "#2563eb" },
    };
    rendition.themes.register("dark", darkTheme);
    rendition.themes.register("light", lightTheme);
    rendition.themes.select("dark");
    rendition.themes.fontSize("100%");
  }, []);

  const handleLocationChanged = useCallback((loc: string) => {
    setLocation(loc);
    setHasFirstLocation(true);
    // Update page info from the rendition
    const rendition = renditionRef.current;
    if (rendition) {
      try {
        const location = rendition.currentLocation();
        if (location?.start?.displayed) {
          const page = location.start.displayed.page;
          const total = location.start.displayed.total;
          setPageInfo(`Page ${page} / ${total}`);
        }
      } catch {
        // non-fatal
      }
    }
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
          {pageInfo && (
            <span
              className="text-[10px] font-mono"
              style={{ color: "var(--aria-fg-dim)" }}
            >
              {pageInfo}
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
            <Loader2
              className="w-6 h-6 animate-spin"
              style={{ color: "var(--aria-accent-glow)" }}
            />
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
        {epubData && !loading && !error && (
          <ReactReader
            url={epubData}
            location={hasFirstLocation ? location : undefined}
            locationChanged={handleLocationChanged}
            getRendition={handleRendition}
            showToc={true}
            epubOptions={{
              spread: "none",
              flow: "paginated",
            }}
            readerStyles={{
              container: {
                background: theme === "dark" ? "#1a1a1a" : "#ffffff",
                color: theme === "dark" ? "#e0e0e0" : "#1a1a1a",
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
