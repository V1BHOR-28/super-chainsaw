import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding } from '@/lib/embeddings'

/**
 * GET /api/conversations/search?q=<query>
 *
 * Searches conversation TITLES + all message CONTENT for the query.
 * Returns conversations that match, with a snippet of the matching message
 * (if the match was in a message body, not the title) so the UI can show
 * context.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()

    if (!q) {
      return NextResponse.json({ results: [] })
    }

    // Truncate query to prevent abuse
    const query = q.slice(0, 200)

    // === SEMANTIC SEARCH PASS ===
    // Find messages by MEANING, not just literal substrings. Embeds the query
    // and finds nearest messages via pgvector cosine distance. Only keeps
    // genuinely relevant matches (distance < 0.35). This is additive — the
    // keyword pass below still runs for exact-name/quote matching.
    const queryEmbedding = await generateEmbedding(query).catch(() => null)

    let semanticMatches: Array<{ conversationId: string; content: string; role: string; distance: number }> = []
    if (queryEmbedding) {
      const vectorStr = `[${queryEmbedding.join(',')}]`
      semanticMatches = await db.$queryRaw<Array<{ conversationId: string; content: string; role: string; distance: number }>>`
        SELECT m."conversationId", m.content, m.role, m.embedding <=> ${vectorStr}::vector AS distance
        FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE c."userId" = ${userId} AND m.embedding IS NOT NULL
        ORDER BY m.embedding <=> ${vectorStr}::vector
        LIMIT 15
      `
      // Only keep genuinely relevant matches — cosine distance < 0.35 is a
      // starting threshold, not gospel; tune against real queries once shipped.
      semanticMatches = semanticMatches.filter((m) => m.distance < 0.35)
    }

    // Find conversations owned by this user whose title matches
    const titleMatches = await db.conversation.findMany({
      where: {
        userId,
        title: { contains: query },
      },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: 30,
      include: {
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, createdAt: true },
        },
      },
    })

    // Find messages owned by this user (via conversation) whose content matches
    const messageMatches = await db.message.findMany({
      where: {
        conversation: { userId },
        content: { contains: query },
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        id: true,
        content: true,
        role: true,
        createdAt: true,
        conversation: {
          select: {
            id: true,
            title: true,
            pinned: true,
            updatedAt: true,
          },
        },
      },
    })

    // Group message matches by conversation, pick the most recent match per conversation
    const byConv = new Map<
      string,
      {
        id: string
        title: string
        pinned: boolean
        updatedAt: string
        matchSnippet: string
        matchRole: string
        matchCount: number
        matchedIn: 'message' | 'semantic'
      }
    >()

    for (const m of messageMatches) {
      const existing = byConv.get(m.conversation.id)
      if (!existing) {
        byConv.set(m.conversation.id, {
          id: m.conversation.id,
          title: m.conversation.title,
          pinned: m.conversation.pinned,
          updatedAt: m.conversation.updatedAt.toISOString(),
          matchSnippet: buildSnippet(m.content, query),
          matchRole: m.role,
          matchCount: 1,
          matchedIn: 'message' as const,
        })
      } else {
        existing.matchCount += 1
      }
    }

    // Merge semantic matches into the same byConv map. These are tagged
    // matchedIn: 'semantic' so the UI can optionally distinguish "found by
    // meaning" from "found by exact words."
    for (const m of semanticMatches) {
      const existing = byConv.get(m.conversationId)
      if (!existing) {
        byConv.set(m.conversationId, {
          id: m.conversationId,
          title: '', // filled from conversation lookup below if not already in titleMatches
          pinned: false,
          updatedAt: new Date().toISOString(),
          matchSnippet: buildSnippet(m.content, query),
          matchRole: m.role,
          matchCount: 1,
          matchedIn: 'semantic' as const,
        })
      } else {
        existing.matchCount += 1
      }
    }

    // Merge: title matches first (deduped), then message matches
    const seen = new Set<string>()
    const results: Array<{
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
    }> = []

    for (const c of titleMatches) {
      seen.add(c.id)
      const msgMatch = byConv.get(c.id)
      results.push({
        id: c.id,
        title: c.title,
        pinned: c.pinned,
        updatedAt: c.updatedAt.toISOString(),
        messageCount: c._count.messages,
        preview: c.messages[0]?.content?.slice(0, 120) ?? '',
        matchSnippet: msgMatch?.matchSnippet,
        matchRole: msgMatch?.matchRole,
        matchCount: msgMatch?.matchCount,
        matchedIn: msgMatch ? 'both' : 'title',
      })
    }

    for (const [, m] of byConv) {
      if (!seen.has(m.id)) {
        // For semantic-only matches, look up the conversation to get title/pinned/etc
        let title = m.title
        let pinned = m.pinned
        let updatedAt = m.updatedAt
        let messageCount = 0
        if (!title && m.matchedIn === 'semantic') {
          const convo = await db.conversation.findUnique({
            where: { id: m.id },
            select: { title: true, pinned: true, updatedAt: true, _count: { select: { messages: true } } },
          })
          if (convo) {
            title = convo.title
            pinned = convo.pinned
            updatedAt = convo.updatedAt.toISOString()
            messageCount = convo._count.messages
          }
        }
        results.push({
          id: m.id,
          title,
          pinned,
          updatedAt,
          messageCount,
          preview: '',
          matchSnippet: m.matchSnippet,
          matchRole: m.matchRole,
          matchCount: m.matchCount,
          matchedIn: m.matchedIn,
        })
      }
    }

    // Sort: pinned first, then most recently updated
    results.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

    return NextResponse.json({ results, total: results.length })
  } catch (err) {
    console.error('[conversations.search]', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}

/** Build a short snippet around the first match of `query` in `content`. */
function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx === -1) return content.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(content.length, idx + query.length + 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + content.slice(start, end).trim() + suffix
}
