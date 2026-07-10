'use client'

import { useEffect } from 'react'
import { Zap } from 'lucide-react'
import { useAriaStore } from '@/lib/store'

/**
 * UsageMeter — compact daily token budget pill.
 * Sits in the chat area's top bar (right side).
 * Shows: tokens used / limit + resets-in time.
 */
export function UsageMeter() {
  const { usage, setUsage } = useAriaStore()

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

  // Admin users get unlimited credits — show a special badge instead of the meter.
  const isAdmin = (usage as { isAdmin?: boolean }).isAdmin === true

  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  if (isAdmin) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5"
        style={{
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
        }}
        title="Admin account — unlimited credits. You're the creator, no daily limit."
      >
        <Zap size={11} style={{ color: 'var(--aria-accent-glow)' }} fill="currentColor" />
        <span
          className="text-[10px] font-mono-aria font-semibold"
          style={{ color: 'var(--aria-accent-glow)' }}
        >
          Unlimited
        </span>
      </div>
    )
  }

  const pct = Math.min(100, Math.round((usage.tokensUsed / usage.dailyLimit) * 100))
  const remaining = Math.max(0, usage.dailyLimit - usage.tokensUsed)
  const isLow = remaining < usage.dailyLimit * 0.1

  const resetsIn = (() => {
    const now = new Date()
    const reset = new Date(usage.resetsAt)
    const hours = Math.ceil((reset.getTime() - now.getTime()) / (1000 * 60 * 60))
    if (hours <= 1) return '<1h'
    return `${hours}h`
  })()

  const barColor = isLow ? '#ef4444' : 'var(--aria-accent)'

  return (
    <div
      className="flex items-center gap-2 rounded-full px-3 py-1.5"
      style={{
        background: 'var(--aria-card)',
        border: '1px solid var(--aria-border)',
      }}
      title={`${fmt(usage.tokensUsed)} / ${fmt(usage.dailyLimit)} tokens used today · resets in ${resetsIn}`}
    >
      <Zap size={11} style={{ color: barColor }} fill={isLow ? 'currentColor' : 'none'} />
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ width: 48, background: 'rgba(252,211,77,0.08)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: barColor,
          }}
        />
      </div>
      <span
        className="text-[10px] font-mono-aria"
        style={{ color: isLow ? '#ef4444' : 'var(--aria-fg-muted)' }}
      >
        {pct}%
      </span>
      <span
        className="text-[9px]"
        style={{ color: 'var(--aria-fg-dim)' }}
      >
        {resetsIn}
      </span>
    </div>
  )
}
