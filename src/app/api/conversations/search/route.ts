import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

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
      matchedIn: 'title' | 'message' | 'both'
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
        results.push({
          id: m.id,
          title: m.title,
          pinned: m.pinned,
          updatedAt: m.updatedAt,
          messageCount: 0,
          preview: '',
          matchSnippet: m.matchSnippet,
          matchRole: m.matchRole,
          matchCount: m.matchCount,
          matchedIn: 'message',
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
