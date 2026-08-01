'use client'

import { useEffect, useRef, useState } from 'react'
import { isPast, differenceInCalendarDays } from 'date-fns'
import {
  Plus,
  Star,
  Trash2,
  Sun,
  Smile,
  Meh,
  Frown,
  CloudRain,
  CheckCircle2,
  Circle,
  Loader2,
  Pencil,
  Check,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'
import { clusterMemories } from '@/lib/cluster-memories'
import type { Memory, Mood, Reminder } from '@/lib/types'

/* ============================================================
   Shared panel chrome
   ============================================================ */

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4 px-1">
      <h2
        className="font-serif-aria"
        style={{ fontSize: '28px', lineHeight: 1.1, color: 'var(--aria-fg)' }}
      >
        {title}
      </h2>
      <p
        className="mt-1 text-[13px]"
        style={{ color: 'var(--aria-fg-muted)' }}
      >
        {subtitle}
      </p>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center rounded-xl px-4 py-10 text-center text-[13px]"
      style={{
        color: 'var(--aria-fg-dim)',
        background: 'var(--aria-card)',
        border: '1px dashed var(--aria-border)',
      }}
    >
      <p className="m-0 max-w-[260px]">{children}</p>
    </div>
  )
}

function SmallInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`flex-1 rounded-lg px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--aria-fg-dim)] focus:border-[rgba(245,158,11,0.45)] ${props.className ?? ''}`}
      style={{
        background: 'var(--aria-bg-panel)',
        border: '1px solid var(--aria-border)',
        color: 'var(--aria-fg)',
        fontFamily: 'inherit',
        minWidth: 0,
        ...(props.style || {}),
      }}
    />
  )
}

function AddButton({
  onClick,
  disabled,
  loading,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
      style={{
        background: disabled || loading ? 'var(--aria-bg-panel)' : 'var(--aria-accent)',
        color: disabled || loading ? 'var(--aria-fg-dim)' : 'var(--aria-bg)',
        border: '1px solid var(--aria-border)',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
      }}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Plus size={14} />
      )}
      {children}
    </button>
  )
}

function IconButton({
  onClick,
  title,
  children,
  danger,
  active,
  confirming,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
  active?: boolean
  confirming?: boolean
}) {
  // `confirming` renders the button in an armed delete-confirm state:
  // red icon, red border, tinted red background — distinct from the
  // default dim trash icon so the user knows a second click will fire.
  const baseColor = confirming
    ? '#ef4444'
    : active
      ? 'var(--aria-accent-glow)'
      : 'var(--aria-fg-dim)'
  const isDanger = danger || confirming
  return (
    <button
      onClick={onClick}
      aria-label={title}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      style={{
        color: baseColor,
        background: confirming ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
        border: confirming ? '1px solid #ef4444' : '1px solid transparent',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = isDanger ? '#ef4444' : 'var(--aria-accent-glow)'
        e.currentTarget.style.background = confirming
          ? 'rgba(239, 68, 68, 0.18)'
          : 'var(--aria-card)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = baseColor
        e.currentTarget.style.background = confirming ? 'rgba(239, 68, 68, 0.12)' : 'transparent'
      }}
    >
      {children}
    </button>
  )
}

/* ============================================================
   MEMORY PANEL
   ============================================================ */

export function MemoryPanel() {
  const memories = useAriaStore((s) => s.memories)
  const setMemories = useAriaStore((s) => s.setMemories)
  const upsertMemory = useAriaStore((s) => s.upsertMemory)
  const removeMemory = useAriaStore((s) => s.removeMemory)

  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/memory')
        if (!res.ok) throw new Error('fetch failed')
        const data = (await res.json()) as { memories?: Memory[]; nextCursor?: string | null }
        if (cancelled) return
        if (data.memories) setMemories(data.memories)
        setNextCursor(data.nextCursor ?? null)
      } catch {
        if (!cancelled) toast.error('Could not load memories')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setMemories])

  const handleLoadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/memory?cursor=${nextCursor}`)
      const data = await res.json()
      if (data.memories) setMemories([...memories, ...data.memories])
      setNextCursor(data.nextCursor ?? null)
    } catch {
      toast.error('Could not load more memories')
    } finally {
      setLoadingMore(false)
    }
  }

  const handleAdd = async () => {
    const trimmed = content.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed, category: 'general' }),
      })

      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        toast(
          data.existing?.content
            ? `ARIA already knows this: "${data.existing.content}"`
            : 'ARIA already remembers something like this.'
        )
        return
      }

      if (!res.ok) throw new Error('create failed')
      const data = (await res.json()) as { memory: Memory }
      upsertMemory(data.memory)
      setContent('')
      toast.success('Memory saved')
      inputRef.current?.focus()
    } catch {
      toast.error('Could not save memory')
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (m: Memory) => {
    setEditingId(m.id)
    setEditValue(m.content)
  }

  const handleSaveEdit = async (m: Memory) => {
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === m.content) {
      setEditingId(null)
      return
    }
    const prev = m
    upsertMemory({ ...m, content: trimmed })
    setEditingId(null)
    try {
      const res = await fetch(`/api/memory/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed }),
      })
      if (!res.ok) throw new Error('edit failed')
      toast.success('Memory updated')
    } catch {
      upsertMemory(prev)
      toast.error('Could not update memory')
    }
  }

  const handlePin = async (m: Memory) => {
    // Optimistic update
    upsertMemory({ ...m, pinned: !m.pinned })
    try {
      const res = await fetch(`/api/memory/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !m.pinned }),
      })
      if (!res.ok) throw new Error('patch failed')
    } catch {
      // Rollback
      upsertMemory(m)
      toast.error('Could not update memory')
    }
  }

  const handleDelete = async (id: string) => {
    // Optimistic
    const prev = memories
    removeMemory(id)
    try {
      const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
      toast.success('Memory removed')
    } catch {
      setMemories(prev)
      toast.error('Could not delete memory')
    }
  }

  // Two-step delete confirmation: first click arms the trash icon into a
  // red "Confirm?" state; the second click fires the actual delete.
  // Auto-resets after 3s, or on any click outside the confirming button.
  const requestDelete = (id: string) => {
    setConfirmDeleteId(id)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000)
  }

  const confirmDelete = (id: string) => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setConfirmDeleteId(null)
    void handleDelete(id)
  }

  useEffect(() => {
    if (!confirmDeleteId) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-confirm-trash]')) return
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
      setConfirmDeleteId(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [confirmDeleteId])

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  return (
    <div className="aria-fade-slide flex flex-1 min-h-0 flex-col">
      <PanelHeader
        title="Memory"
        subtitle="What ARIA remembers about you."
      />

      <div className="mb-4 flex gap-2 px-1">
        <SmallInput
          ref={inputRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAdd()
            }
          }}
          placeholder="Add something ARIA should remember..."
        />
        <AddButton onClick={handleAdd} disabled={!content.trim()} loading={creating}>
          Add
        </AddButton>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-1"
        style={{ paddingBottom: '8px' }}
      >
        {!loaded ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--aria-fg-dim)' }} />
          </div>
        ) : memories.length === 0 ? (
          <EmptyState>
            ARIA doesn&apos;t know you yet. Add something she should remember.
          </EmptyState>
        ) : (
          <>
          {Object.entries(clusterMemories(memories)).map(([category, items]) => (
            <div key={category} className="mb-4">
              <h4
                className="mb-2 text-[11px] uppercase tracking-wider"
                style={{ color: 'var(--aria-fg-dim)' }}
              >
                {category} ({items.length})
              </h4>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {items.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-xl p-3"
                    style={{
                      background: 'var(--aria-card)',
                      border: '1px solid var(--aria-border)',
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      {editingId === m.id ? (
                        <textarea
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              handleSaveEdit(m)
                            } else if (e.key === 'Escape') {
                              setEditingId(null)
                            }
                          }}
                          rows={2}
                          className="m-0 w-full resize-none rounded-md p-2 text-[13px] leading-relaxed outline-none"
                          style={{
                            color: 'var(--aria-fg)',
                            background: 'var(--aria-bg-panel)',
                            border: '1px solid var(--aria-accent)',
                          }}
                        />
                      ) : (
                        <p
                          className="m-0 text-[13px] leading-relaxed"
                          style={{ color: 'var(--aria-fg)' }}
                        >
                          {m.content}
                        </p>
                      )}
                      <div className="flex shrink-0 items-center gap-0.5">
                        {editingId === m.id ? (
                          <IconButton
                            onClick={() => handleSaveEdit(m)}
                            title="Save"
                            active
                          >
                            <Check size={14} />
                          </IconButton>
                        ) : (
                          <IconButton
                            onClick={() => startEdit(m)}
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </IconButton>
                        )}
                        <IconButton
                          onClick={() => handlePin(m)}
                          title={m.pinned ? 'Unpin' : 'Pin'}
                          active={m.pinned}
                        >
                          <Star
                            size={14}
                            fill={m.pinned ? 'currentColor' : 'none'}
                          />
                        </IconButton>
                        {confirmDeleteId === m.id ? (
                          <span className="contents" data-confirm-trash>
                            <IconButton
                              onClick={() => confirmDelete(m.id)}
                              title="Confirm delete?"
                              danger
                              confirming
                            >
                              <Check size={14} />
                            </IconButton>
                          </span>
                        ) : (
                          <IconButton
                            onClick={() => requestDelete(m.id)}
                            title="Delete"
                            danger
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {m.pinned && (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--aria-fg-dim)' }}
                        >
                          · pinned
                        </span>
                      )}
                      {m.source === 'auto' && (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--aria-fg-dim)' }}
                        >
                          · auto-detected
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {nextCursor && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="mt-3 w-full rounded-lg py-2 text-[12px] transition-colors"
              style={{
                color: 'var(--aria-fg-muted)',
                background: 'var(--aria-card)',
                border: '1px solid var(--aria-border)',
              }}
            >
              {loadingMore ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={13} className="animate-spin" /> Loading...
                </span>
              ) : (
                'Load more'
              )}
            </button>
          )}
          </>
        )}
      </div>
    </div>
  )
}

/* ============================================================
   MOOD PANEL
   ============================================================ */

type MoodKey = Mood['mood']

const MOODS: {
  key: MoodKey
  label: string
  icon: typeof Sun
  color: string
}[] = [
  { key: 'great', label: 'Great', icon: Sun, color: 'var(--aria-accent-glow)' },
  { key: 'good', label: 'Good', icon: Smile, color: 'var(--aria-accent-bright)' },
  { key: 'okay', label: 'Okay', icon: Meh, color: 'var(--aria-fg-muted)' },
  { key: 'low', label: 'Low', icon: Frown, color: 'var(--aria-accent-deep)' },
  { key: 'rough', label: 'Rough', icon: CloudRain, color: 'var(--aria-fg-dim)' },
]

function MoodPanel() {
  const moods = useAriaStore((s) => s.moods)
  const setMoods = useAriaStore((s) => s.setMoods)
  const prependMood = useAriaStore((s) => s.prependMood)
  const user = useAriaStore((s) => s.user)

  const [savingKey, setSavingKey] = useState<MoodKey | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/mood')
        if (!res.ok) throw new Error('fetch failed')
        const data = (await res.json()) as { moods?: Mood[] }
        if (cancelled) return
        if (data.moods) setMoods(data.moods.slice(0, 1))
      } catch {
        /* silent — this is just for the active-chip highlight, not critical */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setMoods])

  // Click a chip = instant save. No separate Save button.
  // The mood is persisted immediately so ARIA can read it on the next message.
  const handleSelect = async (mood: MoodKey) => {
    setSavingKey(mood)
    try {
      const res = await fetch('/api/mood', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood }),
      })
      if (!res.ok) throw new Error('create failed')
      const data = (await res.json()) as { mood: Mood }
      prependMood(data.mood)
      toast.success(`Mood logged — ARIA will meet you there`)
    } catch {
      toast.error('Could not save mood')
    } finally {
      setSavingKey(null)
    }
  }

  const name = user?.name || 'friend'
  const latestMood = moods[0]?.mood

  return (
    <div className="aria-fade-slide flex flex-1 min-h-0 flex-col">
      <PanelHeader title="Mood" subtitle={`How are you today, ${name}?`} />

      {/* Mood chips — click = instant save */}
      <div className="mb-2 flex flex-wrap gap-2 px-1">
        {MOODS.map((m) => {
          const Icon = m.icon
          const isActive = latestMood === m.key
          const isSaving = savingKey === m.key
          return (
            <button
              key={m.key}
              onClick={() => handleSelect(m.key)}
              disabled={isSaving}
              className={`aria-mood-chip ${isActive ? 'active' : ''} flex flex-1 flex-col items-center gap-1.5 rounded-xl px-2 py-3 transition-colors`}
              style={{
                background: 'var(--aria-card)',
                border: '1px solid var(--aria-border)',
                color: isActive ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                minWidth: '60px',
                cursor: isSaving ? 'wait' : 'pointer',
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              {isSaving ? (
                <Loader2 size={20} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--aria-accent-glow)' }} />
              ) : (
                <Icon
                  size={20}
                  strokeWidth={1.5}
                  style={{ color: isActive ? 'var(--aria-accent-glow)' : m.color }}
                />
              )}
              <span className="text-[11px]">{m.label}</span>
            </button>
          )
        })}
      </div>

      <p
        className="m-0 mb-3 px-1 text-[11px] leading-relaxed"
        style={{ color: 'var(--aria-fg-dim)' }}
      >
        Tap a mood — ARIA reads it instantly.
      </p>
    </div>
  )
}

/* ============================================================
   REMINDERS PANEL
   ============================================================ */

function formatDueLabel(dueAt: string): string {
  const due = new Date(dueAt)
  const days = differenceInCalendarDays(due, new Date())
  if (isPast(due)) {
    if (days === 0) return 'Overdue today'
    return `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
  }
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

function RemindersPanel() {
  const reminders = useAriaStore((s) => s.reminders)
  const setReminders = useAriaStore((s) => s.setReminders)
  const upsertReminder = useAriaStore((s) => s.upsertReminder)
  const removeReminder = useAriaStore((s) => s.removeReminder)

  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/reminders')
        if (!res.ok) throw new Error('fetch failed')
        const data = (await res.json()) as { reminders?: Reminder[] }
        if (cancelled) return
        if (data.reminders) setReminders(data.reminders)
      } catch {
        if (!cancelled) toast.error('Could not load reminders')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setReminders])

  const handleAdd = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const payload: { title: string; dueAt?: string } = { title: trimmed }
      if (dueAt) payload.dueAt = new Date(dueAt).toISOString()
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('create failed')
      const data = (await res.json()) as { reminder: Reminder }
      upsertReminder(data.reminder)
      setTitle('')
      setDueAt('')
      toast.success('Reminder added')
    } catch {
      toast.error('Could not add reminder')
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (r: Reminder) => {
    const next: Reminder = {
      ...r,
      completed: !r.completed,
      completedAt: !r.completed ? new Date().toISOString() : null,
    }
    upsertReminder(next)
    try {
      const res = await fetch(`/api/reminders/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: !r.completed }),
      })
      if (!res.ok) throw new Error('patch failed')
    } catch {
      upsertReminder(r)
      toast.error('Could not update reminder')
    }
  }

  const handleDelete = async (id: string) => {
    const prev = reminders
    removeReminder(id)
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
      toast.success('Reminder removed')
    } catch {
      setReminders(prev)
      toast.error('Could not delete reminder')
    }
  }

  // Two-step delete confirmation: first click arms the trash icon into a
  // red "Confirm?" state; the second click fires the actual delete.
  // Auto-resets after 3s, or on any click outside the confirming button.
  const requestDelete = (id: string) => {
    setConfirmDeleteId(id)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000)
  }

  const confirmDelete = (id: string) => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setConfirmDeleteId(null)
    void handleDelete(id)
  }

  useEffect(() => {
    if (!confirmDeleteId) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-confirm-trash]')) return
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
      setConfirmDeleteId(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [confirmDeleteId])

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  return (
    <div className="aria-fade-slide flex flex-1 min-h-0 flex-col">
      <PanelHeader title="Reminders" subtitle="Things ARIA is holding you to." />

      <div className="mb-4 flex flex-col gap-2 px-1">
        <div className="flex gap-2">
          <SmallInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAdd()
              }
            }}
            placeholder="Remind me to..."
          />
          <AddButton onClick={handleAdd} disabled={!title.trim()} loading={creating}>
            Add
          </AddButton>
        </div>
        <input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="rounded-lg px-3 py-2 text-[12px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
          style={{
            background: 'var(--aria-bg-panel)',
            border: '1px solid var(--aria-border)',
            color: 'var(--aria-fg)',
            fontFamily: 'inherit',
            colorScheme: 'dark',
          }}
          aria-label="Optional due date"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {!loaded ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--aria-fg-dim)' }} />
          </div>
        ) : reminders.length === 0 ? (
          <EmptyState>Nothing on your plate. Add a reminder.</EmptyState>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {reminders.map((r) => {
              const overdue =
                !r.completed && r.dueAt && isPast(new Date(r.dueAt))
              return (
                <li
                  key={r.id}
                  className="flex items-start gap-2.5 rounded-xl p-3"
                  style={{
                    background: 'var(--aria-card)',
                    border: '1px solid var(--aria-border)',
                    opacity: r.completed ? 0.6 : 1,
                  }}
                >
                  <button
                    onClick={() => handleToggle(r)}
                    aria-label={r.completed ? 'Mark as not done' : 'Mark as done'}
                    className="mt-0.5 shrink-0 transition-colors"
                    style={{
                      color: r.completed
                        ? 'var(--aria-accent-glow)'
                        : 'var(--aria-fg-dim)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {r.completed ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <Circle size={18} />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p
                      className="m-0 text-[13px] leading-snug"
                      style={{
                        color: r.completed
                          ? 'var(--aria-fg-muted)'
                          : 'var(--aria-fg)',
                        textDecoration: r.completed ? 'line-through' : 'none',
                      }}
                    >
                      {r.title}
                    </p>
                    {r.dueAt && (
                      <p
                        className="m-0 mt-1 text-[11px]"
                        style={{
                          color: overdue ? '#ef4444' : 'var(--aria-fg-dim)',
                        }}
                      >
                        {formatDueLabel(r.dueAt)}
                      </p>
                    )}
                  </div>
                  {confirmDeleteId === r.id ? (
                    <span className="contents" data-confirm-trash>
                      <IconButton
                        onClick={() => confirmDelete(r.id)}
                        title="Confirm delete?"
                        danger
                        confirming
                      >
                        <Check size={13} />
                      </IconButton>
                    </span>
                  ) : (
                    <IconButton
                      onClick={() => requestDelete(r.id)}
                      title="Delete"
                      danger
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/* ============================================================
   ROOT: switch on activePanel
   ============================================================ */

export function SidePanels() {
  const activePanel = useAriaStore((s) => s.activePanel)

  if (activePanel === 'conversations') return null
  if (activePanel === 'mood') return <MoodPanel />
  if (activePanel === 'reminders') return <RemindersPanel />
  return null
}

export default SidePanels
