'use client'

import { useEffect, useState, useRef } from 'react'
import {
  MessageSquare,
  Brain,
  Heart,
  Clock,
  Plus,
  ChevronDown,
  Settings as SettingsIcon,
  LogOut,
  Trash2,
  Pin,
  PinOff,
  Menu,
  Search,
  X,
  FileJson,
  FileText,
  BookOpen,
  Check,
  MoreHorizontal,
} from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { SidePanels } from '@/components/aria/side-panels'
import { toast } from 'sonner'
import type { Conversation } from '@/lib/types'

const TABS = [
  { id: 'conversations' as const, label: 'Conversations', icon: MessageSquare },
  { id: 'memory' as const, label: 'Memory', icon: Brain },
  { id: 'mood' as const, label: 'Mood', icon: Heart },
  { id: 'reminders' as const, label: 'Reminders', icon: Clock },
]

export function Sidebar() {
  const {
    user,
    conversations,
    activeConversationId,
    setActiveConversation,
    activePanel,
    setActivePanel,
    sidebarCollapsed,
    setSidebarCollapsed,
    setSettingsOpen,
    setFeedAriaOpen,
    setMessages,
    removeConversation,
    upsertConversation,
    upsertReminder,
    setSignedOut,
  } = useAriaStore()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  // Close profile dropdown on outside click or Escape
  useEffect(() => {
    if (!dropdownOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [dropdownOpen])

  // Load conversations on mount
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/conversations')
        if (res.ok) {
          const data = await res.json()
          useAriaStore.getState().setConversations(data.conversations)
        }
      } catch (err) {
        console.error('[sidebar.load]', err)
      }
    })()
  }, [])

  const handleNewConversation = async () => {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Conversation' }),
      })
      if (!res.ok) throw new Error('Failed')
      const { conversation } = await res.json()
      useAriaStore.getState().upsertConversation(conversation)
      setActiveConversation(conversation.id)
      setMessages([])
      setActivePanel('conversations')
    } catch (err) {
      console.error(err)
      toast.error('Could not start a new conversation')
    }
  }

  const handleSelectConversation = async (c: Conversation) => {
    setActiveConversation(c.id)
    setActivePanel('conversations')
    try {
      const res = await fetch(`/api/conversations/${c.id}`)
      if (!res.ok) return
      const data = await res.json()
      const msgs = (data.conversation.messages || []).map((m: { id: string; role: string; content: string; attachmentsJson: string | null; toolUsed: string | null; createdAt: string }) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        attachments: m.attachmentsJson ? safeParseAttachments(m.attachmentsJson) : undefined,
        toolUsed: m.toolUsed,
        createdAt: m.createdAt,
      }))
      setMessages(msgs)
    } catch (err) {
      console.error(err)
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      removeConversation(id)
      if (activeConversationId === id) {
        setMessages([])
        setActiveConversation(null)
      }
      toast.success('Conversation deleted')
    } catch (err) {
      console.error(err)
      toast.error('Could not delete')
    }
  }

  const handleTogglePin = async (c: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/conversations/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !c.pinned }),
      })
      if (!res.ok) throw new Error('Failed')
      upsertConversation({ ...c, pinned: !c.pinned })
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <>
      {/* Mobile backdrop — clicking it closes the sidebar */}
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-10 bg-black/50 md:hidden"
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      <aside
        className="flex flex-col flex-shrink-0 z-20 transition-all duration-300 overflow-hidden fixed md:relative h-full md:h-auto"
        style={{
          width: sidebarCollapsed ? 0 : 260,
          background: 'var(--aria-bg-panel)',
          borderRight: sidebarCollapsed ? 'none' : '1px solid var(--aria-border)',
        }}
    >
      <div className="w-[260px] h-full flex flex-col p-5">
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 pb-6 px-2 border-b mb-4"
          style={{ borderColor: 'var(--aria-border)' }}
        >
          <div className="aria-logo-dot" />
          <span className="font-serif-aria text-2xl tracking-tight">ARIA</span>
        </div>

        {/* New conversation + Feed ARIA */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={handleNewConversation}
            className="flex-1 py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all text-sm"
            style={{
              background: 'var(--aria-card)',
              border: '1px solid var(--aria-border)',
              color: 'var(--aria-fg)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(245,158,11,0.08)'
              e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--aria-card)'
              e.currentTarget.style.borderColor = 'var(--aria-border)'
            }}
          >
            <Plus size={14} />
            New
          </button>
          <button
            onClick={() => setFeedAriaOpen(true)}
            className="py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all text-sm"
            style={{
              background: 'var(--aria-card)',
              border: '1px solid var(--aria-border)',
              color: 'var(--aria-fg-muted)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(245,158,11,0.08)'
              e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)'
              e.currentTarget.style.color = 'var(--aria-accent-glow)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--aria-card)'
              e.currentTarget.style.borderColor = 'var(--aria-border)'
              e.currentTarget.style.color = 'var(--aria-fg-muted)'
            }}
            title="Feed ARIA — teach her something"
          >
            <BookOpen size={14} />
            Feed
          </button>
        </div>

        {/* Nav tabs */}
        <nav className="flex flex-col gap-0.5 shrink-0">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = activePanel === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActivePanel(tab.id)}
                className="flex items-center gap-3 py-2 px-3.5 rounded-[10px] text-sm transition-all text-left w-full shrink-0"
                style={{
                  background: active ? 'rgba(245,158,11,0.08)' : 'transparent',
                  color: active ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                  border: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'var(--aria-card)'
                    e.currentTarget.style.color = 'var(--aria-fg)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'var(--aria-fg-muted)'
                  }
                }}
              >
                <Icon size={18} strokeWidth={1.5} />
                {tab.label}
              </button>
            )
          })}
        </nav>

        {/* Panel content (conversations list, or memory/mood/reminders) */}
        <div className="flex-1 mt-4 min-h-0 flex flex-col overflow-hidden">
          {activePanel === 'conversations' ? (
            <ConversationList
              conversations={conversations}
              activeId={activeConversationId}
              onSelect={handleSelectConversation}
              onDelete={handleDelete}
              onTogglePin={handleTogglePin}
            />
          ) : (
            <SidePanels />
          )}
        </div>

        {/* User profile */}
        <div
          ref={profileRef}
          className="pt-4 border-t relative"
          style={{ borderColor: 'var(--aria-border)' }}
        >
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex items-center gap-3 p-2 rounded-[10px] w-full transition-colors"
            style={{ background: 'transparent', border: 'none', color: 'inherit' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--aria-card)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center font-semibold text-sm flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, #4a3a2a, #2a1f15)',
                color: 'var(--aria-accent-glow)',
                border: '1px solid var(--aria-border)',
              }}
            >
              {(user?.name?.[0] || 'U').toUpperCase()}
            </div>
            <div className="flex-1 text-left overflow-hidden">
              <div className="text-sm font-medium" style={{ color: 'var(--aria-fg)' }}>
                {user?.name || 'friend'}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
                {user?.tier || 'Free'} Tier
              </div>
            </div>
            <ChevronDown size={16} style={{ color: 'var(--aria-fg-muted)' }} />
          </button>

          {dropdownOpen && (
            <div
              className="absolute bottom-[70px] left-0 right-0 rounded-xl p-2 shadow-2xl z-30"
              style={{
                background: 'var(--aria-bg-soft)',
                border: '1px solid var(--aria-border)',
              }}
            >
              <button
                onClick={() => {
                  setSettingsOpen(true)
                  setDropdownOpen(false)
                }}
                className="flex items-center gap-2.5 p-2.5 rounded-lg w-full text-left text-sm transition-colors"
                style={{ color: 'var(--aria-fg-muted)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--aria-card)'
                  e.currentTarget.style.color = 'var(--aria-fg)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--aria-fg-muted)'
                }}
              >
                <SettingsIcon size={16} strokeWidth={1.5} />
                Settings
              </button>
              <button
                onClick={async () => {
                  setDropdownOpen(false)
                  // Sign out via NextAuth, then redirect to landing.
                  // Use redirect: false so we control the redirect ourselves —
                  // NextAuth's built-in redirect can fail on z.ai preview domains
                  // when NEXTAUTH_URL isn't set.
                  const { signOut } = await import('next-auth/react')
                  const result = await signOut({ redirect: false, callbackUrl: '/' })
                  // Manually redirect to the landing page
                  if (result?.url) {
                    window.location.href = result.url
                  } else {
                    window.location.href = '/'
                  }
                }}
                className="flex items-center gap-2.5 p-2.5 rounded-lg w-full text-left text-sm transition-colors"
                style={{ color: '#ef4444' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--aria-card)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <LogOut size={16} strokeWidth={1.5} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
    </>
  )
}

type SearchResult = {
  id: string
  title: string
  pinned: boolean
  updatedAt: string
  messageCount: number
  preview: string
  matchSnippet?: string
  matchRole?: string
  matchCount?: number
  matchedIn: 'title' | 'message' | 'both' | 'semantic'
}

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onTogglePin,
}: {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (c: Conversation) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onTogglePin: (c: Conversation, e: React.MouseEvent) => void
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [overflowMenuFor, setOverflowMenuFor] = useState<string | null>(null)
  const [overflowMenuFlip, setOverflowMenuFlip] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overflowRef = useRef<HTMLDivElement>(null)

  // Reset confirm-delete state if a different conversation is selected.
  // Touching any other row cancels the pending delete confirmation.
  useEffect(() => {
    if (confirmDeleteId && confirmDeleteId !== activeId) {
      setConfirmDeleteId(null)
      if (confirmTimer.current) {
        clearTimeout(confirmTimer.current)
        confirmTimer.current = null
      }
    }
  }, [activeId, confirmDeleteId])

  // Clear confirm timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  // Close overflow dropdown on outside click or Escape
  useEffect(() => {
    if (!overflowMenuFor) return
    const onMouseDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowMenuFor(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowMenuFor(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overflowMenuFor])

  // Two-step delete: first click arms the confirm state, second click (within
  // 3s) actually deletes. Clicking elsewhere or selecting another row resets it.
  const requestDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirmDeleteId === id) {
      if (confirmTimer.current) {
        clearTimeout(confirmTimer.current)
        confirmTimer.current = null
      }
      setConfirmDeleteId(null)
      onDelete(id, e)
      return
    }
    setConfirmDeleteId(id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => {
      setConfirmDeleteId(null)
      confirmTimer.current = null
    }, 3000)
  }

  // Debounced search — only hits the API when the user stops typing for 250ms
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`)
        if (!res.ok) throw new Error('search failed')
        const data = await res.json()
        setSearchResults(data.results || [])
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchQuery])

  const handleExport = async (id: string, format: 'json' | 'markdown') => {
    setOverflowMenuFor(null)
    try {
      const res = await fetch(`/api/conversations/${id}/export?format=${format}`)
      if (!res.ok) throw new Error('export failed')
      const blob = await res.blob()
      // Extract filename from Content-Disposition, or fall back to a default
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match ? match[1] : `aria-conversation.${format}`
      // Trigger download
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(`Exported as ${format.toUpperCase()}`)
    } catch {
      toast.error('Could not export conversation')
    }
  }

  // Search results view
  if (searchResults !== null) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {/* Search input */}
        <div className="mb-2 relative shrink-0">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--aria-fg-dim)' }}
          />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            autoFocus
            className="w-full rounded-lg pl-7 pr-7 py-2 text-[13px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
            style={{
              background: 'var(--aria-bg-panel)',
              border: '1px solid var(--aria-border)',
              color: 'var(--aria-fg)',
              fontFamily: 'inherit',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded"
              style={{ color: 'var(--aria-fg-dim)' }}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
          {searching ? (
            <div className="text-xs text-center py-8" style={{ color: 'var(--aria-fg-dim)' }}>
              Searching...
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-xs text-center py-8 px-4 leading-relaxed" style={{ color: 'var(--aria-fg-dim)' }}>
              No conversations match &ldquo;{searchQuery}&rdquo;.
            </div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--aria-fg-dim)' }}>
                {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'}
              </div>
              {searchResults.map((r) => {
                const c: Conversation = {
                  id: r.id,
                  title: r.title,
                  pinned: r.pinned,
                  updatedAt: r.updatedAt,
                  createdAt: r.updatedAt,
                  messageCount: r.messageCount,
                  preview: r.matchSnippet || r.preview || '',
                }
                return (
                  <div
                    key={r.id}
                    onClick={() => {
                      onSelect(c)
                      setSearchQuery('')
                    }}
                    className="group flex items-start gap-2 p-3 rounded-[10px] mb-1 cursor-pointer transition-colors"
                    style={{
                      background: activeId === r.id ? 'rgba(245,158,11,0.08)' : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (activeId !== r.id) e.currentTarget.style.background = 'var(--aria-card)'
                    }}
                    onMouseLeave={(e) => {
                      if (activeId !== r.id) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm truncate flex items-center gap-1.5"
                        style={{ color: activeId === r.id ? 'var(--aria-accent-glow)' : 'var(--aria-fg)' }}
                      >
                        {r.pinned && <Pin size={11} className="flex-shrink-0" />}
                        {r.title}
                      </div>
                      {r.matchSnippet && (
                        <div className="text-[11px] mt-0.5 leading-snug line-clamp-2" style={{ color: 'var(--aria-fg-muted)' }}>
                          {r.matchSnippet}
                        </div>
                      )}
                      {r.matchCount && r.matchCount > 1 && (
                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--aria-fg-dim)' }}>
                          {r.matchCount} matches
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    )
  }

  // Normal conversation list (no search active)
  if (conversations.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="mb-2 relative shrink-0">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--aria-fg-dim)' }}
          />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full rounded-lg pl-7 pr-3 py-2 text-[13px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
            style={{
              background: 'var(--aria-bg-panel)',
              border: '1px solid var(--aria-border)',
              color: 'var(--aria-fg)',
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div
          className="text-xs text-center py-8 px-4 leading-relaxed"
          style={{ color: 'var(--aria-fg-dim)' }}
        >
          No conversations yet.
          <br />
          Start one above.
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Search input */}
      <div className="mb-2 relative shrink-0">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--aria-fg-dim)' }}
        />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search conversations..."
          className="w-full rounded-lg pl-7 pr-3 py-2 text-[13px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
          style={{
            background: 'var(--aria-bg-panel)',
            border: '1px solid var(--aria-border)',
            color: 'var(--aria-fg)',
            fontFamily: 'inherit',
          }}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        <div className="text-[10px] uppercase tracking-wider px-1 mb-2" style={{ color: 'var(--aria-fg-dim)' }}>
          Recent
        </div>
        {conversations.map((c) => {
          const active = c.id === activeId
          const showOverflow = overflowMenuFor === c.id
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c)}
              className="group flex items-center gap-2 py-2.5 px-3 rounded-[10px] mb-0.5 cursor-pointer transition-colors relative"
              style={{
                background: active ? 'rgba(245,158,11,0.08)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'var(--aria-card)'
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent'
              }}
            >
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm truncate flex items-center gap-1.5"
                  style={{ color: active ? 'var(--aria-accent-glow)' : 'var(--aria-fg)' }}
                >
                  {c.pinned && <Pin size={11} className="flex-shrink-0" />}
                  {c.title}
                </div>
              </div>
              <div
                className={`flex-shrink-0 transition-opacity ${
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (overflowMenuFor === c.id) {
                      setOverflowMenuFor(null)
                      return
                    }
                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                    const spaceBelow = window.innerHeight - rect.bottom
                    setOverflowMenuFlip(spaceBelow < 200)
                    setOverflowMenuFor(c.id)
                  }}
                  className="p-1.5 rounded-md transition-colors"
                  style={{ color: 'var(--aria-fg-muted)' }}
                  title="More options"
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>

              {/* Unified overflow dropdown */}
              {showOverflow && (
                <div
                  ref={overflowRef}
                  className={`absolute right-2 z-30 rounded-xl p-1.5 min-w-[160px] ${
                    overflowMenuFlip ? 'bottom-full mb-1' : 'top-full mt-1'
                  }`}
                  style={{
                    background: 'var(--aria-bg-soft)',
                    border: '1px solid var(--aria-border)',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={(e) => { onTogglePin(c, e); setOverflowMenuFor(null) }}
                    className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors text-left"
                    style={{ color: 'var(--aria-fg)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--aria-card)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {c.pinned ? <PinOff size={13} style={{ color: 'var(--aria-accent-glow)' }} /> : <Pin size={13} style={{ color: 'var(--aria-accent-glow)' }} />}
                    {c.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    onClick={() => handleExport(c.id, 'markdown')}
                    className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors text-left"
                    style={{ color: 'var(--aria-fg)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--aria-card)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <FileText size={13} style={{ color: 'var(--aria-accent-glow)' }} />
                    Export as Markdown
                  </button>
                  <button
                    onClick={() => handleExport(c.id, 'json')}
                    className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors text-left"
                    style={{ color: 'var(--aria-fg)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--aria-card)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <FileJson size={13} style={{ color: 'var(--aria-accent-glow)' }} />
                    Export as JSON
                  </button>
                  <div style={{ borderTop: '1px solid var(--aria-border)', margin: '4px 0' }} />
                  <button
                    onClick={(e) => requestDelete(c.id, e)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors text-left"
                    style={{ color: confirmDeleteId === c.id ? '#ef4444' : 'var(--aria-fg)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--aria-card)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {confirmDeleteId === c.id ? <Check size={13} /> : <Trash2 size={13} />}
                    {confirmDeleteId === c.id ? 'Click again to confirm' : 'Delete'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function safeParseAttachments(json: string) {
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed
  } catch {
    /* ignore */
  }
  return undefined
}
