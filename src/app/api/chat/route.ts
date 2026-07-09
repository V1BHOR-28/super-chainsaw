import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { buildAriaSystemPrompt } from '@/lib/aria'
import { recordUsage, estimateTokens, hasHitDailyLimit } from '@/lib/usage'

/** Hard cap on user message length — protects against abuse / accidental huge pastes. */
const MAX_MESSAGE_LENGTH = 12_000

/**
 * POST /api/chat — streaming chat completion (SSE)
 *
 * Body: {
 *   conversationId: string,
 *   content: string,
 *   attachments?: { type: 'image', dataUrl: string, name: string }[],
 *   tool?: 'web_search' | 'image_generation' | null,
 * }
 *
 * SSE events:
 *   data: { type: 'token', value: string }       — streamed token
 *   data: { type: 'tool', tool: string, data: any } — tool result context
 *   data: { type: 'image', url: string }         — generated image
 *   data: { type: 'done', messageId: string }    — final message saved
 *   data: { type: 'error', message: string }
 *   data: { type: 'limit', message: string, resetsAt: string }  — daily limit hit
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const { conversationId, content, attachments, tool } = body as {
      conversationId: string
      content: string
      attachments?: { type: 'image'; dataUrl: string; name: string }[]
      tool?: 'web_search' | 'image_generation' | null
    }

    if (!conversationId || !content?.trim()) {
      return new Response(JSON.stringify({ error: 'conversationId and content required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Message length cap — prevents abuse / accidental huge pastes from blowing token budget
    if (content.length > MAX_MESSAGE_LENGTH) {
      return new Response(
        JSON.stringify({
          error: `Message too long. Please keep it under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`,
        }),
        { status: 413, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Enforce daily token limit — return 429 with a friendly message + reset time.
    // The client renders this as a special SSE 'limit' event so ARIA can show it
    // as a graceful message in the chat instead of a raw error.
    const limitState = await hasHitDailyLimit()
    if (limitState.limited) {
      const resetDate = new Date(limitState.resetsAt)
      const resetLabel = resetDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      return new Response(
        JSON.stringify({
          error: `You've hit today's session limit. ARIA will be back at ${resetLabel} UTC. Your conversations and memories are safe — just come back tomorrow.`,
          resetsAt: limitState.resetsAt,
          dailyLimit: limitState.dailyLimit,
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Verify ownership
    const conversation = await db.conversation.findFirst({ where: { id: conversationId, userId } })
    if (!conversation) {
      return new Response(JSON.stringify({ error: 'Conversation not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Persist the user message immediately
    await db.message.create({
      data: {
        conversationId,
        role: 'user',
        content,
        attachmentsJson: attachments ? JSON.stringify(attachments) : null,
      },
    })
    // Touch conversation for sort order
    await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })

    // Load settings, recent mood, recent messages — use semantic memory search
    const [settings, recentMood, recentMessages] = await Promise.all([
      db.userSettings.findUnique({ where: { userId } }),
      db.mood.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      db.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
    ])

    // Semantic memory search: find memories most relevant to what the user just said
    // Falls back to most-recent if embeddings aren't available
    const { semanticMemorySearch } = await import('@/app/api/memory/route')
    const memories = await semanticMemorySearch(userId, content, 15)

    const user = await db.user.findUnique({ where: { id: userId } })

    // === TOOL EXECUTION (pre-LLM) ===
    let toolContext: string | undefined
    let generatedImage: { url: string; prompt: string } | undefined

    if (tool === 'web_search') {
      try {
        // DuckDuckGo Instant Answer API — free, no key, works on Vercel
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(content)}&format=json&no_html=1&skip_disambig=1`
        const searchResponse = await fetch(searchUrl)
        if (searchResponse.ok) {
          const searchData = await searchResponse.json()
          const results: string[] = []

          // DuckDuckGo returns an AbstractText (main answer) + RelatedTopics
          if (searchData.AbstractText) {
            results.push(`1. ${searchData.Heading || 'Answer'}: ${searchData.AbstractText}\n   Source: ${searchData.AbstractSource || 'DuckDuckGo'}\n   URL: ${searchData.AbstractURL || ''}`)
          }

          // Parse related topics (can be nested)
          if (searchData.RelatedTopics && Array.isArray(searchData.RelatedTopics)) {
            let topicNum = results.length + 1
            for (const topic of searchData.RelatedTopics.slice(0, 5)) {
              if (topic.Text && topic.FirstURL) {
                results.push(`${topicNum}. ${topic.Text}\n   URL: ${topic.FirstURL}`)
                topicNum++
              } else if (topic.Topics && Array.isArray(topic.Topics)) {
                for (const subTopic of topic.Topics.slice(0, 2)) {
                  if (subTopic.Text && subTopic.FirstURL) {
                    results.push(`${topicNum}. ${subTopic.Text}\n   URL: ${subTopic.FirstURL}`)
                    topicNum++
                  }
                }
              }
            }
          }

          if (results.length > 0) {
            toolContext = `Web search results for "${content}":\n${results.join('\n\n')}`
          } else {
            toolContext = `Web search returned no instant answers for "${content}". Answer from your own knowledge.`
          }
        } else {
          toolContext = 'Web search was attempted but failed. Answer from your own knowledge.'
        }
      } catch (e) {
        console.error('[chat.web_search]', e)
        toolContext = 'Web search was attempted but failed. Answer from your own knowledge.'
      }
    }

    if (tool === 'image_generation') {
      try {
        // Pollinations.ai — free, no API key, works on Vercel
        // Returns a direct image URL (not base64) — we pass it to the frontend
        const encodedPrompt = encodeURIComponent(content.slice(0, 500))
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`
        generatedImage = { url: imageUrl, prompt: content }
      } catch (e) {
        console.error('[chat.image_gen]', e)
      }
    }

    // === BUILD MESSAGE PAYLOAD ===
    const systemPrompt = buildAriaSystemPrompt({
      tone: settings?.tone ?? 'Warm & Honest',
      responseLength: settings?.responseLength ?? 'Balanced',
      userName: user?.name,
      persona: user?.persona,
      age: user?.age,
      occupation: user?.occupation,
      memories: memories.map((m) => ({ content: m.content, category: m.category })),
      recentMood: recentMood
        ? { mood: recentMood.mood, note: recentMood.note, createdAt: recentMood.createdAt }
        : null,
      toolContext,
    })

    // Map DB messages to SDK format; include vision content for the latest user message if images attached
    type SdkMessage = {
      role: 'system' | 'user' | 'assistant'
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    }

    const sdkMessages: SdkMessage[] = [{ role: 'system', content: systemPrompt }]

    for (const m of recentMessages) {
      // Skip the just-persisted user message with attachments — we'll re-add it with vision content
      if (m.role === 'user' && m.content === content && attachments?.length) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: 'text', text: m.content },
        ]
        for (const a of attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        }
        sdkMessages.push({ role: 'user', content: parts })
        continue
      }
      sdkMessages.push({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? ('system' as const) : 'user',
        content: m.content,
      })
    }

    // If the last message wasn't the vision-augmented one, ensure the user content is present
    const last = sdkMessages[sdkMessages.length - 1]
    const lastIsCurrentUser =
      last &&
      last.role === 'user' &&
      (typeof last.content === 'string'
        ? last.content === content
        : last.content.some((p) => p.type === 'text' && p.text === content))
    if (!lastIsCurrentUser) {
      if (attachments?.length) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: 'text', text: content },
        ]
        for (const a of attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        }
        sdkMessages.push({ role: 'user', content: parts })
      } else {
        sdkMessages.push({ role: 'user', content })
      }
    }

    // === STREAM ===
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

        try {
          // If an image was generated, surface it first
          if (generatedImage) {
            send({ type: 'image', url: generatedImage.url, prompt: generatedImage.prompt })
          }

          // Call OpenRouter API non-streaming, then stream the result word-by-word
          // to the client for the typewriter effect.
          let fullText = ''

          try {
            let text = ''

            // Get user's model preference (default: DeepSeek)
            const { getModelFromSettings } = await import('@/lib/embeddings')
            const selectedModel = getModelFromSettings(settings?.modelPreference)

            // PRIMARY PATH: OpenRouter API with user's selected model
            const apiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://ariav2-seven.vercel.app',
                'X-Title': 'ARIA',
              },
              body: JSON.stringify({
                model: selectedModel,
                messages: sdkMessages,
              }),
            })

            if (!apiResponse.ok) {
              throw new Error(`OpenRouter API returned ${apiResponse.status}: ${await apiResponse.text()}`)
            }

            const apiData = await apiResponse.json()
            text = apiData.choices?.[0]?.message?.content ?? ''

            fullText = text.trim()

            if (!fullText) {
              fullText =
                "I'm here, but my words aren't coming through clearly. Try sending that again."
            }

            // Stream word-by-word for the typewriter effect.
            // Split on whitespace but keep the separators so spacing is preserved.
            const tokens = fullText.split(/(\s+)/)
            for (const t of tokens) {
              if (!t) continue
              send({ type: 'token', value: t })
              // Slightly variable delay — slower on punctuation for a natural cadence.
              const isPunct = /[.!?,;:—]/.test(t)
              await new Promise((r) => setTimeout(r, isPunct ? 40 : 12))
            }
          } catch (e) {
            console.error('[chat.llm] Detailed error:', {
              message: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? e.stack : undefined,
              name: e instanceof Error ? e.name : undefined,
            })
            fullText =
              "I lost my train of thought there for a moment. The connection to my reasoning layer dropped. Try sending that again — I'm here."
            send({ type: 'token', value: fullText })
          }

          // Persist ARIA's reply
          const saved = await db.message.create({
            data: {
              conversationId,
              role: 'assistant',
              content: fullText,
              toolUsed: tool ?? (attachments?.length ? 'vision' : null),
              attachmentsJson: generatedImage
                ? JSON.stringify([{ type: 'image', dataUrl: generatedImage.url }])
                : null,
            },
          })

          // Auto-title the conversation on first exchange
          if (recentMessages.length <= 1) {
            const title = content.slice(0, 60).trim() || 'New Conversation'
            await db.conversation.update({ where: { id: conversationId }, data: { title } })
          }

          // Record token usage for the daily meter.
          // Estimate = system prompt + user message + ARIA's reply (chars / 4).
          const inputTokens =
            estimateTokens(systemPrompt) + estimateTokens(content) + estimateTokens(toolContext ?? '')
          const outputTokens = estimateTokens(fullText)
          try {
            await recordUsage(inputTokens + outputTokens)
          } catch (e) {
            console.error('[chat.usage]', e)
          }

          send({
            type: 'done',
            messageId: saved.id,
            usage: { tokens: inputTokens + outputTokens },
            memoriesUsed: memories.length,
            moodContext: recentMood ? recentMood.mood : null,
          })
        } catch (e) {
          console.error('[chat.stream]', e)
          send({ type: 'error', message: (e as Error).message })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (err) {
    console.error('[chat]', err)
    return new Response(JSON.stringify({ error: 'Chat failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
