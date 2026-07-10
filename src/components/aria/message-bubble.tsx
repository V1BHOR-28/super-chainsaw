'use client'

import { useState } from 'react'
import { Volume2, Square, Globe, Image as ImageIcon, Eye, Copy, Check, Brain, Heart } from 'lucide-react'
import { Markdown } from './markdown'
import type { ChatMessage } from '@/lib/types'
import { useAriaStore } from '@/lib/store'

/**
 * A single chat message — user or ARIA.
 * Preserves the intern's bubble design, adds:
 * - streaming caret while ARIA is replying
 * - markdown rendering
 * - attachment thumbnails (images)
 * - tool badges (web_search / image_generation / vision)
 * - voice playback (TTS) button on ARIA messages
 * - copy button on ARIA messages
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const settings = useAriaStore((s) => s.settings)
  const user = useAriaStore((s) => s.user)
  const [playing, setPlaying] = useState(false)
  const [copied, setCopied] = useState(false)

  // User's avatar initial — derived from their actual name, not hardcoded.
  // Falls back to "U" (User) if no name is set. This fixes the bug where the
  // avatar always showed "E" regardless of who was logged in.
  const userInitial = (user?.name?.trim()?.[0] ?? 'U').toUpperCase()

  const speak = () => {
    if (playing) {
      window.speechSynthesis.cancel()
      setPlaying(false)
      return
    }

    // Strip markdown for cleaner speech
    const cleanText = message.content
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>~]/g, '')
      .replace(/\n+/g, '. ')
      .slice(0, 1000)

    const utterance = new SpeechSynthesisUtterance(cleanText)
    utterance.rate = 1.0
    utterance.pitch = 1.0

    // Try to use a female-sounding voice if available
    const voices = window.speechSynthesis.getVoices()
    const preferredVoice = voices.find(v =>
      v.name.includes('Female') || v.name.includes('Samantha') || v.name.includes('Google US English')
    )
    if (preferredVoice) {
      utterance.voice = preferredVoice
    }

    utterance.onend = () => setPlaying(false)
    utterance.onerror = () => setPlaying(false)

    window.speechSynthesis.speak(utterance)
    setPlaying(true)
  }

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const renderToolBadge = () => {
    if (!message.toolUsed) return null
    const map: Record<string, { label: string; icon: typeof Globe }> = {
      web_search: { label: 'Web search', icon: Globe },
      image_generation: { label: 'Image generated', icon: ImageIcon },
      vision: { label: 'Vision', icon: Eye },
    }
    const t = map[message.toolUsed]
    if (!t) return null
    const Icon = t.icon
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
        style={{
          background: 'rgba(245,158,11,0.08)',
          color: 'var(--aria-accent-glow)',
          border: '1px solid var(--aria-border)',
        }}
      >
        <Icon size={10} />
        {t.label}
      </span>
    )
  }

  const toolBadgeEl = renderToolBadge()
  // Note: use `(x ?? 0) > 0` not `x && x > 0` — the latter renders "0" as
  // visible text in JSX when x is 0 (React renders numbers, unlike false/null).
  const hasContextBadges =
    !isUser &&
    (!!toolBadgeEl || (message.memoriesUsed ?? 0) > 0 || !!message.moodContext)

  // Green apple emoji: when a user types "/green apple ..." or "/ga ...",
  // the input morphs it to "🍏 ..." before sending (see chat-area.tsx), so
  // most stored messages already start with 🍏. For older messages that
  // still have the literal /green apple prefix, transform it for display.
  // Messages already starting with 🍏 are left as-is.
  const displayContent = isUser
    ? message.content.replace(/^\/(?:green\s*apple|ga)\s+/i, '🍏 ')
    : message.content

  return (
    <div className={`flex gap-2 sm:gap-3 max-w-[720px] w-full mx-auto aria-msg-enter ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className="aria-avatar-ai w-8 h-8 rounded-full flex-shrink-0 mt-1 flex items-center justify-center" />
      )}

      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-full`}>
        {hasContextBadges && (
          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
            {toolBadgeEl}
            {(message.memoriesUsed ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(168, 152, 136, 0.06)',
                  color: 'var(--aria-fg-muted)',
                  border: '1px solid var(--aria-border)',
                }}
                title={`ARIA is holding ${message.memoriesUsed} memories about you in context for this reply.`}
              >
                <Brain size={10} />
                {message.memoriesUsed} {message.memoriesUsed === 1 ? 'memory' : 'memories'}
              </span>
            )}
            {message.moodContext && (
              <span
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(168, 152, 136, 0.06)',
                  color: 'var(--aria-fg-muted)',
                  border: '1px solid var(--aria-border)',
                }}
                title={`ARIA is aware your last mood was "${message.moodContext}".`}
              >
                <Heart size={10} />
                {message.moodContext}
              </span>
            )}
          </div>
        )}

        {/* Attachment thumbnails (for user messages with images) */}
        {message.attachments && message.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-2 mb-2 ${isUser ? 'justify-end' : ''}`}>
            {message.attachments.map((a, i) => (
              <img
                key={i}
                src={a.dataUrl}
                alt={a.name}
                className="rounded-lg border object-cover"
                style={{
                  borderColor: 'var(--aria-border)',
                  maxWidth: 180,
                  maxHeight: 180,
                  width: 'auto',
                }}
              />
            ))}
          </div>
        )}

        <div
          className="px-4 py-3 rounded-2xl max-w-full"
          style={
            isUser
              ? {
                  background: 'rgba(40, 28, 10, 0.5)',
                  border: '1px solid rgba(245, 158, 11, 0.2)',
                  color: 'var(--aria-accent-glow)',
                  borderTopRightRadius: 4,
                }
              : {
                  background: 'rgba(22, 18, 16, 0.6)',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg)',
                  borderTopLeftRadius: 4,
                }
          }
        >
          {message.content ? (
            isUser ? (
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed m-0">{displayContent}</p>
            ) : (
              <>
                <Markdown content={message.content} />
                {message.streaming && <span className="aria-caret" />}
              </>
            )
          ) : message.streaming ? (
            <div className="flex items-center gap-1 py-2">
              <span className="aria-thinking-dot" />
              <span className="aria-thinking-dot" style={{ animationDelay: '0.2s' }} />
              <span className="aria-thinking-dot" style={{ animationDelay: '0.4s' }} />
            </div>
          ) : null}
        </div>

        {/* Web sources bar — "Found N web pages" with favicon logos (like DeepSeek) */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div
            className="flex items-center gap-2 mt-2 flex-wrap"
            style={{ maxWidth: '100%' }}
          >
            <span
              className="text-[10px] flex items-center gap-1 shrink-0"
              style={{ color: 'var(--aria-fg-dim)' }}
            >
              <Globe size={10} />
              Found {message.sources.length} {message.sources.length === 1 ? 'source' : 'sources'}
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {message.sources.slice(0, 5).map((src, i) => (
                <a
                  key={i}
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-full px-2 py-1 transition-all hover:scale-105"
                  style={{
                    background: 'var(--aria-card)',
                    border: '1px solid var(--aria-border)',
                    textDecoration: 'none',
                  }}
                  title={src.title}
                >
                  {/* Favicon via Google's favicon service — no API key needed */}
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${src.host}&sz=32`}
                    alt=""
                    width={12}
                    height={12}
                    className="rounded-sm"
                    style={{ display: 'block' }}
                    onError={(e) => {
                      // If favicon fails to load, hide the image and show a globe fallback
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                  <span
                    className="text-[10px] truncate"
                    style={{ color: 'var(--aria-fg-muted)', maxWidth: '120px' }}
                  >
                    {src.host}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Action row for ARIA messages */}
        {!isUser && !message.streaming && message.content && (
          <div className="flex items-center gap-1 mt-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <button
              onClick={copyMessage}
              className="p-1.5 rounded-md hover:bg-white/5 transition-colors"
              style={{ color: 'var(--aria-fg-muted)' }}
              aria-label="Copy"
              title="Copy"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {settings?.voiceEnabled && (
              <button
                onClick={speak}
                className="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                style={{ color: 'var(--aria-fg-muted)' }}
                aria-label={playing ? 'Stop' : 'Listen'}
                title={playing ? 'Stop' : 'Listen'}
              >
                {playing ? <Square size={13} /> : <Volume2 size={13} />}
              </button>
            )}
          </div>
        )}
      </div>

      {isUser && (
        <div
          className="w-8 h-8 rounded-full flex-shrink-0 mt-1 flex items-center justify-center text-xs font-medium"
          style={{
            background: 'var(--aria-card)',
            border: '1px solid var(--aria-border)',
            color: 'var(--aria-fg-muted)',
          }}
        >
          {userInitial}
        </div>
      )}
    </div>
  )
}
