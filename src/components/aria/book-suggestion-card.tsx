'use client'

import { useState } from 'react'
import { BookOpen, Sparkles } from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { toast } from 'sonner'
import type { BookSuggestion } from '@/lib/types'

export function BookSuggestionCard({ suggestion }: { suggestion: BookSuggestion }) {
  const setPendingBookSuggestion = useAriaStore((s) => s.setPendingBookSuggestion)
  const [busy, setBusy] = useState<'interest' | 'full' | null>(null)

  const handleBookmarkInterest = async () => {
    setBusy('interest')
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Interested in reading "${suggestion.title}" by ${suggestion.author}`,
          category: 'reading-list',
        }),
      })
      if (!res.ok && res.status !== 409) throw new Error('failed')
      toast.success('Added to your reading interests')
    } catch {
      toast.error('Could not save — try again')
    } finally {
      setPendingBookSuggestion(null)
    }
  }

  const handleAddFullText = async () => {
    if (!suggestion.gutenbergUrl) return
    setBusy('full')
    try {
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: suggestion.gutenbergUrl,
          title: `${suggestion.title} by ${suggestion.author}`,
        }),
      })
      if (!res.ok && res.status !== 409) throw new Error('failed')
      toast.success(`Added "${suggestion.title}" to your library — ARIA can now reference the real text`)
    } catch {
      toast.error('Could not fetch the full text — try again')
    } finally {
      setPendingBookSuggestion(null)
    }
  }

  return (
    <div
      className="mt-2 rounded-xl p-4"
      style={{ background: 'var(--aria-card)', border: '1px solid rgba(245,158,11,0.25)' }}
    >
      <div className="flex items-start gap-2 mb-3">
        <BookOpen size={16} style={{ color: 'var(--aria-accent-glow)' }} className="mt-0.5 flex-shrink-0" />
        <p className="text-sm m-0" style={{ color: 'var(--aria-fg)' }}>
          You mentioned <strong>{suggestion.title}</strong> by {suggestion.author} — want to keep track of it?
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleBookmarkInterest}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{ background: 'var(--aria-accent)', color: 'var(--aria-bg)' }}
        >
          {busy === 'interest' ? 'Saving…' : "I'm interested — remember this"}
        </button>
        {suggestion.canAddFullText && (
          <button
            onClick={handleAddFullText}
            disabled={busy !== null}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
            style={{ border: '1px solid var(--aria-border)', color: 'var(--aria-fg)' }}
          >
            <Sparkles size={12} />
            {busy === 'full' ? 'Fetching…' : 'Add the real text (public domain)'}
          </button>
        )}
        <button
          onClick={() => setPendingBookSuggestion(null)}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--aria-fg-dim)' }}
        >
          Not now
        </button>
      </div>
      {!suggestion.canAddFullText && (
        <p className="text-[11px] mt-2 m-0" style={{ color: 'var(--aria-fg-dim)' }}>
          This one&apos;s still under copyright — if you own a copy, you can feed it to me yourself from the Feed menu.
        </p>
      )}
    </div>
  )
}
