'use client'

import { useEffect } from 'react'
import { Zap } from 'lucide-react'
import { useAriaStore } from '@/lib/store'

/**
 * UsageMeter — a compact daily token budget widget.
 * Sits in the sidebar above the user profile.
 * Shows: tokens used today / daily limit, a progress bar, and resets-in time.
 */
export function UsageMeter() {
  const { usage, setUsage } = useAriaStore()

  // Fetch usage on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/usage')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data.usage) setUsage(data.usage)
      } catch {
        /* silent */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setUsage])

  if (!usage) return null

  const pct = Math.min(100, Math.round((usage.tokensUsed / usage.dailyLimit) * 100))
  const remaining = Math.max(0, usage.dailyLimit - usage.tokensUsed)
  const isLow = remaining < usage.dailyLimit * 0.1 // under 10% left

  // Format tokens as "12.4k" / "1.2M"
  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  // Resets-in label
  const resetsIn = (() => {
    const now = new Date()
    const reset = new Date(usage.resetsAt)
    const hours = Math.ceil((reset.getTime() - now.getTime()) / (1000 * 60 * 60))
    if (hours <= 1) return 'resets in <1h'
    return `resets in ${hours}h`
  })()

  // Bar color: amber normally, red-ish when low
  const barColor = isLow ? '#ef4444' : 'var(--aria-accent)'
  const barGlow = isLow ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.4)'

  return (
    <div
      className="mb-3 rounded-xl p-3"
      style={{
        background: 'var(--aria-card)',
        border: '1px solid var(--aria-border)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Zap size={12} style={{ color: barColor }} fill={isLow ? 'currentColor' : 'none'} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--aria-fg-muted)' }}>
            Daily session
          </span>
        </div>
        <span className="text-[10px]" style={{ color: 'var(--aria-fg-dim)' }}>
          {resetsIn}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-1.5 rounded-full overflow-hidden mb-2"
        style={{ background: 'rgba(252,211,77,0.08)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: barColor,
            boxShadow: `0 0 8px ${barGlow}`,
          }}
        />
      </div>

      {/* Numbers */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono-aria" style={{ color: 'var(--aria-fg)' }}>
          {fmt(usage.tokensUsed)}
          <span style={{ color: 'var(--aria-fg-dim)' }}> / {fmt(usage.dailyLimit)}</span>
        </span>
        <span
          className="text-[10px]"
          style={{ color: isLow ? '#ef4444' : 'var(--aria-fg-dim)' }}
        >
          {isLow ? `${fmt(remaining)} left` : `${pct}% used`}
        </span>
      </div>
    </div>
  )
}
