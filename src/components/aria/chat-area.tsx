'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Send,
  Plus,
  Globe,
  X,
  Clock,
  Lightbulb,
  BookOpen,
  Sparkles,
  Menu,
  Download,
  Loader2,
  Check,
} from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { useAriaChat } from '@/hooks/use-aria-chat'
import { MessageBubble } from './message-bubble'
import { MemoryAskCard } from './memory-ask-card'
import { BookSuggestionCard } from './book-suggestion-card'
import { UsageMeter } from './usage-meter'
import { toast } from 'sonner'

export function ChatArea() {
  const {
    user,
    messages,
    activeConversationId,
    isStreaming,
    pendingAttachments,
    setPendingAttachments,
    pendingTool,
    setPendingTool,
    sidebarCollapsed,
    toggleSidebar,
    setActiveConversation,
    upsertConversation,
    setMessages,
    conversations,
    pendingMemoryCandidate,
    setPendingMemoryCandidate,
    pendingBookSuggestion,
  } = useAriaStore()

  const { sendMessage } = useAriaChat()
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Tracks whether the user is currently scrolled near the bottom of the
  // messages container. Used to suppress force-scroll-to-bottom when the
  // user has deliberately scrolled up to read older messages.
  const isNearBottomRef = useRef(true)
  const [greeting, setGreeting] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  // === VISUAL POLISH STATE (CHATEAREA-POLISH) ===
  // Item 7: send-button "ready" pulse — briefly applies aria-btn-ready
  // when canSend transitions false → true.
  const [pulseReady, setPulseReady] = useState(false)
  // Item 8: attachment thumbnail "just landed" indices — drives the
  // brief checkmark badge that fades out ~1.2s after a thumbnail appears.
  const [attachJustLanded, setAttachJustLanded] = useState<number[]>([])

  // === KEYBOARD SHORTCUTS (Phase 4.3) ===
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K → new conversation (focus input)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        textareaRef.current?.focus()
        setInput('')
      }
      // Cmd/Ctrl+/ → toggle web search
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setPendingTool(useAriaStore.getState().pendingTool === 'web_search' ? null : 'web_search')
      }
      // Esc → close any open modal (settings, feed)
      if (e.key === 'Escape') {
        const { settingsOpen, setSettingsOpen, feedAriaOpen, setFeedAriaOpen } = useAriaStore.getState()
        if (settingsOpen) { setSettingsOpen(false); return }
        if (feedAriaOpen) { setFeedAriaOpen(false); return }
        // Otherwise unfocus the textarea
        if (document.activeElement === textareaRef.current) {
          textareaRef.current?.blur()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPendingTool])

  // Time-based greeting
  useEffect(() => {
    const hour = new Date().getHours()
    const name = user?.name || 'friend'
    let g = ''
    if (hour >= 22 || hour < 5) g = `Still up, ${name}?`
    else if (hour >= 5 && hour < 12) g = `Good morning, ${name}`
    else if (hour >= 12 && hour < 18) g = `Good afternoon, ${name}`
    else g = `Good evening, ${name}`
    setGreeting(g)
  }, [user?.name])

  // Track whether the user is scrolled near the bottom of the messages
  // container. Updates isNearBottomRef on every scroll event so the
  // messages-change effect below can decide whether to auto-scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll to bottom on new messages / streaming — but only when the
  // user is already near the bottom, so we don't yank them away from older
  // messages they've scrolled up to read.
  useEffect(() => {
    if (scrollRef.current && isNearBottomRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages])

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
  }, [input])

  // Item 8: attachment thumbnail "just landed" tracker. When attachments
  // are added, mark all current indices as just-landed for ~1.2s so each
  // thumbnail can show a brief checkmark badge confirming upload-complete.
  useEffect(() => {
    if (pendingAttachments.length > 0) {
      const newIndices = pendingAttachments.map((_, i) => i)
      setAttachJustLanded(newIndices)
      const t = setTimeout(() => setAttachJustLanded([]), 1200)
      return () => clearTimeout(t)
    }
  }, [pendingAttachments.length])

  // If no active conversation, auto-create one on first send
  const ensureConversation = async (): Promise<string | null> => {
    if (activeConversationId) return activeConversationId
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Conversation' }),
      })
      if (!res.ok) return null
      const { conversation } = await res.json()
      upsertConversation(conversation)
      setActiveConversation(conversation.id)
      setMessages([])
      return conversation.id
    } catch (err) {
      console.error(err)
      return null
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || isStreaming) return
    const convId = await ensureConversation()
    if (!convId) {
      toast.error('Could not start conversation')
      return
    }
    setInput('')
    await sendMessage(text, convId)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  // On iOS the on-screen keyboard shrinks the app shell (via --app-height).
  // Give the layout a frame to settle after focus, then keep the latest
  // message in view so the user can see ARIA's reply while typing.
  const handleTextareaFocus = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollRef.current && isNearBottomRef.current) {
          scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight })
        }
      })
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Guard against IME composition (CJK / Japanese / Korean input methods):
    // when the user is mid-composition, Enter confirms the candidate, not
    // sends the message. e.nativeEvent.isComposing is the platform signal.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    if (pendingAttachments.length + files.length > 4) {
      toast.error('Max 4 images per message')
      return
    }
    setIsUploading(true)
    try {
      const form = new FormData()
      files.forEach((f) => form.append('files', f))
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()
      setPendingAttachments([...pendingAttachments, ...data.attachments])
    } catch (err) {
      console.error(err)
      toast.error('Could not attach file')
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (idx: number) => {
    setPendingAttachments(pendingAttachments.filter((_, i) => i !== idx))
  }

  const toggleTool = (tool: 'web_search' | 'image_generation') => {
    // Only web search toggle remains (image generation removed).
    if (tool === 'web_search') {
      setPendingTool(pendingTool === 'web_search' ? null : 'web_search')
    }
  }

  const hasMessages = messages.length > 0
  const canSend = input.trim().length > 0 && !isStreaming

  // Item 7: send-button "ready" pulse. When canSend flips to true (user
  // typed something while not streaming), flash the aria-btn-ready class
  // for ~200ms so the button visibly "wakes up". Declared AFTER canSend so
  // the dependency-array reference is in scope (canSend is a const below
  // the prior useEffects, so this effect must live here).
  useEffect(() => {
    if (canSend) {
      setPulseReady(true)
      const t = setTimeout(() => setPulseReady(false), 200)
      return () => clearTimeout(t)
    }
  }, [canSend])

  const chips = [
    { label: 'Remind me to...', icon: Clock, action: () => setInput('Remind me to ') },
    { label: 'I need advice on...', icon: Lightbulb, action: () => setInput('I need advice on ') },
    { label: 'I want to learn about...', icon: BookOpen, action: () => setInput('I want to learn about ') },
    { label: "Let's brainstorm...", icon: Sparkles, action: () => setInput("Let's brainstorm ") },
  ]

  return (
    <main className="flex-1 flex flex-col relative overflow-hidden" style={{ background: 'var(--aria-bg)' }}>
      {/* Top bar — padded below the iOS notch / status bar so the sidebar
          toggle is actually tappable in PWA standalone mode. */}
      <div className="absolute top-0 left-0 right-0 z-10 chat-header-safe">
        <div className="h-[56px] sm:h-[60px] flex items-center justify-between px-4 sm:px-6">
        <button
          onClick={toggleSidebar}
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
          style={{
            background: 'var(--aria-card)',
            border: '1px solid var(--aria-border)',
            color: 'var(--aria-fg-muted)',
          }}
          aria-label="Toggle sidebar"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2">
          {activeConversationId && hasMessages && (
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/conversations/${activeConversationId}/export?format=markdown`)
                  if (!res.ok) throw new Error('Export failed')
                  const blob = await res.blob()
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `aria-conversation-${Date.now()}.md`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                  toast.success('Conversation exported as Markdown')
                } catch {
                  toast.error('Could not export conversation')
                }
              }}
              className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
              style={{
                background: 'var(--aria-card)',
                border: '1px solid var(--aria-border)',
                color: 'var(--aria-fg-muted)',
              }}
              aria-label="Export conversation"
              title="Export as Markdown"
            >
              <Download size={16} />
            </button>
          )}
          <UsageMeter />
        </div>
        </div>
      </div>

      {/* Ambient glow */}
      <div
        className="aria-ambient-glow"
        style={{
          width: 600,
          height: 600,
          background: '#f59e0b',
          top: '25%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          opacity: 0.08,
        }}
      />

      {/* Messages / greeting — chat-scroll-padding clears the floating
          header + notch; overscroll contained so touch scrolling works on
          iOS without rubber-banding the whole page. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto chat-scroll-padding pb-4 px-4 sm:px-6 z-[1] flex flex-col gap-4 sm:gap-6">
        {hasMessages ? (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {/* Memory ask card — appears below the latest ARIA reply when the
                detection engine found a medium-confidence candidate. Only shows
                when not streaming so it doesn't fight with the live reply. */}
            {pendingMemoryCandidate && !isStreaming && (
              <MemoryAskCard
                candidate={pendingMemoryCandidate}
                onResolved={() => setPendingMemoryCandidate(null)}
              />
            )}
            {pendingBookSuggestion && !isStreaming && (
              <BookSuggestionCard suggestion={pendingBookSuggestion} />
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center pb-20 sm:pb-32 px-4">
            <h1 className="font-serif-aria text-[40px] sm:text-[64px] leading-[1.1] mb-3">
              <em className="aria-greeting-grad">{greeting}</em>
            </h1>
            <p className="text-base sm:text-lg" style={{ color: 'var(--aria-fg-muted)' }}>
              Tell ARIA what&apos;s on your mind today{user?.name ? `, ${user.name}` : ''}.
            </p>
          </div>
        )}
      </div>

      {/* Input zone — chat-input-padding clears the iOS home indicator */}
      <div className="px-4 sm:px-6 chat-input-padding z-[2]" style={{ background: 'linear-gradient(to top, var(--aria-bg) 70%, transparent)' }}>
        <div className="max-w-[720px] mx-auto">
          {/* Pending attachments preview */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingAttachments.map((a, i) => (
                <div
                  key={i}
                  className="relative rounded-lg overflow-hidden"
                  style={{ border: '1px solid var(--aria-border)' }}
                >
                  <img src={a.dataUrl} alt={a.name} className="w-16 h-16 object-cover" />
                  <button
                    onClick={() => removeAttachment(i)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.7)', color: 'white' }}
                  >
                    <X size={10} />
                  </button>
                  {attachJustLanded.includes(i) && (
                    <div
                      className="absolute bottom-0.5 left-0.5 w-4 h-4 rounded-full flex items-center justify-center transition-opacity"
                      style={{
                        background: 'rgba(245,158,11,0.8)',
                        color: 'var(--aria-bg)',
                      }}
                    >
                      <Check size={10} strokeWidth={3} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Input container */}
          <div
            className="rounded-3xl p-3 transition-all"
            style={{
              background: 'var(--aria-bg-soft)',
              border: '1px solid var(--aria-border)',
            }}
          >
            <div className="flex items-end gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: 'var(--aria-card)',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg-muted)',
                }}
                title={isUploading ? 'Uploading…' : 'Attach images'}
                aria-label={isUploading ? 'Uploading' : 'Attach images'}
              >
                {isUploading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={handleTextareaFocus}
                placeholder="Message ARIA..."
                rows={1}
                className="flex-1 bg-transparent border-none outline-none resize-none py-1.5 text-[15px] max-h-[140px] min-h-[24px]"
                style={{ color: 'var(--aria-fg)' }}
              />
              <button
                onClick={toggleTool.bind(null, 'web_search')}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                style={{
                  background: pendingTool === 'web_search' ? 'rgba(245,158,11,0.15)' : 'var(--aria-card)',
                  border: '1px solid',
                  borderColor: pendingTool === 'web_search' ? 'var(--aria-accent)' : 'var(--aria-border)',
                  color: pendingTool === 'web_search' ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                }}
                title={pendingTool === 'web_search' ? 'Web search ON — click to turn off' : 'Web search OFF — click to turn on'}
              >
                <Globe size={15} />
              </button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${pulseReady ? 'aria-btn-ready' : ''}`}
                style={{
                  background: canSend ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                  color: 'var(--aria-bg)',
                  border: 'none',
                  cursor: canSend ? 'pointer' : 'not-allowed',
                }}
                aria-label="Send"
              >
                <Send size={15} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {/* Feature chips */}
          {!hasMessages && (
            <div className="flex justify-center gap-2 mt-3 flex-wrap">
              {chips.map((c, i) => {
                const Icon = c.icon
                return (
                  <button
                    key={c.label}
                    onClick={c.action}
                    className="text-xs px-3.5 py-1.5 rounded-full flex items-center gap-1.5 transition-colors aria-chip-enter"
                    style={{
                      animationDelay: `${i * 40}ms`,
                      background: 'var(--aria-card)',
                      border: '1px solid var(--aria-border)',
                      color: 'var(--aria-fg-muted)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(245,158,11,0.06)'
                      e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)'
                      e.currentTarget.style.color = 'var(--aria-accent-glow)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--aria-card)'
                      e.currentTarget.style.borderColor = 'var(--aria-border)'
                      e.currentTarget.style.color = 'var(--aria-fg-muted)'
                    }}
                  >
                    <Icon size={12} />
                    {c.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
