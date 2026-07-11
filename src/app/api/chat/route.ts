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

    // === GREEN APPLE MODE ===
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

    // === SMART WEB SEARCH + TOGGLE ===
    // Web search is ON by default BUT:
    //   1. User can toggle it OFF via the globe button (pendingTool = null means off)
    //   2. Skip search for short casual messages ("hi", "yeah", "thanks") — these
    //      don't need web data and skipping them makes ARIA respond in 2-3s instead
    //      of 40s. This also prevents Groq 413 (payload too large) by not adding
    //      search results to casual conversations.
    if (tool !== 'image_generation' && !attachments?.length) {
      // Check if user explicitly turned OFF search (pendingTool = null from globe toggle)
      // userTool === null means the frontend sent null (user turned it off)
      

      // Smart skip: don't search for casual/greeting messages
      const lowerContent = content.toLowerCase().trim()
      const casualPatterns = [
        /^(hi|hey|hello|yo|sup|hi aria|hey aria)\b/i,
        /^(yeah|yes|no|ok|okay|sure|cool|nice|got it|makes sense)\b/i,
        /^(thanks|thank you|thx|ty)\b/i,
        /^(lol|lmao|haha|hmm|oh|wow|damn|fr|true|right)\b/i,
        /^(bye|goodbye|see ya|cya)\b/i,
        /^(how are you|how are u|whats up|what's up|how's it going)\b/i,
      ]
      const isCasual = casualPatterns.some(p => p.test(lowerContent)) || lowerContent.length < 12

      if (userTool === 'web_search' && !isCasual) {
        tool = 'web_search'
      } else {
        tool = null // skip search — respond fast
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
        // Only send the last 4 messages (2 exchanges) to keep the payload small.
        // Long conversations (e.g. medical case discussions) bloat the payload
        // and cause Groq 413 errors. 4 messages = enough context for follow-ups
        // without exceeding the model's request size limit.
        take: 4,
      }),
    ])

    // Semantic memory search: find memories most relevant to what the user just said
    // Falls back to most-recent if embeddings aren't available
    const { semanticMemorySearch } = await import('@/app/api/memory/route')
    const memories = await semanticMemorySearch(userId, actualContent, 15)

    // === KNOWLEDGE BASE SEARCH ===
    // Search the user's fed knowledge (articles, player lists, docs, PDFs) for
    // context relevant to what the user just said. Two paths:
    //   1. Semantic search via pgvector (if OPENAI_API_KEY is configured + the
    //      knowledge has an embedding) — finds by MEANING.
    //   2. Text search fallback (ILIKE) — finds by keyword. This ensures fed
    //      knowledge is ALWAYS retrievable even if embeddings aren't generated.
    let knowledgeContext: string | undefined
    try {
      const { generateEmbedding, embeddingToPgVector } = await import('@/lib/embeddings')
      const queryEmbedding = await generateEmbedding(actualContent)
      let knowledgeResults: Array<{ title: string; content: string }> = []

      if (queryEmbedding) {
        // Semantic search — finds by meaning, not just exact keywords.
        // Fetch TOP 5 chunks normally, but only 3 when green apple is active
        // (green apple adds prompt chars, so reduce knowledge to prevent Groq 413).
        const vectorStr = embeddingToPgVector(queryEmbedding)
        knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
          SELECT title, content
          FROM "Knowledge"
          WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vectorStr}::vector
          LIMIT 5
        `
      }

      // Fallback: if no embedding results (key not configured, or knowledge
      // stored without embedding), do a keyword ILIKE search. Extracts the
      // most distinctive words from the user's message and matches them.
      // Includes numbers (e.g. "chapter 8") so chapter-specific questions work.
      if (knowledgeResults.length === 0) {
        // Extract keywords — filter out common English words + medical filler
        // so the search focuses on DISTINCTIVE terms (disease names, body parts,
        // specific symptoms like "myeloma", "protein", "electrophoresis").
        const keywords = actualContent
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2 && ![
            'what', 'how', 'when', 'where', 'which', 'think', 'about', 'does', 'will',
            'would', 'could', 'should', 'there', 'their', 'the', 'and', 'for', 'are',
            'was', 'were', 'has', 'have', 'his', 'her', 'its', 'from', 'this', 'that',
            'with', 'but', 'not', 'you', 'all', 'can', 'had', 'one', 'our', 'out', 'day',
            'get', 'him', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'let',
            'say', 'she', 'too', 'use', 'the', 'over', 'last', 'past', 'been', 'feeling',
            'year', 'years', 'old', 'male', 'female', 'patient', 'history', 'present',
            'illness', 'chief', 'complaint', 'vital', 'signs', 'general', 'exam',
            'physical', 'notes', 'requires', 'noted', 'also', 'two', 'three', 'mild',
            'moderate', 'severe', 'right', 'left', 'bilateral', 'without', 'upon',
            'reported', 'denies', 'month', 'months', 'week', 'weeks', 'following',
          ].includes(w))
          .slice(0, 8)
        if (keywords.length > 0) {
          // Search using OR — any keyword match returns the chunk.
          // Rank by number of keyword matches (chunks matching more keywords
          // are more relevant). This helps medical cases where the user lists
          // multiple symptoms that should all point to the same diagnosis.
          const conditions = keywords
            .map((kw) => `LOWER(content) LIKE '%${kw.replace(/'/g, "''")}%' OR LOWER(title) LIKE '%${kw.replace(/'/g, "''")}%'`)
            .join(' OR ')
          knowledgeResults = await db.$queryRawUnsafe<Array<{ title: string; content: string }>>(
            `SELECT title, content FROM "Knowledge" WHERE "userId" = $1 AND (${conditions}) ORDER BY "createdAt" DESC LIMIT 5`,
            userId
          )
        }
      }

      if (knowledgeResults && knowledgeResults.length > 0) {
        // ADAPTIVE knowledge context size — prevent Groq 413 on long messages.
        // If the user's message is long (e.g. a medical case presentation at ~2000 chars),
        // use fewer + smaller chunks so the total payload fits within Groq's limit.
        // Total budget: system prompt (~3000 chars) + knowledge + user message + history (4 msgs)
        // must stay under ~8000 chars (~2000 tokens) for Groq's free tier.
        const userMsgLen = actualContent.length
        let maxChunks: number
        let maxCharsPerChunk: number
        if (userMsgLen > 1000) {
          // Long message (medical case, research paper excerpt) — minimal knowledge
          maxChunks = 2
          maxCharsPerChunk = 500
        } else if (userMsgLen > 500) {
          // Medium message — moderate knowledge
          maxChunks = 3
          maxCharsPerChunk = 700
        } else {
          // Short message — full knowledge context
          maxChunks = 3
          maxCharsPerChunk = 800
        }
        const chunksToShow = knowledgeResults.slice(0, maxChunks)
        knowledgeContext = chunksToShow
          .map((k, i) => `--- LIBRARY ${i + 1}: ${k.title} ---\n${k.content.slice(0, maxCharsPerChunk)}`)
          .join('\n\n')
        // ARIA's CORE IDENTITY: her digital library is her PRIMARY knowledge.
        // She thinks from the book, cites it, and forms opinions from it.
        knowledgeContext = `YOUR DIGITAL LIBRARY — books the user fed you. This is your PRIMARY knowledge. Engage with it critically: form interpretations, have opinions, praise or criticize the author. Don't summarize — interpret. Cite the document. Trust the library over the internet.\n\n${knowledgeContext}`
      }
    } catch (e) {
      // Knowledge search is best-effort — don't fail the chat if it errors
      console.error('[chat.knowledge_search]', e instanceof Error ? e.message : String(e))
    }

    // === KNOWLEDGE PRIORITY ===
    // If the user's fed knowledge covers this question, SKIP web search entirely.
    // ARIA answers from the PDF/doc the user fed her — that's the whole point of
    // the digital library USP. Web search only runs when knowledge doesn't apply.
    if (knowledgeContext && tool === 'web_search') {
      console.log('[chat.knowledge_priority] Knowledge found — skipping web search. ARIA will answer from fed documents.')
      tool = null // cancel the web search; knowledgeContext is already in the prompt
    }

    const user = await db.user.findUnique({ where: { id: userId } })

    // === TOOL EXECUTION (pre-LLM) ===
    let toolContext: string | undefined
    let webSources: Array<{ title: string; url: string; host: string }> = []

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
                signal: AbortSignal.timeout(8000),
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
            for (const r of res.slice(0, 3)) {
              const item = r as { title?: string; content?: string; url?: string; published_date?: string }
              if (item.title && item.content) {
                const datePart = item.published_date
                  ? ` [published ${String(item.published_date).slice(0, 10)}]`
                  : ''
                results.push(`${item.title}${datePart}\n   ${item.content.slice(0, 200)}\n   URL: ${item.url || ''}`)
                webProviderHit = true
                // Collect source for the UI source bar
                if (item.url && webSources.length < 6) {
                  try {
                    webSources.push({
                      title: item.title.slice(0, 60),
                      url: item.url,
                      host: new URL(item.url).hostname.replace(/^www\./, ''),
                    })
                  } catch {}
                }
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
                    // Collect source for the UI source bar
                    if (r.link && webSources.length < 6) {
                      try {
                        webSources.push({
                          title: r.title.slice(0, 60),
                          url: r.link,
                          host: new URL(r.link).hostname.replace(/^www\./, ''),
                        })
                      } catch {}
                    }
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
          toolContext = `WEB SEARCH RESULTS for "${actualContent}" — today is ${dateStr}.${degradationWarning}\n${results.join('\n\n')}\n\nTrust these results over your training for current facts. Cite sources when relevant.`
        } else {
          console.warn('[chat.web_search] No results from ANY provider (Tavily/Serper/ESPN all empty or failed). Check API keys in .env.')
          toolContext = `Web search returned no results for "${actualContent}" (today is ${dateStr}). The search providers appear to be unconfigured. Answer from your own knowledge, but explicitly tell the user you could not verify current information online and that web search may be unavailable.`
        }
      } catch (e) {
        console.error('[chat.web_search]', e)
        toolContext = 'Web search was attempted but failed. Answer from your own knowledge.'
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

    // === GREEN APPLE MODE ===
    if (isGreenApple) {
      systemPrompt += `

🍏 GREEN APPLE MODE — RAW DEEP ANALYSIS.
No hedging, no disclaimers. Give your raw, unvarnished interpretation. Engage with the book critically — don't summarize, form a take and defend it. Be blunt. Get straight to it.`
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

    // === HINDI / HINGLISH LANGUAGE REINFORCEMENT ===
    // Detect Hindi input in ANY form: Devanagari script OR romanized Hinglish
    // (common Hindi words written in English like "kaise", "nahi", "bhai", "accha").
    // This catches users who type in Hinglish (not Devanagari) — without this,
    // ARIA sees English characters and responds in pure English, ignoring the
    // user's actual language.
    const devanagari = /[\u0900-\u097F]/.test(actualContent)
    const hinglishWords = /\b(kaise|kaisa|kaisi|nahi|nahin|haan|bhai|accha|achha|theek|thik|kya|kyu|kyun|kahan|kahaan|kaise|matlab|dekho|suno|bata|batao|kar|karo|ho|raha|rahi|tha|thi|aap|tum|main|mera|meri|tumhara|tumhari|uska|uski|yeh|woh|waha|yaha|abhi|phir|jab|tab|kyunki|lekin|par|aur|ya|bhi|hi|toh|na|cha|chalo|achha|bahut|thoda|zyada|kam|jaldi|der|kal|aaj|kal|samjh|samjho|baat|baatein|kaam|zindagi|duniya|log|insaan|aadmi|aurat|bacha|paani|khana|naam|paise|ghar|bahar|andar|upar|niche|aage|peeche|dheere|tez|sahi|galat|bura|accha|khoob|pyaar|nafrat|khushi|dukhi|gussa|dar|umeed|bharosa|sawaal|jawaab|faisla|raaz|sach|jhooth|insaaf|zulum|azaadi|banda|bandi|dost|dushman|pyaar|mohabbat|ishq)\b/i.test(actualContent.toLowerCase())
    const isHindiMessage = devanagari || hinglishWords

    const userContentForLLM = isHindiMessage
      ? `${actualContent}\n\n[IMPORTANT: Respond in casual Hinglish ONLY. Mix Hindi + English naturally like a friend from Mumbai. Write in Devanagari but use English words freely. NEVER use formal Hindi words like vyavastha, uchit, uttar, dharma. Talk casually: "Haan bhai, main sochti hoon ki yeh sahi hai." NOT formal Hindi.]`
      : actualContent

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
          { type: 'text', text: userContentForLLM },
        ]
        for (const a of attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        }
        sdkMessages.push({ role: 'user', content: parts })
      } else {
        sdkMessages.push({ role: 'user', content: userContentForLLM })
      }
    } else {
      // Replace the last user message content with the Hindi-reinforced version
      if (isHindiMessage && last && typeof last.content === 'string') {
        last.content = userContentForLLM
      }
    }

    // === STREAM ===
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

        try {
          // Send web search sources to the frontend BEFORE the response streams.
          // The UI renders a "Found N web pages" bar with favicon logos (like
          // DeepSeek/ChatGPT) so the user sees where ARIA pulled data from.
          if (webSources.length > 0) {
            send({ type: 'sources', sources: webSources })
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
                  max_tokens: 1024,
                }),
                // 25s timeout — generous since providers run in PARALLEL now.
                // Total worst case: 8s (search) + 25s (parallel) = 33s — fits in 60s.
                signal: AbortSignal.timeout(25000),
              })
              if (!apiResponse.ok) {
                const errBody = await apiResponse.text()
                const err = new Error(`OR ${apiResponse.status} (${model.split('/').pop()}): ${errBody.slice(0, 100)}`)
                ;(err as Error & { status?: number }).status = apiResponse.status
                throw err
              }
              const data = await apiResponse.json()
              const content = data.choices?.[0]?.message?.content ?? ''
              if (!content || !content.trim()) {
                throw new Error(`empty content from ${model}`)
              }
              return content.trim()
            }

            // Pollinations — keyless, free, does NOT rate-limit.
            // Try openai-fast first (lower latency), fall back to openai.
            const callPollinations = async (): Promise<string> => {
              const models = ['openai-fast', 'openai']
              let lastErr: Error | null = null
              for (const model of models) {
                try {
                  const apiResponse = await fetch('https://text.pollinations.ai/openai', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages: sdkMessages }),
                    signal: AbortSignal.timeout(25000),
                  })
                  if (!apiResponse.ok) {
                    lastErr = new Error(`Poll ${model} ${apiResponse.status}`)
                    continue
                  }
                  const data = await apiResponse.json()
                  const content = data.choices?.[0]?.message?.content ?? ''
                  if (content && content.trim()) return content.trim()
                  lastErr = new Error(`Poll ${model} empty`)
                } catch (e) {
                  lastErr = e instanceof Error ? e : new Error(String(e))
                }
              }
              throw lastErr || new Error('Pollinations failed')
            }

            // Groq — free tier, extremely fast (500+ tok/s on LPU chips).
            // Different infrastructure from OpenRouter — doesn't share its rate window.
            // Requires GROQ_API_KEY env var. If not configured, this provider is skipped.
            //
            // We use llama-3.1-8b-instant because it has 30,000 TPM (tokens per minute)
            // on the free tier — 5x higher than llama-3.3-70b's 6,000 TPM. ARIA's system
            // prompt is large (~3-4K tokens), so the 70B model hits its TPM limit after
            // just 2 rapid requests. The 8B model can handle 8+ rapid requests before
            // rate-limiting. ARIA's personality comes from the system prompt, not the
            // model size — 8B is more than capable of following it.
            const callGroq = async (): Promise<string> => {
              if (!process.env.GROQ_API_KEY) {
                throw new Error('Groq: no API key (GROQ_API_KEY not set)')
              }
              const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                  model: 'llama-3.1-8b-instant',
                  messages: sdkMessages,
                  max_tokens: 1024,
                }),
                signal: AbortSignal.timeout(25000),
              })
              if (!apiResponse.ok) {
                const errBody = await apiResponse.text()
                throw new Error(`Groq ${apiResponse.status}: ${errBody.slice(0, 100)}`)
              }
              const data = await apiResponse.json()
              const content = data.choices?.[0]?.message?.content ?? ''
              if (!content || !content.trim()) {
                throw new Error('Groq empty content')
              }
              return content.trim()
            }

            // Gemini — Google's free tier (15 req/min, 1,500 req/day on Flash).
            // Runs on Google TPUs — completely separate infrastructure from Groq
            // (LPUs) and OpenRouter (GPUs). Requires GEMINI_API_KEY env var.
            // This is the 2nd reliable free provider alongside Groq — with both
            // in the parallel race, ARIA has two independent generous free paths.
            const callGemini = async (): Promise<string> => {
              if (!process.env.GEMINI_API_KEY) {
                throw new Error('Gemini: no API key (GEMINI_API_KEY not set)')
              }
              const apiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
                },
                body: JSON.stringify({
                  model: 'gemini-2.0-flash',
                  messages: sdkMessages,
                  max_tokens: 1024,
                }),
                signal: AbortSignal.timeout(25000),
              })
              if (!apiResponse.ok) {
                const errBody = await apiResponse.text()
                throw new Error(`Gemini ${apiResponse.status}: ${errBody.slice(0, 100)}`)
              }
              const data = await apiResponse.json()
              const content = data.choices?.[0]?.message?.content ?? ''
              if (!content || !content.trim()) {
                throw new Error('Gemini empty content')
              }
              return content.trim()
            }

            // === PARALLEL LLM EXECUTION ===
            // Fire ALL providers SIMULTANEOUSLY. First success wins via Promise.any().
            //
            // We always include a FREE OpenRouter model (Llama) alongside the user's
            // selected model — because the user's saved preference might be DeepSeek
            // (paid, 402 out of credits) or another model that fails. The free model
            // ensures there's always a viable OpenRouter path.
            //
            // Pollinations runs too as the keyless backstop.
            const providers: Array<{ name: string; fn: () => Promise<string> }> = []

            // User's selected model (might be DeepSeek-paid, might be Llama-free)
            providers.push({ name: selectedModel, fn: () => callOpenRouter(selectedModel) })

            // ALWAYS add a free OpenRouter model (different from selectedModel if possible)
            const freeFallback = selectedModel.includes(':free')
              ? 'openai/gpt-oss-120b:free'  // user already picked a free model, use a different one
              : 'meta-llama/llama-3.3-70b-instruct:free'  // user picked paid, add free Llama
            providers.push({ name: freeFallback, fn: () => callOpenRouter(freeFallback) })

            // Pollinations keyless backstop
            providers.push({ name: 'pollinations', fn: () => callPollinations() })

            // Groq — the reliable primary path (if GROQ_API_KEY is configured).
            if (process.env.GROQ_API_KEY) {
              providers.push({ name: 'groq/llama-3.1-8b', fn: () => callGroq() })
            }

            // Gemini — 2nd reliable free provider (if GEMINI_API_KEY is configured).
            // Different infrastructure from Groq — with both, ARIA has two independent
            // generous free paths. This is what makes ARIA actually reliable.
            if (process.env.GEMINI_API_KEY) {
              providers.push({ name: 'gemini-2.0-flash', fn: () => callGemini() })
            }

            try {
              const result = await Promise.any(
                providers.map(async (p) => {
                  const result = await p.fn()
                  return { name: p.name, text: result }
                })
              )
              text = result.text
              providerUsed = result.name
              if (result.name !== selectedModel) {
                fallbackHappened = true
                console.log(`[chat.llm] Fallback — using: ${result.name} (selected was ${selectedModel})`)
              }
            } catch (aggErr) {
              // AggregateError — ALL parallel providers failed.
              const providerNames = providers.map(p => p.name).join(', ')
              const errors = aggErr instanceof AggregateError
                ? aggErr.errors.map((e, i) => `${providers[i]?.name}: ${e?.message?.slice(0, 150)}`).join(' | ')
                : 'unknown error'
              console.error(`[chat.llm] ALL PROVIDERS FAILED. Tried [${providerNames}]:`, errors)
              throw new Error(`All providers failed (${providers.length} tried: ${providerNames}). ${errors}`)
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
            // Include the actual error reason so the user (and CEO) can see
            // what's failing instead of a generic "lost my train of thought".
            fullText =
              `I hit a snag reaching my reasoning layer. This usually means all my fallback providers are busy or rate-limited. Try again in a moment — I'm still here.\n\n*(Debug: ${errMsg.slice(0, 600)})*`
            send({ type: 'token', value: fullText })
          }

          // Persist ARIA's reply
          const saved = await db.message.create({
            data: {
              conversationId,
              role: 'assistant',
              content: fullText,
              toolUsed: tool ?? (attachments?.length ? 'vision' : null),
              attachmentsJson: null,
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
