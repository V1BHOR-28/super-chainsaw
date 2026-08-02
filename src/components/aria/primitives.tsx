"use client";

import { cn } from "@/lib/utils";

/**
 * Ambient background glow — large blurred circle of color.
 * Place inside a relative container.
 */
export function AmbientGlow({
  color = "#f59e0b",
  opacity = 0.2,
  size = 600,
  className,
  style,
}: {
  color?: string;
  opacity?: number;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("ambient-glow", className)}
      style={{
        width: size,
        height: size,
        background: color,
        opacity,
        ...style,
      }}
      aria-hidden
    />
  );
}

/**
 * Gradient-text label (italic serif gold).
 */
export function GradientText({
  children,
  className,
  as: Tag = "span",
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
}) {
  return <Tag className={cn("gradient-text", className)}>{children}</Tag>;
}

/**
 * Status pill with pulsing gold dot.
 */
export function StatusPill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("status-pill", className)}>
      <span className="status-dot" />
      {children}
    </span>
  );
}

/**
 * Typing dots indicator.
 */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-label="thinking">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}

/**
 * Horizontal divider with soft fade edges.
 */
export function AriaDivider({ className }: { className?: string }) {
  return <div className={cn("aria-divider", className)} />;
}
