"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Book, X, Type, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { usePlayerStore } from "@/lib/player-store";
import { getEpubFileUrl } from "@/lib/abm-api";

/**
 * EpubReader — in-browser EPUB reader using foliate-js.
 *
 * foliate-js uses a custom HTML element (<foliate-view>) which handles
 * pagination, TOC, themes, and rendering internally via CSS multi-column
 * layout. No React lifecycle timing issues — the web component manages its
 * own lifecycle independently of React.
 *
 * The reader is COMPLETELY INDEPENDENT of audio playback — no listeners
 * on audio position, no auto-advance, no sync.
 */

export function EpubReader() {
  const job = usePlayerStore((s) => s.currentJob);
  const toggleReader = usePlayerStore((s) => s.toggleReader);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [pageInfo, setPageInfo] = useState("");
  const [tocItems, setTocItems] = useState<{ label: string; href: string }[]>(
    [],
  );
  const [showToc, setShowToc] = useState(false);

  // Load foliate-js script + initialize the reader
  useEffect(() => {
    if (!job?.jobId || !containerRef.current) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Load foliate-js view.js (ES module — imports its own dependencies)
    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import '/foliate-js/view.js';
      window.__foliateReady = true;
      window.dispatchEvent(new Event('foliate-ready'));
    `;
    document.head.appendChild(script);

    const init = async () => {
      // Wait for foliate-js to be ready
      if (!window.__foliateReady) {
        await new Promise<void>((resolve) => {
          window.addEventListener("foliate-ready", () => resolve(), {
            once: true,
          });
        });
      }

      if (cancelled) return;

      // Create the <foliate-view> custom element
      const view = document.createElement("foliate-view") as HTMLElement & {
        open: (file: Blob | string) => Promise<void>;
        next: () => void;
        prev: () => void;
        goTo: (href: string) => void;
        renderer: {
          setAppearance: (opts: Record<string, unknown>) => void;
        };
      };
      view.style.width = "100%";
      view.style.height = "100%";
      view.style.border = "none";

      // Apply initial theme
      view.renderer = view.renderer || {};
      try {
        view.renderer.setAppearance({
          theme: theme === "dark" ? "dark" : "light",
        });
      } catch {
        // setAppearance may not exist on all versions — use CSS instead
      }

      containerRef.current!.innerHTML = "";
      containerRef.current!.appendChild(view);
      viewRef.current = view;

      // Listen for relocation (page changes)
      view.addEventListener("relocate", (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.fraction !== undefined) {
          const pct = Math.round(detail.fraction * 100);
          setPageInfo(`${pct}%`);
        }
        if (detail?.tocItem?.label) {
          setPageInfo(`${detail.tocItem.label}`);
        }
      });

      // Fetch the EPUB and open it
      try {
        const url = getEpubFileUrl(job.jobId);
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        if (blob.size === 0) {
          throw new Error("empty file");
        }

        await view.open(blob);
        if (!cancelled) {
          setLoading(false);

          // Try to get TOC
          try {
            const book = (view as unknown as { book?: { toc?: unknown[] } })
              .book;
            if (book?.toc) {
              const toc = book.toc.map((item: unknown) => {
                const i = item as {
                  label: string;
                  href: string;
                  subitems?: unknown[];
                };
                return { label: i.label, href: i.href };
              });
              setTocItems(toc);
            }
          } catch {
            // non-fatal
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? `Could not load EPUB (${err.message}). Make sure the backend is running.`
              : "Could not load EPUB.",
          );
          setLoading(false);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        try {
          (viewRef.current as unknown as { destroy?: () => void }).destroy?.();
        } catch {
          // non-fatal
        }
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
      script.remove();
    };
  }, [job?.jobId]);

  // Apply font size changes
  useEffect(() => {
    if (!containerRef.current) return;
    const iframe = containerRef.current.querySelector("iframe");
    if (iframe?.contentDocument) {
      iframe.contentDocument.documentElement.style.fontSize = `${fontSize}%`;
    }
  }, [fontSize]);

  // Apply theme changes
  useEffect(() => {
    if (!containerRef.current) return;
    const iframe = containerRef.current.querySelector("iframe");
    if (iframe?.contentDocument) {
      const doc = iframe.contentDocument;
      if (theme === "dark") {
        doc.documentElement.style.background = "#1a1a1a";
        doc.documentElement.style.color = "#e0e0e0";
        doc.body.style.background = "#1a1a1a";
        doc.body.style.color = "#e0e0e0";
      } else {
        doc.documentElement.style.background = "#ffffff";
        doc.documentElement.style.color = "#1a1a1a";
        doc.body.style.background = "#ffffff";
        doc.body.style.color = "#1a1a1a";
      }
    }
  }, [theme]);

  const goPrev = useCallback(() => {
    const view = viewRef.current as unknown as { prev?: () => void } | null;
    if (view?.prev) view.prev();
  }, []);

  const goNext = useCallback(() => {
    const view = viewRef.current as unknown as { next?: () => void } | null;
    if (view?.next) view.next();
  }, []);

  const goToChapter = useCallback((href: string) => {
    const view = viewRef.current as unknown as { goTo?: (href: string) => void } | null;
    if (view?.goTo) {
      view.goTo(href);
      setShowToc(false);
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
              className="text-[10px] font-mono truncate max-w-[200px]"
              style={{ color: "var(--aria-fg-dim)" }}
            >
              {pageInfo}
            </span>
          )}
          {tocItems.length > 0 && (
            <button
              onClick={() => setShowToc((s) => !s)}
              className="text-[10px] px-2 py-0.5 rounded transition-colors hover:bg-white/10"
              style={{
                color: "var(--aria-fg-muted)",
                border: "1px solid var(--aria-border)",
              }}
            >
              {showToc ? "Hide" : "Contents"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          <button
            onClick={toggleReader}
            className="p-1 rounded transition-colors hover:bg-white/10"
            style={{ color: "var(--aria-fg-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* TOC sidebar */}
      {showToc && tocItems.length > 0 && (
        <div
          className="max-h-40 overflow-y-auto px-4 py-2 border-b"
          style={{
            borderColor: "var(--aria-border)",
            background: theme === "dark" ? "#111" : "#f5f5f5",
          }}
        >
          {tocItems.map((item, i) => (
            <button
              key={i}
              onClick={() => goToChapter(item.href)}
              className="block w-full text-left text-xs py-1 px-2 rounded transition-colors hover:bg-white/10 truncate"
              style={{ color: "var(--aria-fg-muted)" }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

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

        {/* foliate-js renders into this div */}
        <div
          ref={containerRef}
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
