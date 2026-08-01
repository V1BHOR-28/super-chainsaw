import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { buildAriaSystemPrompt } from '@/lib/aria'
import { updateConversationSummary } from '@/lib/conversation-summary'
import { embedMessageAsync } from '@/lib/embed-message'
import { recordUsage, estimateTokens, hasHitDailyLimit } from '@/lib/usage'
import { extractKeywords } from '@/lib/chunk-text'

/** Hard cap on user message length — protects against abuse / accidental huge pastes. */
const MAX_MESSAGE_LENGTH = 12_000

/**
 * Extract a window of `maxChars` from `content`, centered on the first position
 * where any of `keywords` appears. Falls back to slicing from the start if no
 * keyword is found (e.g. pure semantic matches on paraphrased content).
 */
function centerOnKeyword(content: string, keywords: string[], maxChars: number): string {
  if (content.length <= maxChars) return content
  if (keywords.length === 0) return content.slice(0, maxChars)

  const lowerContent = content.toLowerCase()
  let bestPos = -1
  for (const kw of keywords) {
    const idx = lowerContent.indexOf(kw)
    if (idx !== -1) {
      bestPos = idx
      break
    }
  }
  if (bestPos === -1) return content.slice(0, maxChars)

  // Center the window on the keyword position, clamped to chunk bounds
  const half = Math.floor(maxChars / 2)
  let start = bestPos - half
  if (start < 0) start = 0
  let end = start + maxChars
  if (end > content.length) {
    end = content.length
    start = Math.max(0, end - maxChars)
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + content.slice(start, end) + suffix
}

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

    let tool = userTool
    let actualContent = content

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

      // Server-side safety net: if the user's own words clearly ask for a search,
      // force a real search even if the client-side toggle wasn't flipped. The
      // toggle is the primary signal, but "search the web" in plain text should
      // not silently skip search — that's the mechanism behind fabricated answers.
      const explicitSearchIntent = /\b(search the web|look (this|it) up|check online|search online|google (this|it)|find out (online|on the web))\b/i.test(actualContent)

      if ((userTool === 'web_search' || explicitSearchIntent) && !isCasual) {
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
    const userMessage = await db.message.create({
      data: {
        conversationId,
        role: 'user',
        content,
        attachmentsJson: attachments ? JSON.stringify(attachments) : null,
      },
    })
    // Fire-and-forget: embed the user message for semantic search
    embedMessageAsync(userMessage.id, actualContent).catch((err) => console.error('[embed-message] user msg failed:', err))
    // Touch conversation for sort order
    await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })

    // Load settings, recent mood, recent messages, conversation summary — use semantic memory search
    const [settings, recentMood, recentMessages, conversationSummary] = await Promise.all([
      db.userSettings.findUnique({ where: { userId } }),
      db.mood.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      db.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 8, // last 4 exchanges verbatim; older context now comes from the rolling summary
      }),
      db.conversation.findUnique({ where: { id: conversationId }, select: { summary: true } }),
    ])

    // Fetch returns newest-first (desc). Reverse to chronological (oldest-to-newest)
    // so downstream consumers (sdkMessages builder) get the expected order.
    recentMessages.reverse()

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
    let knowledgeFromSemanticSearch = false
    try {
      const { generateEmbedding, embeddingToPgVector, MAX_RELEVANCE_DISTANCE } = await import('@/lib/embeddings')
      const queryEmbedding = await generateEmbedding(actualContent)
      let knowledgeResults: Array<{ title: string; content: string }> = []

      // === IN-BOOK SEARCH ===
      // Detect if the user is asking about a SPECIFIC book (e.g. "in Meditations,
      // where does Marcus talk about death?"). If so, restrict the search to
      // chunks from that book only.
      const inBookMatch = actualContent.match(/\b(?:in|from|about)\s+[""']?([^""'?]{3,60})[""']?(?:,|\s+(?:where|what|how|why|does|is|are|can|who))\b/i)
      let bookFilter: string | null = null
      if (inBookMatch) {
        const bookName = inBookMatch[1].trim().toLowerCase()
        // Check if this book name matches any Knowledge title prefix
        const allTitles = await db.knowledge.findMany({
          where: { userId },
          select: { title: true },
          distinct: ['title'],
          orderBy: { title: 'asc' },   // deterministic result order
        })

        const baseTitles = allTitles.map(t => ({
          original: t.title,
          base: t.title.toLowerCase().replace(/\s+—\s+part\s+\d+\/\d+$/, ''),
        }))

        const matchingTitle =
          baseTitles.find(t => t.base === bookName) ??
          baseTitles.find(t => t.base.startsWith(bookName)) ??
          baseTitles.find(t => t.base.includes(bookName))
        if (matchingTitle) {
          const baseTitle = matchingTitle.original.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')
          bookFilter = baseTitle
        }
      }

      if (queryEmbedding) {
        // Semantic search — finds by meaning, not just exact keywords.
        const vectorStr = embeddingToPgVector(queryEmbedding)

        // === IN-BOOK FILTERED SEARCH ===
        if (bookFilter) {
          // Restrict to chunks from this specific book
          knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
            SELECT title, content FROM "Knowledge"
            WHERE "userId" = ${userId}
              AND embedding IS NOT NULL
              AND (title = ${bookFilter} OR title LIKE ${`${bookFilter} — Part%`})
              AND embedding <=> ${vectorStr}::vector < ${MAX_RELEVANCE_DISTANCE}
            ORDER BY embedding <=> ${vectorStr}::vector
            LIMIT 5
          `
        } else {
          // === MULTI-BOOK COMPARISON ===
          // Detect if the user is asking a comparison question (e.g. "compare Marcus
          // and Nietzsche", "how do these books differ on suffering").
          // If so, pull top-2 chunks from EACH distinct book title, not just top-5 overall.
          // This ensures ARIA gets context from multiple books for comparison.
          const lowerContent = actualContent.toLowerCase()
          const isComparison = /\b(vs|versus|compare|comparison|differ|difference|contrast|both|each)\b/i.test(lowerContent)

          if (isComparison) {
            // Fetch top 8 results (to cover multiple books), then group by base title
            knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
              SELECT title, content
              FROM "Knowledge"
              WHERE "userId" = ${userId}
                AND embedding IS NOT NULL
                AND embedding <=> ${vectorStr}::vector < ${MAX_RELEVANCE_DISTANCE}
              ORDER BY embedding <=> ${vectorStr}::vector
              LIMIT 8
            `
            // Group by base title (strip " — Part N/M") and take top 2 from each book
            const bookGroups = new Map<string, Array<{ title: string; content: string }>>()
            for (const r of knowledgeResults) {
              const baseTitle = r.title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')
              if (!bookGroups.has(baseTitle)) bookGroups.set(baseTitle, [])
              if (bookGroups.get(baseTitle)!.length < 2) {
                bookGroups.get(baseTitle)!.push(r)
              }
            }
            // Flatten back — max 6 chunks total (3 books × 2 chunks)
            knowledgeResults = Array.from(bookGroups.values()).flat().slice(0, 6)
          } else {
            // Normal search — top 5 chunks from any book
            knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
              SELECT title, content
              FROM "Knowledge"
              WHERE "userId" = ${userId}
                AND embedding IS NOT NULL
                AND embedding <=> ${vectorStr}::vector < ${MAX_RELEVANCE_DISTANCE}
              ORDER BY embedding <=> ${vectorStr}::vector
              LIMIT 5
            `
          }
        }
      }

      // Flag: did the hit come from real semantic similarity search (pgvector)?
      // Set here — AFTER the semantic block but BEFORE the keyword fallback —
      // so only genuine semantic results get to cancel web search later.
      // The keyword ILIKE fallback below does NOT set this flag.
      if (queryEmbedding && knowledgeResults.length > 0) {
        knowledgeFromSemanticSearch = true
      }

      // Fallback: if no embedding results (key not configured, or knowledge
      // stored without embedding), do a keyword ILIKE search. Extracts the
      // most distinctive words from the user's message and matches them.
      // Includes numbers (e.g. "chapter 8") so chapter-specific questions work.
      if (knowledgeResults.length === 0) {
        const keywords = extractKeywords(actualContent)
        if (keywords.length > 0) {
          // Search using OR — any keyword match returns the chunk.
          // Rank by number of keyword matches (chunks matching more keywords
          // are more relevant). This helps medical cases where the user lists
          // multiple symptoms that should all point to the same diagnosis.
          const patterns = keywords.map((kw) => `%${kw}%`)
          knowledgeResults = await db.$queryRaw<Array<{ title: string; content: string }>>`
            SELECT title, content FROM "Knowledge"
            WHERE "userId" = ${userId}
              AND (
                LOWER(content) LIKE ANY(${patterns}::text[])
                OR LOWER(title) LIKE ANY(${patterns}::text[])
              )
            ORDER BY "createdAt" DESC LIMIT 5
          `
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
        // Extract keywords from the user's query to find the most relevant
        // position within each chunk, so truncation centers on the relevant
        // sentence rather than always slicing from the start.
        const truncationKeywords = extractKeywords(actualContent)
        knowledgeContext = chunksToShow
          .map((k, i) => {
            const snippet = centerOnKeyword(k.content, truncationKeywords, maxCharsPerChunk)
            return `--- LIBRARY ${i + 1}: ${k.title} ---\n${snippet}`
          })
          .join('\n\n')
        // ARIA's CORE IDENTITY: her digital library is her PRIMARY knowledge.
        // She thinks from the book, cites it, and forms opinions from it.
        knowledgeContext = `[Internal note: the following are books/documents the user has fed you. Use them as your primary knowledge, but never repeat this note or a heading like it in your reply.]\n\n${knowledgeContext}`
      }
    } catch (e) {
      // Knowledge search is best-effort — don't fail the chat if it errors
      console.error('[chat.knowledge_search]', e instanceof Error ? e.message : String(e))
    }

    // === KNOWLEDGE PRIORITY ===
    // If the user's fed knowledge covers this question AND the hit came from
    // real semantic similarity search (not the keyword ILIKE fallback), SKIP
    // web search entirely. A weak keyword-only match doesn't warrant blocking
    // live search — the user may be asking about something the library only
    // tangentially mentions.
    if (knowledgeContext && knowledgeFromSemanticSearch && tool === 'web_search') {
      console.log('[chat.knowledge_priority] Semantic knowledge match — skipping web search.')
      tool = null // cancel the web search; knowledgeContext is already in the prompt
    }

    const user = await db.user.findUnique({ where: { id: userId } })

    // === TOOL EXECUTION (pre-LLM) ===
    let toolContext: string | undefined
    let webSources: Array<{ title: string; url: string; host: string }> = []

    if (tool === 'web_search') {
      try {
        const { performWebSearch } = await import('@/lib/web-search')
        const searchResult = await performWebSearch(actualContent)
        toolContext = searchResult.resultsText
        webSources = searchResult.sources
      } catch (e) {
        console.error('[chat.web_search]', e)
        toolContext = 'Web search was attempted but failed. Answer from your own knowledge.'
      }
    }

    // === BUILD MESSAGE PAYLOAD ===
    // If web search was requested/attempted this turn but truly nothing came back,
    // make that explicit rather than leaving toolContext empty or vague. This is
    // distinct from the catch-block fallback (which covers genuine provider errors) —
    // this covers the case where search ran successfully but genuinely found nothing
    // relevant (e.g., an obscure meme). An explicit negative signal is harder for
    // the model to talk past than silence.
    if (tool === 'web_search' && !toolContext) {
      toolContext = 'WEB SEARCH ATTEMPTED — no usable results were returned. Tell the user the search did not turn up anything useful rather than answering as if you found something.'
    }
    const fullToolContext = [toolContext, knowledgeContext].filter(Boolean).join('\n\n')

    // === DEEP THINKING DETECTION ===
    // Moved here (before buildAriaSystemPrompt) so the signal can reach the
    // prompt AND the model routing below. Word-boundary matching prevents
    // false positives like "I think pizza sounds good" or "let's book a table."
    const deepThinkingKeywords = [
      'philosoph', 'book', 'read', 'author', 'chapter', 'novel', 'literat',
      'marcus', 'aurelius', 'nietzsche', 'camus', 'sartre', 'plato', 'aristotle',
      'kant', 'hegel', 'kierkegaard', 'stirner', 'rousseau', 'hobbes', 'locke',
      'machiavelli', 'seneca', 'epictetus', 'stoic', 'existential', 'nihilism',
      'absurd', 'meaning', 'purpose', 'morality', 'ethics', 'virtue', 'justice',
      'consciousness', 'reality', 'truth', 'knowledge', 'wisdom', 'contemplat',
      'meditat', 'argument', 'thesis', 'theory', 'concept', 'idea', 'think',
      'critique', 'analyze', 'interpret', 'perspective', 'worldview',
      'dostoevsky', 'tolstoy', 'kafka', 'proust', 'joyce', 'woolf', 'hemingway',
      'orwell', 'huxley', 'carnegie', 'darwin', 'einstein', 'newton',
      'meditation', 'moral', 'spiritual', 'soul', 'mind', 'existence',
      'freedom', 'liberty', 'power', 'authority', 'society', 'individual',
      'zindagi', 'tattva', 'darshan', 'satya', 'sach', 'dharma', 'karma',
      'moksha', 'atma', 'paramatma', 'gyan', 'vigyan', 'tark',
    ]
    const genericWords = new Set(['think', 'read', 'book', 'idea', 'power', 'moral', 'mind', 'meaning', 'purpose'])
    const matchedKeywords = deepThinkingKeywords.filter(kw =>
      new RegExp(`\\b${kw}`, 'i').test(actualContent)
    )
    const specificMatches = matchedKeywords.filter(kw => !genericWords.has(kw))
    const isDeepThinking = knowledgeContext !== undefined || specificMatches.length > 0 || matchedKeywords.length >= 2

    let systemPrompt = buildAriaSystemPrompt({
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
      toolContext: fullToolContext || undefined,
      conversationSummary: conversationSummary?.summary ?? null,
      isDeepThinking,
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
    // Use actualContent for the LLM
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

            // Get user's model preference (default: Llama 3.3 70B free)
            const { getModelFromSettings } = await import('@/lib/embeddings')
            const selectedModel = getModelFromSettings(settings?.modelPreference)

            // === SMART MODEL ROUTING ===
            // Use the big 70B model for deep thinking (books, philosophy, literature)
            // and the fast 8B model for casual chit-chat. This saves Groq TPM budget
            // (8B has 30K TPM, 70B has 6K TPM) while giving quality where it matters.
            //
            // isDeepThinking was computed earlier (before buildAriaSystemPrompt)
            // so it could be passed to the prompt. Reused here for model routing.

            // The "selectedModel" for the fallback chain — if deep thinking, prefer
            // the largest-context free model (Qwen3 Next 80B, 262K context) for
            // multi-book comparison headroom. If the user has explicitly chosen a
            // different model in settings, respect their choice.
            const effectiveSelectedModel = isDeepThinking
              ? 'qwen/qwen3-next-80b-a3b-instruct:free'
              : selectedModel

            // === REAL STREAMING ===
            // Try streaming from OpenRouter first — real-time tokens instead of
            // waiting for the full response + fake typewriter. The user sees the
            // first word in 1-2s instead of 5-10s.
            // If streaming fails (429, 402, etc.), fall through to the existing
            // non-streaming parallel approach below.
            let streamedDirectly = false
            try {
              const streamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                  'HTTP-Referer': 'https://ariav2-seven.vercel.app',
                  'X-Title': 'ARIA',
                },
                body: JSON.stringify({
                  model: effectiveSelectedModel,
                  messages: sdkMessages,
                  max_tokens: 1024,
                  stream: true,
                }),
                signal: AbortSignal.timeout(25000),
              })

              if (streamResponse.ok && streamResponse.body) {
                const reader = streamResponse.body.getReader()
                const decoder = new TextDecoder()
                let streamBuffer = ''
                let streamText = ''

                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  streamBuffer += decoder.decode(value, { stream: true })
                  const lines = streamBuffer.split('\n')
                  streamBuffer = lines.pop() || ''
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      const data = line.slice(6).trim()
                      if (data === '[DONE]') continue
                      try {
                        const parsed = JSON.parse(data)
                        const delta = parsed.choices?.[0]?.delta?.content
                        if (delta) {
                          streamText += delta
                          send({ type: 'token', value: delta })
                        }
                      } catch {}
                    }
                  }
                }

                if (streamText.trim()) {
                  text = streamText.trim()
                  fullText = text
                  streamedDirectly = true
                  providerUsed = `${effectiveSelectedModel} (streamed)`
                  console.log(`[chat.llm] Streamed directly from ${effectiveSelectedModel}`)
                }
              }
            } catch (streamErr) {
              console.warn('[chat.llm] Streaming failed, falling back to non-streaming:', streamErr instanceof Error ? streamErr.message.slice(0, 100) : '')
            }

            if (!streamedDirectly) {
            // === EXISTING NON-STREAMING FALLBACK ===
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

            // User's selected model — uses smart routing (70B for deep thinking, 8B for casual)
            providers.push({ name: effectiveSelectedModel, fn: () => callOpenRouter(effectiveSelectedModel) })

            // ALWAYS add a free OpenRouter model (different from effectiveSelectedModel if possible)
            const freeFallback = effectiveSelectedModel.includes(':free')
              ? 'openai/gpt-oss-120b:free'
              : 'meta-llama/llama-3.3-70b-instruct:free'
            providers.push({ name: freeFallback, fn: () => callOpenRouter(freeFallback) })

            // Gemini — 2nd reliable free provider (if GEMINI_API_KEY is configured).
            // Different infrastructure from Groq — with both, ARIA has two independent
            // generous free paths. This is what makes ARIA actually reliable.
            if (process.env.GEMINI_API_KEY) {
              providers.push({ name: 'gemini-2.0-flash', fn: () => callGemini() })
            }

            // === CONDITIONAL RACING ===
            // For deep-thinking requests (philosophy, books, knowledge context), gate
            // Groq 8B and Pollinations OUT of the primary race — they're less reliable
            // at following the detailed system prompt under context pressure, and racing
            // them against 70B/120B/Gemini Flash means whichever responds first wins,
            // which can silently defeat the routing logic. They're kept as a genuine
            // last-resort below — only used if every deep-thinking-eligible provider fails.
            //
            // For non-deep-thinking (casual/greeting-tier), keep the full 5-provider race
            // unchanged — speed is the right priority there and persona-fidelity risk is
            // lower for short/casual replies.
            if (!isDeepThinking) {
              // Pollinations keyless backstop
              providers.push({ name: 'pollinations', fn: () => callPollinations() })

              // Groq — the reliable primary path (if GROQ_API_KEY is configured).
              if (process.env.GROQ_API_KEY) {
                providers.push({ name: 'groq/llama-3.1-8b', fn: () => callGroq() })
              }
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
              if (result.name !== effectiveSelectedModel) {
                fallbackHappened = true
                console.log(`[chat.llm] ${isDeepThinking ? 'Deep-thinking' : 'Casual'} tier winner: ${result.name} (selected was ${selectedModel})`)
              } else {
                console.log(`[chat.llm] ${isDeepThinking ? 'Deep-thinking' : 'Casual'} tier winner: ${result.name}`)
              }
            } catch (aggErr) {
              // For deep-thinking requests: if all eligible providers failed, fall through
              // to the reliability tier (Groq 8B + Pollinations) before giving up entirely.
              // ARIA should never go fully offline — she just doesn't race a weak model
              // against a strong one when both are live and healthy.
              if (isDeepThinking) {
                const reliabilityProviders: Array<{ name: string; fn: () => Promise<string> }> = []
                if (process.env.GROQ_API_KEY) {
                  reliabilityProviders.push({ name: 'groq/llama-3.1-8b', fn: () => callGroq() })
                }
                reliabilityProviders.push({ name: 'pollinations', fn: () => callPollinations() })

                if (reliabilityProviders.length > 0) {
                  console.warn(`[chat.llm] Deep-thinking tier all failed — falling through to reliability tier: ${reliabilityProviders.map(p => p.name).join(', ')}`)
                  try {
                    const result = await Promise.any(
                      reliabilityProviders.map(async (p) => {
                        const result = await p.fn()
                        return { name: p.name, text: result }
                      })
                    )
                    text = result.text
                    providerUsed = result.name
                    fallbackHappened = true
                    console.log(`[chat.llm] Fell through to reliability tier: ${result.name}`)
                  } catch (aggErr2) {
                    const providerNames = [...providers.map(p => p.name), ...reliabilityProviders.map(p => p.name)].join(', ')
                    const errors = aggErr2 instanceof AggregateError
                      ? aggErr2.errors.map((e, i) => `${reliabilityProviders[i]?.name}: ${e?.message?.slice(0, 150)}`).join(' | ')
                      : 'unknown error'
                    console.error(`[chat.llm] ALL PROVIDERS FAILED (deep-thinking + reliability tiers). Tried [${providerNames}]:`, errors)
                    throw new Error(`All providers failed (${providers.length + reliabilityProviders.length} tried: ${providerNames}). ${errors}`)
                  }
                } else {
                  const providerNames = providers.map(p => p.name).join(', ')
                  const errors = aggErr instanceof AggregateError
                    ? aggErr.errors.map((e, i) => `${providers[i]?.name}: ${e?.message?.slice(0, 150)}`).join(' | ')
                    : 'unknown error'
                  console.error(`[chat.llm] ALL PROVIDERS FAILED. Tried [${providerNames}]:`, errors)
                  throw new Error(`All providers failed (${providers.length} tried: ${providerNames}). ${errors}`)
                }
              } else {
                // Non-deep-thinking: no reliability tier needed (already in the primary race)
                const providerNames = providers.map(p => p.name).join(', ')
                const errors = aggErr instanceof AggregateError
                  ? aggErr.errors.map((e, i) => `${providers[i]?.name}: ${e?.message?.slice(0, 150)}`).join(' | ')
                  : 'unknown error'
                console.error(`[chat.llm] ALL PROVIDERS FAILED. Tried [${providerNames}]:`, errors)
                throw new Error(`All providers failed (${providers.length} tried: ${providerNames}). ${errors}`)
              }
            }

            fullText = text

            if (!fullText) {
              fullText =
                "I'm here, but my words aren't coming through clearly. Try sending that again."
            }

            // Fake typewriter — only if we didn't stream directly.
            // Real streaming sends tokens as they arrive; this is the fallback.
            if (!streamedDirectly) {
              const tokens = fullText.split(/(\s+)/)
              for (const t of tokens) {
                if (!t) continue
                send({ type: 'token', value: t })
                const isPunct = /[.!?,;:—]/.test(t)
                await new Promise((r) => setTimeout(r, isPunct ? 40 : 12))
              }
            }
            } // end if (!streamedDirectly) — closes the non-streaming fallback block
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
              toolUsed: tool ?? (knowledgeContext ? 'library' : null) ?? (attachments?.length ? 'vision' : null),
              attachmentsJson: null,
            },
          })
          // Fire-and-forget: embed ARIA's reply for semantic search
          embedMessageAsync(saved.id, fullText).catch((err) => console.error('[embed-message] assistant msg failed:', err))

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

          // === ROLLING CONVERSATION SUMMARY ===
          // Fire-and-forget: folds older messages into a bounded summary so ARIA
          // carries long-range context without ballooning token cost every turn.
          // Must NOT be awaited — it runs in the background after the response.
          updateConversationSummary(conversationId).catch((err) => {
            console.error('[conversation-summary] background update failed:', err)
          })

          send({
            type: 'done',
            messageId: saved.id,
            usage: { tokens: inputTokens + outputTokens },
            memoriesUsed: memories.length,
            moodContext: recentMood ? recentMood.mood : null,
          })

          // === READING JOURNAL + OPINION EVOLUTION (Phase 3) ===
          // After a book discussion, ARIA writes a private journal reflection.
          // This becomes part of her memory — she remembers not just what the
          // book says, but what she AND the user thought about it.
          // Also detects if ARIA's opinion changed during the conversation.
          if (knowledgeContext && fullText.length > 50) {
            try {
              // Only journal if this was a substantive book discussion
              const isBookDiscussion = isDeepThinking ||
                knowledgeContext !== undefined

              if (isBookDiscussion) {
                // Extract the book title from the knowledge context
                const bookTitleMatch = knowledgeContext.match(/--- LIBRARY \d+: (.+?) ---/)
                const bookTitle = bookTitleMatch ? bookTitleMatch[1].replace(/\s+—\s+Part\s+\d+\/\d+$/, '') : 'a book'

                // Create a journal entry — ARIA's reflection on the discussion
                const journalEntry = `Discussed "${bookTitle}" with ${userName || 'the user'}. My take: ${fullText.slice(0, 200).trim()}...`

                // Check if ARIA already has a journal entry for this book
                const existingJournal = await db.memory.findFirst({
                  where: {
                    userId,
                    category: 'journal',
                    content: { contains: bookTitle },
                  },
                })

                if (existingJournal) {
                  // OPINION EVOLUTION: Update the existing journal entry
                  // ARIA's opinion may have evolved through the conversation
                  const updatedContent = `${existingJournal.content}\n\nUpdated: ${journalEntry}`
                  await db.memory.update({
                    where: { id: existingJournal.id },
                    data: { content: updatedContent.slice(0, 1000) },
                  })
                  console.log(`[chat.journal] Updated journal entry for "${bookTitle}"`)
                } else {
                  // Create new journal entry
                  await db.memory.create({
                    data: {
                      userId,
                      content: journalEntry.slice(0, 500),
                      category: 'journal',
                    },
                  })
                  console.log(`[chat.journal] Created journal entry for "${bookTitle}"`)
                }
              }
            } catch (e) {
              // Journal is best-effort — don't fail the chat
              console.warn('[chat.journal] Failed:', e instanceof Error ? e.message : String(e))
            }
          }
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
