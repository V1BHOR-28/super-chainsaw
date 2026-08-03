"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface WaveformProps {
  bars?: number;
  active?: boolean;
  className?: string;
  barClassName?: string;
  minHeight?: number;
  maxHeight?: number;
  barWidth?: number;
  gap?: number;
}

/**
 * Animated audio waveform — vertical gold bars with staggered animation.
 * Pauses (freezes) when `active` is false.
 */
export function Waveform({
  bars = 6,
  active = true,
  className,
  barClassName,
  minHeight = 6,
  maxHeight = 22,
  barWidth = 3,
  gap = 3,
}: WaveformProps) {
  return (
    <div
      className={cn("flex items-end", className)}
      style={{ gap, height: maxHeight }}
      aria-hidden
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn("wave-bar", !active && "paused", barClassName)}
          style={{
            width: barWidth,
            animationDelay: `${i * 0.1}s`,
            animationPlayState: active ? "running" : "paused",
            height: active ? undefined : minHeight,
            minHeight,
          }}
        />
      ))}
    </div>
  );
}

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

/**
 * Full-width decorative waveform that generates pseudo-random bar heights
 * and gently animates. Used behind the player as atmosphere.
 */
export function DecorativeWaveform({
  bars = 64,
  active = true,
  className,
  seed = 1,
  height,
}: {
  bars?: number;
  active?: boolean;
  className?: string;
  seed?: number;
  height?: number;
}) {
  const heights = useMemo(() => {
    const arr: number[] = [];
    let s = seed;
    for (let i = 0; i < bars; i++) {
      s = (s * 9301 + 49297) % 233280;
      const r = s / 233280;
      const env = Math.sin((i / bars) * Math.PI);
      arr.push(0.2 + r * 0.8 * env);
    }
    return arr;
  }, [bars, seed]);

  return (
    <div
      className={cn("flex items-center justify-between gap-[2px]", className)}
      style={height ? { height } : undefined}
      aria-hidden
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className="wave-bar"
          style={{
            width: 2,
            height: `${h * 100}%`,
            minHeight: 4,
            animationDelay: `${(i % 8) * 0.08}s`,
            animationDuration: `${0.9 + (i % 5) * 0.12}s`,
            animationPlayState: active ? "running" : "paused",
            opacity: 0.4 + h * 0.6,
          }}
        />
      ))}
    </div>
  );
}
