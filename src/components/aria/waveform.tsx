"use client";

import { cn } from "@/lib/utils";

interface NowPlayingBarsProps {
  active?: boolean;
  bars?: number;
  className?: string;
}

/**
 * Compact equalizer-style now-playing indicator.
 */
export function NowPlayingBars({
  active = true,
  bars = 4,
  className,
}: NowPlayingBarsProps) {
  return (
    <div className={cn("flex items-end gap-[2px]", className)} style={{ height: 14 }} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="eq-bar"
          style={{
            animationPlayState: active ? "running" : "paused",
            height: active ? undefined : 4,
          }}
        />
      ))}
    </div>
  );
}
