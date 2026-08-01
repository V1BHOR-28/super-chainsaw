'use client'

import { useCallback } from 'react'
import { useAriaStore } from '@/lib/store'
import { toast } from 'sonner'
import type { Attachment, ChatMessage, MemoryCandidate } from '@/lib/types'

/**
 * detectMemory — async helper that runs the memory-detection LLM call after
 * ARIA's reply completes. ALL confidence levels are routed through the
 * pendingMemoryCandidate / MemoryAskCard flow — nothing is written to
 * /api/memory until the user explicitly accepts via the ask card. The ask
 * card (memory-ask-card.tsx) handles the save, the success toast, and the
 * logDecision call on accept/skip, so detection here only queues the
 * candidate. Best-effort, silent on failure.
 */
async function detectMemory(userMessage: string, ariaReply: string) {
  let candidates: MemoryCandidate[] = []
  try {
    const res = await fetch('/api/memory/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage, ariaReply }),
    })
    if (!res.ok) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[detectMemory] /api/memory/detect returned', res.status)
      }
      return
    }
    const data = await res.json()
    candidates = (data.candidates || []) as MemoryCandidate[]
  } catch (e) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[detectMemory] fetch failed:', e)
    }
    return
  }
  if (candidates.length === 0) return

  const state = useAriaStore.getState()

  for (const c of candidates) {
    // Route ALL confidence levels (high + medium) through the ask-card
    // flow. Nothing is written to /api/memory here — the user must click
    // "Save" on MemoryAskCard before any persistence happens. The ask card
    // also owns the success toast and the logDecision call (on both accept
    // and skip), so detection here only queues the candidate. The candidate's
    // confidence is preserved on the object so the UI can visually
    // differentiate (e.g. pre-select accept for high-confidence candidates).
    state.setPendingMemoryCandidate(c)
    break
  }
}

/**
 * useAriaChat — the streaming chat orchestrator.
 * Sends a message to /api/chat, parses the SSE stream, and updates the store.
 */
export function useAriaChat() {
  const {
    activeConversationId,
    settings,
    pendingAttachments,
    pendingTool,
    appendMessage,
    updateMessage,
    setMessages,
    setStreaming,
    setPendingAttachments,
    setPendingTool,
    upsertConversation,
    conversations,
    setActiveConversation,
  } = useAriaStore()

  const sendMessage = useCallback(
    async (rawText: string, explicitConversationId?: string, onComplete?: (responseText: string) => void) => {
      const text = rawText.trim()
      const conversationId = explicitConversationId ?? activeConversationId
      if (!text || !conversationId) return

      // Guard against double-sends (double-click, Enter held down, etc.)
      // Check the live store state, not the stale closure value
      if (useAriaStore.getState().isStreaming) return

      // 1. Optimistically render the user message
      const userMsgId = `u-${Date.now()}`
      const userMsg: ChatMessage = {
        id: userMsgId,
        role: 'user',
        content: text,
        attachments: pendingAttachments.length ? pendingAttachments : undefined,
        createdAt: new Date().toISOString(),
      }
      appendMessage(userMsg)

      // 2. Optimistically render ARIA's placeholder (streaming)
      const ariaMsgId = `a-${Date.now()}`
      appendMessage({
        id: ariaMsgId,
        role: 'assistant',
        content: '',
        streaming: true,
        createdAt: new Date().toISOString(),
        toolUsed: pendingTool ?? (pendingAttachments.length ? 'vision' : null),
      })

      setStreaming(true)
      const toolForThisSend = pendingTool
      const attachmentsForThisSend = pendingAttachments
      // Reset tool/attachments for the next message.
      // Web search is ALWAYS ON now, so after sending we reset back to
      // 'web_search' (not null) — this keeps the globe button lit between
      // messages. If image_generation was used, it reverts to search.
      setPendingTool(null)
      setPendingAttachments([])

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            content: text,
            attachments: attachmentsForThisSend.length ? attachmentsForThisSend : undefined,
            tool: toolForThisSend,
          }),
        })

        // Handle daily limit (429) + message-too-long (413) gracefully — render
        // ARIA's message in the chat instead of a raw error toast.
        if (res.status === 429 || res.status === 413) {
          let limitMessage = 'You have hit a limit.'
          try {
            const data = await res.json()
            if (data.error) limitMessage = data.error
          } catch {
            /* ignore parse error */
          }
          updateMessage(ariaMsgId, {
            content: limitMessage,
            streaming: false,
          })
          setStreaming(false)
          return
        }

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => 'Network error')
          throw new Error(errText)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let accumulated = ''
        let imageUrl: string | null = null
        let imagePrompt = ''
        let collectedSources: Array<{ title: string; url: string; host: string }> = []

        // 3. Parse SSE
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''

          for (const evt of events) {
            const line = evt.trim()
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try {
              const data = JSON.parse(payload) as
                | { type: 'token'; value: string }
                | { type: 'image'; url: string; prompt: string }
                | { type: 'sources'; sources: Array<{ title: string; url: string; host: string }> }
                | {
                    type: 'done'
                    messageId: string
                    usage?: { tokens: number }
                    memoriesUsed?: number
                    moodContext?: string | null
                  }
                | { type: 'error'; message: string }

              if (data.type === 'token') {
                accumulated += data.value
                updateMessage(ariaMsgId, { content: accumulated, streaming: true })
              } else if (data.type === 'image') {
                imageUrl = data.url
                imagePrompt = data.prompt
                accumulated += `\n\n![${imagePrompt}](${imageUrl})\n`
                updateMessage(ariaMsgId, { content: accumulated, streaming: true })
              } else if (data.type === 'sources') {
                // Store the web sources so the message bubble can render the
                // "Found N web pages" bar with favicon logos.
                collectedSources = data.sources
                updateMessage(ariaMsgId, { sources: collectedSources })
              } else if (data.type === 'done') {
                updateMessage(ariaMsgId, {
                  content: accumulated,
                  streaming: false,
                  id: data.messageId,
                  toolUsed: toolForThisSend ?? (attachmentsForThisSend.length ? 'vision' : null),
                  memoriesUsed: data.memoriesUsed,
                  moodContext: data.moodContext ?? null,
                  sources: collectedSources.length > 0 ? collectedSources : undefined,
                })
                if (data.usage?.tokens) {
                  useAriaStore.getState().addUsage(data.usage.tokens)
                }
                // Voice mode callback — fires when ARIA's full response is ready
                if (onComplete && accumulated.trim()) {
                  onComplete(accumulated)
                }
              } else if (data.type === 'error') {
                updateMessage(ariaMsgId, {
                  content: accumulated || `I ran into trouble there. ${data.message}`,
                  streaming: false,
                })
                toast.error('ARIA had trouble responding')
              }
            } catch {
              // ignore malformed lines
            }
          }
        }

        // If stream ended without a done event, finalize
        updateMessage(ariaMsgId, { streaming: false })

        // 4. Bump conversation updatedAt + preview
        const conv = conversations.find((c) => c.id === conversationId)
        if (conv) {
          upsertConversation({
            ...conv,
            updatedAt: new Date().toISOString(),
            messageCount: conv.messageCount + 2,
            preview: text.slice(0, 120),
            title: conv.messageCount === 0 ? text.slice(0, 60) : conv.title,
          })
        }

        // 5. Auto-memory detection — runs async after the reply is done.
        // All confidence levels surface as an ask card; nothing is saved
        // until the user accepts. Skipped entirely for vision/image-gen/tool
        // messages (no clean user statement to extract from) and for very
        // short user messages.
        const skipDetect =
          toolForThisSend !== null || attachmentsForThisSend.length > 0
        if (!skipDetect && accumulated.trim().length > 0) {
          detectMemory(text, accumulated).catch(() => {
            /* silent — detection is best-effort */
          })
        }
      } catch (err) {
        console.error('[chat.send]', err)
        updateMessage(ariaMsgId, {
          content:
            'I lost the thread for a moment. The connection dropped. Try sending that again — I am here.',
          streaming: false,
        })
        toast.error('Connection dropped')
      } finally {
        setStreaming(false)
      }
    },
    [
      activeConversationId,
      settings,
      pendingAttachments,
      pendingTool,
      appendMessage,
      updateMessage,
      setMessages,
      setStreaming,
      setPendingAttachments,
      setPendingTool,
      upsertConversation,
      conversations,
      setActiveConversation,
    ]
  )

  return { sendMessage }
}
