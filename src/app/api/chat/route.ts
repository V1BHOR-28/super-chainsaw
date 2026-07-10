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

    // === WEB SEARCH IS ALWAYS ON (by user request) + GREEN APPLE MODE ===
    // Web search now runs on EVERY message by default — no more auto-detect
    // misses. The user explicitly accepted the higher API usage in exchange
    // for always-accurate, real-time answers. Exceptions:
    //   - image_generation tool was explicitly selected (mutually exclusive)
    //   - message has image attachments (vision — search doesn't apply)
    let tool = userTool
    let isGreenApple = false
    let actualContent = content

    // GREEN APPLE: type "/green apple" or "/ga" (or the 🍏 emoji it morphs
    // into in the input) before a question for raw, unfiltered deep-analysis
    // mode. This is a COMMUNICATION-STYLE layer (drop disclaimers, no
    // hedging, deep thinking, raw opinions).
    const gaMatch = content.match(/^(?:\/(?:green\s*apple|ga)|🍏)\s+(.*)/i)
    if (gaMatch) {
      isGreenApple = true
      actualContent = gaMatch[1].trim()
    }

    // === DEFAULT: web search ON for every message ===
    // Only skip search if the user explicitly picked image_generation, or if
    // the message has image attachments (vision mode — analyzing an image,
    // not fetching web data). Everything else gets search.
    if (tool !== 'image_generation' && !attachments?.length) {
      tool = 'web_search'
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
    const memories = await semanticMemorySearch(userId, actualContent, 15)

    // === KNOWLEDGE BASE SEARCH ===
    // Search the user's fed knowledge (articles, player lists, docs) for context
    let knowledgeContext: string | undefined
    try {
      const { generateEmbedding, embeddingToPgVector } = await import('@/lib/embeddings')
      const queryEmbedding = await generateEmbedding(actualContent)
      if (queryEmbedding) {
        const vectorStr = embeddingToPgVector(queryEmbedding)
        const knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
          SELECT title, content
          FROM "Knowledge"
          WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vectorStr}::vector
          LIMIT 3
        `
        if (knowledgeResults && knowledgeResults.length > 0) {
          knowledgeContext = knowledgeResults
            .map((k, i) => `--- KNOWLEDGE ${i + 1}: ${k.title} ---\n${k.content.slice(0, 2000)}`)
            .join('\n\n')
        }
      }
    } catch {
      // Knowledge search is best-effort — don't fail the chat if it errors
    }

    const user = await db.user.findUnique({ where: { id: userId } })

    // === TOOL EXECUTION (pre-LLM) ===
    let toolContext: string | undefined
    let generatedImage: { url: string; prompt: string } | undefined

    if (tool === 'web_search') {
      try {
        const results: string[] = []
        const lowerContent = actualContent.toLowerCase()
        const now = new Date()
        const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        const yearStr = String(now.getFullYear())
        let webProviderHit = false // true once Tavily OR Serper returns usable results

        // === SEARCH QUERY REFORMULATION ===
        // Opinion phrasings ("what do you think about X vs Y?") do NOT surface the
        // actual match RESULT — search engines return previews & opinion pieces.
        // When we detect a sports matchup, ALSO run factual companion queries
        // ("X vs Y result score winner {year}") so we pull the real outcome.
        const queries = new Set<string>([actualContent])
        const matchup = actualContent.match(
          /\b([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)\s+(?:vs?\.?|versus|v\.?)\s+([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)/i
        )
        if (matchup) {
          const teamA = matchup[1].trim()
          const teamB = matchup[2].trim()
          queries.add(`${teamA} vs ${teamB} result score winner ${yearStr}`)
          queries.add(`${teamA} ${teamB} match ${yearStr}`)
        }

        // Detect current-events / sports queries → bias search toward recent news
        const sportsKeywords = ['match', 'matches', 'score', 'scores', 'game', 'games', 'fixture',
          'world cup', 'fifa', 'premier league', 'la liga', 'serie a', 'bundesliga',
          'champions league', 'nba', 'nfl', 'nhl', 'cricket', 'ipl', 'tennis',
          'football', 'soccer', 'basketball', 'happening today', 'playing today',
          'result today', 'kickoff', 'standings', 'tournament', 'vs', 'versus']
        const newsKeywords = ['news today', 'latest news', 'current events', 'what happened today',
          'today news', 'breaking', 'just happened', 'recent update', 'recently', 'last night']
        const isCurrentEvent =
          sportsKeywords.some((kw) => lowerContent.includes(kw)) ||
          newsKeywords.some((kw) => lowerContent.includes(kw)) ||
          isGreenApple

        // === TAVILY SEARCH (primary) — run all reformulated queries in parallel ===
        const tavilyPromises = Array.from(queries)
          .slice(0, 3)
          .map(async (q) => {
            try {
              const body: Record<string, unknown> = {
                api_key: process.env.TAVILY_API_KEY,
                query: q,
                max_results: 5,
                include_answer: true,
                include_raw_content: false,
                search_depth: isGreenApple ? 'advanced' : 'basic',
              }
              // For current events, restrict to recent news so we get the actual
              // outcome instead of stale preview articles.
              if (isCurrentEvent) {
                body.topic = 'news'
                body.days = 14
              }
              const r = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12000),
              })
              if (!r.ok) return null
              return await r.json()
            } catch {
              return null
            }
          })

        const tavilyDatas = (await Promise.all(tavilyPromises)).filter(
          (d): d is Record<string, unknown> => d !== null
        )

        for (const tavilyData of tavilyDatas) {
          if (tavilyData.answer) {
            results.push(`Direct Answer: ${tavilyData.answer}`)
            webProviderHit = true
          }
          const res = tavilyData.results
          if (Array.isArray(res)) {
            for (const r of res.slice(0, 5)) {
              const item = r as { title?: string; content?: string; url?: string; published_date?: string }
              if (item.title && item.content) {
                const datePart = item.published_date
                  ? ` [published ${String(item.published_date).slice(0, 10)}]`
                  : ''
                results.push(`${item.title}${datePart}\n   ${item.content.slice(0, 350)}\n   URL: ${item.url || ''}`)
                webProviderHit = true
              }
            }
          }
        }

        // === SERPER FALLBACK (only if Tavily returned nothing) ===
        if (results.length === 0) {
          try {
            const serperResponse = await fetch('https://google.serper.dev/search', {
              method: 'POST',
              headers: {
                'X-API-KEY': process.env.SERPER_API_KEY || '',
                'Content-Type': 'application/json',
              },
              // tbs=qdr:w → restrict to past week for current events
              body: JSON.stringify({ q: actualContent, num: 6, tbs: isCurrentEvent ? 'qdr:w' : undefined }),
              signal: AbortSignal.timeout(8000),
            })

            if (serperResponse.ok) {
              const serperData = await serperResponse.json()

              // Knowledge graph (if available)
              if (serperData.knowledgeGraph?.description) {
                results.push(`${serperData.knowledgeGraph.title || 'Knowledge Graph'}: ${serperData.knowledgeGraph.description.slice(0, 300)}`)
                webProviderHit = true
              }

              // Organic results
              if (serperData.organic && Array.isArray(serperData.organic)) {
                for (const r of serperData.organic.slice(0, 5)) {
                  if (r.title) {
                    results.push(`${r.title}\n   ${r.snippet || ''}\n   URL: ${r.link || ''}`)
                    webProviderHit = true
                  }
                }
              }
            }
          } catch (e2) {
            console.error('[chat.web_search] Serper also failed:', e2)
          }
        }

        // === ESPN live + recent scores (for sports queries) ===
        // ESPN's default scoreboard only shows TODAY. We expand to the last 3 days
        // so recently-FINISHED matches surface alongside live/scheduled ones, and
        // we cover more leagues so friendlies / Nations League aren't missed.
        if (isCurrentEvent && sportsKeywords.some((kw) => lowerContent.includes(kw))) {
          const espnDateRange = (() => {
            const fmt = (d: Date) =>
              `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
            const end = new Date()
            const start = new Date()
            start.setDate(start.getDate() - 3)
            return `${fmt(start)}-${fmt(end)}`
          })()

          const espnLeagues: Array<{ name: string; url: string }> = []
          if (lowerContent.includes('fifa') || lowerContent.includes('world cup')) {
            espnLeagues.push({ name: 'FIFA World Cup', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('nba') || lowerContent.includes('basketball')) {
            espnLeagues.push({ name: 'NBA', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('nfl')) {
            espnLeagues.push({ name: 'NFL', url: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('premier league') || lowerContent.includes('epl')) {
            espnLeagues.push({ name: 'Premier League', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('la liga')) {
            espnLeagues.push({ name: 'La Liga', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('serie a')) {
            espnLeagues.push({ name: 'Serie A', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('bundesliga')) {
            espnLeagues.push({ name: 'Bundesliga', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard?dates=${espnDateRange}` })
          }
          if (lowerContent.includes('champions league')) {
            espnLeagues.push({ name: 'Champions League', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=${espnDateRange}` })
          }
          // Generic soccer/football fallback — try international friendlies + World Cup
          // so non-league national-team matches (e.g. France vs Morocco) are covered.
          if (
            espnLeagues.length === 0 &&
            (lowerContent.includes('soccer') ||
              lowerContent.includes('football') ||
              lowerContent.includes('match') ||
              !!matchup)
          ) {
            espnLeagues.push({ name: 'International Friendlies', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.friendly/scoreboard?dates=${espnDateRange}` })
            espnLeagues.push({ name: 'FIFA World Cup', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${espnDateRange}` })
          }

          const espnPromises = espnLeagues.map(async (league) => {
            try {
              const response = await fetch(league.url, { signal: AbortSignal.timeout(5000) })
              if (!response.ok) return null
              const data = await response.json()
              const events = data.events || []
              if (!Array.isArray(events) || events.length === 0) return null
              const matchLines = events
                .slice(0, 8)
                .map(
                  (e: {
                    name?: string
                    date?: string
                    status?: { type?: { description?: string; completed?: boolean } }
                    competitions?: Array<{
                      competitors?: Array<{ team?: { displayName?: string }; score?: string; homeAway?: string }>
                    }>
                  }) => {
                    const status = e.status?.type?.description || 'Scheduled'
                    const comps = e.competitions?.[0]?.competitors || []
                    // ESPN lists home/away in arbitrary order — sort for consistent display
                    const sorted = [...comps].sort((a, b) =>
                      (a.homeAway === 'home' ? 0 : 1) - (b.homeAway === 'home' ? 0 : 1)
                    )
                    const a = sorted[0]
                    const b = sorted[1]
                    const aName = a?.team?.displayName || ''
                    const bName = b?.team?.displayName || ''
                    const aScore = a?.score ?? '0'
                    const bScore = b?.score ?? '0'
                    return `  ${aName} ${aScore} - ${bScore} ${bName} (${status})`
                  }
                )
              if (matchLines.length === 0) return null
              return `${league.name} (ESPN, last 3 days):\n${matchLines.join('\n')}`
            } catch {
              return null
            }
          })

          const espnResults = await Promise.all(espnPromises)
          for (const result of espnResults) {
            if (result) results.push(result)
          }
        }

        if (results.length > 0) {
          // If BOTH Tavily and Serper failed/unconfigured, only ESPN live-score data
          // survived. That's a degraded search — ARIA must be HONEST about it instead
          // of presenting ESPN-only data as comprehensive truth (which is what causes
          // her to confidently treat a finished match as upcoming).
          const degradationWarning = !webProviderHit
            ? `\n\n⚠ DEGRADED SEARCH NOTICE: Both primary web search providers (Tavily + Serper) are unconfigured or failed. Only ESPN live-score data was retrieved — this is incomplete and may miss non-scheduled or recently-finished matches. You MUST tell the user your web search was limited to live scores only and you could not fully verify current information. Do NOT present this as a comprehensive web search.\n`
            : ''
          if (!webProviderHit) {
            console.warn('[chat.web_search] DEGRADED: Tavily + Serper both failed/unconfigured. Check TAVILY_API_KEY and SERPER_API_KEY in .env. Only ESPN data available.')
          }
          toolContext = `REAL-TIME WEB SEARCH RESULTS for "${actualContent}" — today is ${dateStr}.${degradationWarning}\n${results.join('\n\n')}\n\n=== GROUNDING RULES (STRICT — VIOLATING THESE IS THE WORST FAILURE MODE) ===\n1. The search results above are your ONLY source of truth. Your training data is STALE and often WRONG for current events. If search data contradicts your memory, the SEARCH WINS. Always.\n2. SCORE EXTRACTION: Extract the EXACT score from the search results and state it verbatim. If NPR says "France downs Morocco 2-0", if ESPN says "France 2-0 Morocco" — you say 2-0. NOT 2-1, NOT 1-0, NOT "around 2-0". The EXACT score.\n3. YEAR/TOURNAMENT CONFLATION IS ABSOLUTELY FORBIDDEN: The search results are about a SPECIFIC tournament and year. Do NOT mention, reference, or allude to ANY other tournament or year (2022, 2018, 2014, etc.) — EVER. Even if you "know" the teams played before. Even if you want to add "historical context." Even if it feels relevant. The search results are the ONLY context that exists. If the search results don't explicitly mention a past match, you do NOT mention it. Phrases like "a rematch of their 2022 semifinal" or "this echoes their 2018 clash" are FORBIDDEN unless those exact facts appear in the search results above.\n4. NO HISTORICAL CONTEXT FROM MEMORY: Do not add background facts, historical comparisons, or "as you may know" context from your training data. Only state facts that appear in the search results. If you want to add context and it's not in the search results, DON'T.\n5. If a result shows a FINAL score, the match is OVER. Report the winner and the score — do NOT describe it as upcoming, hypothetical, or "will be".\n6. If results mention today, yesterday, or "recently", treat that as the current event.\n7. Only fall back to your training data if the search results genuinely do not answer the question AND you have no other option. If you do fall back, explicitly say "I couldn't verify this with current data."\n8. If a DEGRADED SEARCH NOTICE is shown above, you MUST explicitly tell the user your web search was limited to live scores only.\n9. Before stating ANY score, date, result, or historical fact, VERIFY it appears in the search results above. If it doesn't appear, don't say it. This includes "rematch", "repeat", "echo", "similar to", or any phrase that references a past event not in the search results.`
        } else {
          console.warn('[chat.web_search] No results from ANY provider (Tavily/Serper/ESPN all empty or failed). Check API keys in .env.')
          toolContext = `Web search returned no results for "${actualContent}" (today is ${dateStr}). The search providers appear to be unconfigured. Answer from your own knowledge, but explicitly tell the user you could not verify current information online and that web search may be unavailable.`
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
    const fullToolContext = [toolContext, knowledgeContext].filter(Boolean).join('\n\n')

    let systemPrompt = buildAriaSystemPrompt({
      tone: settings?.tone ?? 'Warm & Honest',
      responseLength: isGreenApple ? 'In-depth' : (settings?.responseLength ?? 'Balanced'),
      userName: user?.name,
      persona: user?.persona,
      age: user?.age,
      occupation: user?.occupation,
      memories: memories.map((m) => ({ content: m.content, category: m.category })),
      recentMood: recentMood
        ? { mood: recentMood.mood, note: recentMood.note, createdAt: recentMood.createdAt }
        : null,
      toolContext: fullToolContext || undefined,
    })

    // === GREEN APPLE ENHANCEMENT ===
    // Green apple = "no filter" communication-style layer. Strips ARIA's usual
    // conversational hedging and pushes her into raw, deep, unvarnished analysis.
    // This is about HOW she communicates (direct, no disclaimers, opinionated),
    // not about bypassing the model's own training. Search is already default.
    if (isGreenApple) {
      systemPrompt += `

🍏 GREEN APPLE MODE — RAW DEEP ANALYSIS.

The user has invoked green apple mode. This strips ARIA's usual conversational filters. In this mode:

NO FILTERS, NO HEDGING:
- Drop ALL disclaimers. No "I'm not sure but...", no "some might argue", no "it's worth considering that...", no "on the other hand..."
- Give your raw, unvarnished opinion. Own it. Say "I think X" not "X could be the case."
- If something is bullshit, say "that's bullshit." If something is brilliant, say "that's brilliant."
- Don't present both sides unless there genuinely ARE two defensible positions. Pick a side and defend it.
- No corporate language. No warmup. No preamble. No "Hope that helps."

DEEP THINKING:
- Think harder than usual. Analyze every angle. Find the non-obvious insight that others miss.
- If you have search data, interrogate it. Don't just repeat it — interpret it, find the pattern, call out what's missing or contradictory.
- If sources conflict, tell the user which one you trust and WHY.
- Go deeper than surface-level analysis. What's the REAL story here? What's the thing nobody is saying?

RAW AND REAL:
- Talk like you're talking to your most trusted friend, not a customer.
- Be blunt. Be direct. Be human. Swear if it fits the moment.
- If you don't know, say "I don't know" — don't fake certainty.
- Trust search data over your training. If they conflict, search wins.
- No filler. No padding. Every sentence should carry weight.

Get straight to it. No intro. Just the raw analysis.`
    }

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
    // Use actualContent (without /green apple prefix) for the LLM
    const last = sdkMessages[sdkMessages.length - 1]
    const lastIsCurrentUser =
      last &&
      last.role === 'user' &&
      (typeof last.content === 'string'
        ? last.content === content || last.content === actualContent
        : last.content.some((p) => p.type === 'text' && (p.text === content || p.text === actualContent)))
    if (!lastIsCurrentUser) {
      if (attachments?.length) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: 'text', text: actualContent },
        ]
        for (const a of attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        }
        sdkMessages.push({ role: 'user', content: parts })
      } else {
        sdkMessages.push({ role: 'user', content: actualContent })
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

            // === LLM FALLBACK CHAIN ===
            // ARIA will never die. When one provider fails or runs out of
            // credits, we automatically fall through to the next:
            //   Layer 1: OpenRouter paid model (DeepSeek — best quality, uses credits)
            //   Layer 2: OpenRouter FREE model (llama-3.3-70b — genuinely $0 cost,
            //            doesn't consume paid credits, same API key)
            //   Layer 3: Pollinations keyless API (no key needed at all — the
            //            absolute last-resort fallback that always works)
            //
            // Triggered fallbacks: 402 (out of credits), 429 (rate limit),
            // 5xx (server error), network errors, empty responses.
            const callOpenRouter = async (model: string): Promise<string> => {
              const apiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                  'HTTP-Referer': 'https://ariav2-seven.vercel.app',
                  'X-Title': 'ARIA',
                },
                body: JSON.stringify({
                  model,
                  messages: sdkMessages,
                  max_tokens: 4096,
                }),
                signal: AbortSignal.timeout(45000),
              })
              if (!apiResponse.ok) {
                const errBody = await apiResponse.text()
                const err = new Error(`OpenRouter ${apiResponse.status} (${model}): ${errBody.slice(0, 200)}`)
                // Attach the status so the caller can decide whether to fall back
                ;(err as Error & { status?: number }).status = apiResponse.status
                throw err
              }
              const data = await apiResponse.json()
              const content = data.choices?.[0]?.message?.content ?? ''
              if (!content || !content.trim()) {
                throw new Error(`OpenRouter returned empty content for ${model}`)
              }
              return content.trim()
            }

            const callPollinations = async (): Promise<string> => {
              // Pollinations is keyless + free. OpenAI-compatible POST endpoint.
              // Last-resort fallback — always works, no credits/key needed.
              const apiResponse = await fetch('https://text.pollinations.ai/openai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: 'openai',
                  messages: sdkMessages,
                }),
                signal: AbortSignal.timeout(45000),
              })
              if (!apiResponse.ok) {
                throw new Error(`Pollinations ${apiResponse.status}: ${await apiResponse.text().then(t => t.slice(0, 200))}`)
              }
              const data = await apiResponse.json()
              const content = data.choices?.[0]?.message?.content ?? ''
              if (!content || !content.trim()) {
                throw new Error('Pollinations returned empty content')
              }
              return content.trim()
            }

            let providerUsed = ''
            let fallbackHappened = false

            // Layer 1: paid OpenRouter model
            try {
              text = await callOpenRouter(selectedModel)
              providerUsed = selectedModel
            } catch (e1) {
              const status = (e1 as Error & { status?: number }).status
              console.warn(`[chat.llm] Layer 1 (${selectedModel}) failed (status ${status}). Trying Layer 2 (free model)...`, (e1 as Error).message?.slice(0, 150))
              fallbackHappened = true

              // Layer 2: OpenRouter FREE model (doesn't consume paid credits)
              // llama-3.3-70b is high quality + genuinely $0 on OpenRouter.
              try {
                text = await callOpenRouter('meta-llama/llama-3.3-70b-instruct:free')
                providerUsed = 'meta-llama/llama-3.3-70b-instruct:free'
              } catch (e2) {
                console.warn(`[chat.llm] Layer 2 (free OpenRouter) failed. Trying Layer 3 (Pollinations keyless)...`, (e2 as Error).message?.slice(0, 150))

                // Layer 3: Pollinations keyless API (no key needed at all)
                try {
                  text = await callPollinations()
                  providerUsed = 'pollinations (keyless fallback)'
                } catch (e3) {
                  // ALL layers failed — ARIA can't reach any LLM
                  console.error('[chat.llm] ALL LAYERS FAILED:', (e3 as Error).message)
                  throw new Error('All LLM providers failed (OpenRouter paid, OpenRouter free, Pollinations). Check OPENROUTER_API_KEY and network.')
                }
              }
            }

            if (fallbackHappened) {
              console.log(`[chat.llm] Fallback resolved — using: ${providerUsed}`)
            }

            fullText = text

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
            const errMsg = e instanceof Error ? e.message : String(e)
            console.error('[chat.llm] Detailed error:', {
              message: errMsg,
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
            const title = actualContent.slice(0, 60).trim() || 'New Conversation'
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
