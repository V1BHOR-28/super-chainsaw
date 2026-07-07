import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/conversations/[id]/export?format=json|markdown
 *
 * Exports a full conversation (with all messages) as either:
 *   - JSON: structured { conversation, messages, memories, moods } blob
 *   - Markdown: human-readable transcript with headers
 *
 * The response has Content-Disposition: attachment so the browser downloads it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const format = searchParams.get('format') === 'markdown' ? 'markdown' : 'json'

    const conversation = await db.conversation.findFirst({
      where: { id, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })

    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Also pull the user's memories + recent moods so the export is self-contained
    const [memories, moods] = await Promise.all([
      db.memory.findMany({ where: { userId }, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }] }),
      db.mood.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ])

    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, tier: true } })

    const safeTitle = conversation.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'conversation'
    const dateStr = new Date().toISOString().slice(0, 10)

    if (format === 'markdown') {
      const md = buildMarkdown(conversation, memories, moods, user)
      return new Response(md, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="aria-${safeTitle}-${dateStr}.md"`,
        },
      })
    }

    const json = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        format: 'aria-conversation-v1',
        user: { name: user?.name, email: user?.email, tier: user?.tier },
        conversation: {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        messages: conversation.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolUsed: m.toolUsed,
          createdAt: m.createdAt,
        })),
        memories: memories.map((m) => ({
          content: m.content,
          category: m.category,
          pinned: m.pinned,
          createdAt: m.createdAt,
        })),
        moods: moods.map((m) => ({
          mood: m.mood,
          note: m.note,
          createdAt: m.createdAt,
        })),
      },
      null,
      2
    )

    return new Response(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="aria-${safeTitle}-${dateStr}.json"`,
      },
    })
  } catch (err) {
    console.error('[conversations.export]', err)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}

function buildMarkdown(
  conversation: {
    id: string
    title: string
    createdAt: Date
    updatedAt: Date
    messages: Array<{ role: string; content: string; createdAt: Date; toolUsed: string | null }>
  },
  memories: Array<{ content: string; category: string; pinned: boolean; createdAt: Date }>,
  moods: Array<{ mood: string; note: string | null; createdAt: Date }>,
  user: { name: string | null; email: string | null; tier: string | null } | null
): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title}`)
  lines.push('')
  lines.push(`> Exported from ARIA on ${new Date().toLocaleString()}`)
  lines.push(`> User: ${user?.name || 'Unknown'} (${user?.tier || 'Partner'} Tier)`)
  lines.push(`> Conversation created: ${new Date(conversation.createdAt).toLocaleString()}`)
  lines.push(`> Last updated: ${new Date(conversation.updatedAt).toLocaleString()}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  if (memories.length > 0) {
    lines.push('## What ARIA Remembers About You')
    lines.push('')
    for (const m of memories) {
      const pin = m.pinned ? '📌 ' : ''
      lines.push(`- ${pin}[${m.category}] ${m.content}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push('## Conversation')
  lines.push('')

  for (const m of conversation.messages) {
    if (m.role === 'user') {
      lines.push(`### ${user?.name || 'You'}`)
      lines.push(`*${new Date(m.createdAt).toLocaleString()}*`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    } else if (m.role === 'assistant') {
      lines.push(`### ARIA${m.toolUsed ? ` *(${m.toolUsed})*` : ''}`)
      lines.push(`*${new Date(m.createdAt).toLocaleString()}*`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }

  if (moods.length > 0) {
    lines.push('## Recent Mood History')
    lines.push('')
    for (const m of moods) {
      const note = m.note ? ` — "${m.note}"` : ''
      lines.push(`- **${m.mood}** *${new Date(m.createdAt).toLocaleString()}*${note}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('*This conversation is yours. ARIA is private by design.*')
  lines.push('')

  return lines.join('\n')
}
