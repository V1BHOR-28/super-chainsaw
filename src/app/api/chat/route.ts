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
    const { conversationId, content, attachments, tool: userTool } = body as {
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

    // === AUTO-DETECT WEB SEARCH ===
    // If the user didn't explicitly toggle a tool, auto-detect if they need web search.
    // This prevents the user from having to manually toggle search for every query.
    let tool = userTool
    if (!tool) {
      const lower = content.toLowerCase()
      // Sports/live data queries
      const sportsKeywords = ['match', 'matches', 'score', 'scores', 'game today', 'fixture',
        'world cup', 'fifa', 'premier league', 'la liga', 'serie a', 'bundesliga',
        'champions league', 'nba', 'nfl', 'nhl', 'cricket', 'ipl', 'tennis',
        'football today', 'soccer today', 'happening today', 'playing today',
        'result today', 'results today', 'kickoff', 'kick off', 'lineup',
        'standings', 'tournament today', 'playoff']
      // News/current events queries
      const newsKeywords = ['news today', 'latest news', 'current events', 'what happened today',
        'today news', 'breaking', 'just happened', 'recent update']
      // Real-time queries
      const realtimeKeywords = ['live score', 'live match', 'right now', 'currently playing',
        'who is winning', 'whats the score', "what's the score"]

      const needsSearch = sportsKeywords.some(kw => lower.includes(kw)) ||
                         newsKeywords.some(kw => lower.includes(kw)) ||
                         realtimeKeywords.some(kw => lower.includes(kw))

      // Don't auto-search for very short messages (follow-ups like "yes", "ok", "which one")
      // or questions that reference previous context ("which world cup are you talking about")
      const isFollowUp = content.length < 50 && (
        lower.includes('which') || lower.includes('what about') || lower.includes('you mean') ||
        lower.includes('talking about') || lower.includes('are you sure') || lower.includes('really') ||
        lower.includes('but ') || lower.includes('wait') || lower.includes('how can')
      )

      if (needsSearch && !isFollowUp) {
        tool = 'web_search'
      }
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
        const results: string[] = []
        const lowerContent = content.toLowerCase()

        // === SPORTS DETECTION ===
        // Check if the question is about sports/matches/scores
        const sportsKeywords = ['match', 'matches', 'score', 'scores', 'game', 'games', 'fixture', 'fixtures',
          'world cup', 'fifa', 'premier league', 'la liga', 'serie a', 'bundesliga', 'champions league',
          'nba', 'nfl', 'nhl', 'mlb', 'cricket', 'ipl', 'tennis', 'atp', 'wta', 'ufc', 'boxing',
          'football', 'soccer', 'basketball', 'baseball', 'hockey', 'today', 'tonight', 'result', 'results',
          'kickoff', 'kick off', 'lineup', 'standings', 'table', 'tournament', 'playoff', 'playoffs']

        const isSportsQuery = sportsKeywords.some(kw => lowerContent.includes(kw))

        if (isSportsQuery) {
          // === ESPN API — live sports data ===
          // Map common sports to ESPN league codes
          const espnLeagues: Array<{ name: string; url: string }> = []

          if (lowerContent.includes('fifa') || lowerContent.includes('world cup')) {
            espnLeagues.push({ name: 'FIFA World Cup', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard' })
          }
          if (lowerContent.includes('premier league') || lowerContent.includes('epl')) {
            espnLeagues.push({ name: 'Premier League', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' })
          }
          if (lowerContent.includes('la liga')) {
            espnLeagues.push({ name: 'La Liga', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' })
          }
          if (lowerContent.includes('serie a')) {
            espnLeagues.push({ name: 'Serie A', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard' })
          }
          if (lowerContent.includes('bundesliga')) {
            espnLeagues.push({ name: 'Bundesliga', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard' })
          }
          if (lowerContent.includes('champions league') || lowerContent.includes('ucl')) {
            espnLeagues.push({ name: 'Champions League', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' })
          }
          if (lowerContent.includes('nba') || lowerContent.includes('basketball')) {
            espnLeagues.push({ name: 'NBA', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' })
          }
          if (lowerContent.includes('nfl') || lowerContent.includes('american football')) {
            espnLeagues.push({ name: 'NFL', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' })
          }
          if (lowerContent.includes('cricket') || lowerContent.includes('ipl')) {
            espnLeagues.push({ name: 'Cricket', url: 'https://site.api.espn.com/apis/site/v2/sports/cricket/icc.scoreboard' })
          }
          if (lowerContent.includes('tennis') || lowerContent.includes('atp') || lowerContent.includes('wta')) {
            espnLeagues.push({ name: 'Tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' })
          }

          // If no specific league detected, try FIFA + general soccer
          if (espnLeagues.length === 0) {
            espnLeagues.push(
              { name: 'FIFA World Cup', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard' },
              { name: 'Soccer (General)', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' }
            )
          }

          // Fetch all detected leagues in parallel
          const espnPromises = espnLeagues.map(async (league) => {
            try {
              const response = await fetch(league.url, {
                signal: AbortSignal.timeout(5000),
              })
              if (!response.ok) return null
              const data = await response.json()
              const events = data.events || []

              if (events.length === 0) {
                return `${league.name}: No matches scheduled.`
              }

              const matchLines = events.slice(0, 5).map((e: { name: string; status?: { type?: { description?: string } }; competitions?: Array<{ competitors?: Array<{ team?: { displayName?: string }; score?: string }> }> }) => {
                const status = e.status?.type?.description || 'Unknown'
                const home = e.competitions?.[0]?.competitors?.[0]?.team?.displayName || ''
                const away = e.competitions?.[0]?.competitors?.[1]?.team?.displayName || ''
                const homeScore = e.competitions?.[0]?.competitors?.[0]?.score || '0'
                const awayScore = e.competitions?.[0]?.competitors?.[1]?.score || '0'
                return `  ${home} ${homeScore} - ${awayScore} ${away} (${status})`
              })

              return `${league.name}:\n${matchLines.join('\n')}`
            } catch {
              return null
            }
          })

          const espnResults = await Promise.all(espnPromises)
          for (const result of espnResults) {
            if (result) {
              results.push(`${results.length + 1}. ${result}`)
            }
          }
        }

        // === WIKIPEDIA (for non-sports or supplementary info) ===
        // Always fetch Wikipedia in parallel — it adds context
        const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(content)}&format=json&srlimit=3`
        const wikiSearchResponse = await fetch(wikiSearchUrl, {
          headers: { 'User-Agent': 'ARIA/1.0 (https://ariav2-seven.vercel.app)' },
          signal: AbortSignal.timeout(8000),
        })

        if (wikiSearchResponse.ok) {
          const wikiData = await wikiSearchResponse.json()
          const wikiResults = wikiData?.query?.search || []

          const summaryPromises = wikiResults.slice(0, 3).map(async (result: { title: string }) => {
            const title = result.title
            const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
            try {
              const summaryResponse = await fetch(summaryUrl, {
                headers: { 'User-Agent': 'ARIA/1.0 (https://ariav2-seven.vercel.app)' },
                signal: AbortSignal.timeout(5000),
              })
              if (summaryResponse.ok) {
                const summaryData = await summaryResponse.json()
                if (summaryData.extract) {
                  return `${title} (Wikipedia)\n   ${summaryData.extract.slice(0, 400)}\n   URL: ${summaryData.content_urls?.desktop?.page || ''}`
                }
              }
            } catch {
              // skip
            }
            return null
          })

          const summaries = await Promise.all(summaryPromises)
          for (const summary of summaries) {
            if (summary) {
              results.push(`${results.length + 1}. ${summary}`)
            }
          }
        }

        if (results.length > 0) {
          toolContext = `Web search results for "${content}":\n${results.join('\n\n')}`
        } else {
          toolContext = `Web search returned no results for "${content}". Answer from your own knowledge and be honest about uncertainty.`
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
