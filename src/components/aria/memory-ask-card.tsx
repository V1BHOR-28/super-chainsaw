'use client'

import { useState } from 'react'
import { Brain, Check, X, Pencil, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'

export type MemoryCandidate = {
  text: string
  category: string
  confidence: 'high' | 'medium'
}

type Props = {
  candidate: MemoryCandidate
  /** Called after the user resolves the card (save or skip) */
  onResolved: () => void
}

const CATEGORIES = ['general', 'personal', 'preference', 'goal', 'fact'] as const

/**
 * MemoryAskCard — renders below ARIA's reply when the detection engine found
 * a medium-confidence memory candidate. The user can Save, Skip, or Edit
 * before saving. Every resolution is logged via /api/memory/decision so ARIA
 * learns the user's saving pattern over time.
 */
export function MemoryAskCard({ candidate, onResolved }: Props) {
  const upsertMemory = useAriaStore((s) => s.upsertMemory)
  const [text, setText] = useState(candidate.text)
  const [category, setCategory] = useState(candidate.category)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'save' | 'skip' | null>(null)

  const logDecision = async (accepted: boolean) => {
    try {
      await fetch('/api/memory/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateText: candidate.text,
          category: candidate.category,
          accepted,
        }),
      })
    } catch {
      /* silent — logging is best-effort */
    }
  }

  const handleSave = async () => {
    setBusy('save')
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text.trim(), category }),
      })
      if (res.status === 409) {
        const data = await res.json()
        toast.info(`Already in memory: "${data.existing?.content?.slice(0, 60)}..."`)
        await logDecision(false) // count dup as a skip
        onResolved()
        return
      }
      if (!res.ok) throw new Error('save failed')
      const data = await res.json()
      upsertMemory(data.memory)
      await logDecision(true)
      toast.success('ARIA will remember that')
      onResolved()
    } catch {
      toast.error('Could not save memory')
    } finally {
      setBusy(null)
    }
  }

  const handleSkip = async () => {
    setBusy('skip')
    await logDecision(false)
    onResolved()
  }

  return (
    <div
      className="max-w-[720px] w-full mx-auto mt-2 aria-fade-slide rounded-2xl p-3.5"
      style={{
        background: 'rgba(22, 18, 16, 0.5)',
        border: '1px dashed rgba(245, 158, 11, 0.25)',
      }}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
          style={{
            background: 'rgba(245, 158, 11, 0.1)',
            color: 'var(--aria-accent-glow)',
          }}
        >
          <Brain size={13} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="m-0 mb-1 text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--aria-accent-glow)' }}
          >
            ARIA noticed something worth keeping
          </p>

          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                autoFocus
                className="resize-none rounded-lg px-3 py-2 text-[13px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
                style={{
                  background: 'var(--aria-bg-panel)',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg)',
                  fontFamily: 'inherit',
                }}
              />
              <div className="flex items-center gap-2">
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--aria-fg-dim)' }}
                >
                  Category
                </span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="rounded-md px-2 py-1 text-[12px] outline-none"
                  style={{
                    background: 'var(--aria-bg-panel)',
                    border: '1px solid var(--aria-border)',
                    color: 'var(--aria-fg)',
                    fontFamily: 'inherit',
                  }}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c} style={{ background: 'var(--aria-bg-panel)' }}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <p
              className="m-0 text-[13px] leading-relaxed"
              style={{ color: 'var(--aria-fg)' }}
            >
              "{text}"
            </p>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={handleSave}
                  disabled={busy !== null || !text.trim()}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    background: 'var(--aria-accent)',
                    color: 'var(--aria-bg)',
                    border: '1px solid var(--aria-accent)',
                  }}
                >
                  {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Save
                </button>
                <button
                  onClick={() => {
                    setText(candidate.text)
                    setCategory(candidate.category)
                    setEditing(false)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors"
                  style={{
                    background: 'transparent',
                    color: 'var(--aria-fg-muted)',
                    border: '1px solid var(--aria-border)',
                  }}
                >
                  Cancel edit
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    background: 'var(--aria-accent)',
                    color: 'var(--aria-bg)',
                    border: '1px solid var(--aria-accent)',
                  }}
                >
                  {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Save
                </button>
                <button
                  onClick={handleSkip}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--aria-fg-muted)',
                    border: '1px solid var(--aria-border)',
                  }}
                >
                  {busy === 'skip' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                  Not now
                </button>
                <button
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color: 'var(--aria-fg-muted)',
                    border: '1px solid var(--aria-border)',
                  }}
                >
                  <Pencil size={12} />
                  Edit
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default MemoryAskCard
