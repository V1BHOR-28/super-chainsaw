'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Send,
  Plus,
  Globe,
  Image as ImageIcon,
  X,
  Clock,
  Lightbulb,
  BookOpen,
  Sparkles,
  Menu,
} from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { useAriaChat } from '@/hooks/use-aria-chat'
import { MessageBubble } from './message-bubble'
import { MemoryAskCard } from './memory-ask-card'
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
  } = useAriaStore()

  const { sendMessage } = useAriaChat()
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [greeting, setGreeting] = useState('')

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

  // Auto-scroll to bottom on new messages / streaming
  useEffect(() => {
    if (scrollRef.current) {
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

  // Live green-apple morph: when the user types "/green apple " or "/ga "
  // (with the trailing space), auto-replace the prefix with "🍏 " so the
  // emoji appears IN the input as they type. The backend recognizes both
  // /green apple and 🍏 as green-apple mode, so the sent message keeps the
  // emoji and stays consistent with the chat bubble display.
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let value = e.target.value
    // Only morph if this edit ADDED the triggering trailing space (so we don't
    // fight the user while they backspace through the prefix).
    // Match "/green apple " or "/ga " at the very start, case-insensitive.
    const morphed = value.replace(/^\/(?:green\s*apple|ga)\s+/i, '🍏 ')
    if (morphed !== value) {
      // Preserve cursor position offset (prefix shrinks/grows by a few chars).
      // /green apple = 12 chars, /ga = 3 chars, 🍏 = 2 chars (emoji). The
      // replace swaps the whole prefix+space for "🍏 ", so we just set the
      // cursor to the end of the morphed prefix region + whatever follows.
      // Simplest correct behavior: place cursor right after "🍏 ".
      const after = value.replace(/^\/(?:green\s*apple|ga)\s+/i, '')
      value = '🍏 ' + after
    }
    setInput(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (idx: number) => {
    setPendingAttachments(pendingAttachments.filter((_, i) => i !== idx))
  }

  const toggleTool = (tool: 'web_search' | 'image_generation') => {
    setPendingTool(pendingTool === tool ? null : tool)
  }

  const hasMessages = messages.length > 0
  const canSend = input.trim().length > 0 && !isStreaming

  const chips = [
    { label: 'Remind me to...', icon: Clock, action: () => setInput('Remind me to ') },
    { label: 'I need advice on...', icon: Lightbulb, action: () => setInput('I need advice on ') },
    { label: 'I want to learn about...', icon: BookOpen, action: () => setInput('I want to learn about ') },
    { label: "Let's brainstorm...", icon: Sparkles, action: () => setInput("Let's brainstorm ") },
  ]

  return (
    <main className="flex-1 flex flex-col relative overflow-hidden" style={{ background: 'var(--aria-bg)' }}>
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 h-[56px] sm:h-[60px] flex items-center justify-between px-4 sm:px-6 z-10">
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
        <UsageMeter />
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

      {/* Messages / greeting */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pt-16 pb-4 px-4 sm:pt-20 sm:px-6 z-[1] flex flex-col gap-4 sm:gap-6">
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

      {/* Input zone */}
      <div className="px-4 sm:px-6 pb-6 sm:pb-8 z-[2]" style={{ background: 'linear-gradient(to top, var(--aria-bg) 70%, transparent)' }}>
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
                </div>
              ))}
            </div>
          )}

          {/* Pending tool indicator */}
          {pendingTool && (
            <div className="flex justify-center mb-2">
              <div
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
                style={{
                  background: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  color: 'var(--aria-accent-glow)',
                }}
              >
                {pendingTool === 'web_search' ? <Globe size={11} /> : <ImageIcon size={11} />}
                {pendingTool === 'web_search' ? 'Web search on next send' : 'Image generation on next send'}
                <button onClick={() => setPendingTool(null)} className="ml-1">
                  <X size={11} />
                </button>
              </div>
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
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                style={{
                  background: 'var(--aria-card)',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg-muted)',
                }}
                title="Attach images"
              >
                <Plus size={16} />
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
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
                title="Search the web"
              >
                <Globe size={15} />
              </button>
              <button
                onClick={toggleTool.bind(null, 'image_generation')}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                style={{
                  background: pendingTool === 'image_generation' ? 'rgba(245,158,11,0.15)' : 'var(--aria-card)',
                  border: '1px solid',
                  borderColor: pendingTool === 'image_generation' ? 'var(--aria-accent)' : 'var(--aria-border)',
                  color: pendingTool === 'image_generation' ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                }}
                title="Generate an image"
              >
                <ImageIcon size={15} />
              </button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all"
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
              {chips.map((c) => {
                const Icon = c.icon
                return (
                  <button
                    key={c.label}
                    onClick={c.action}
                    className="text-xs px-3.5 py-1.5 rounded-full flex items-center gap-1.5 transition-colors"
                    style={{
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
