import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

export const runtime = 'nodejs'
export const maxDuration = 60 // this can take longer than a single-conversation export for heavy users

/**
 * GET /api/export/all?format=json|markdown
 *
 * Exports EVERYTHING for the authenticated user in one file:
 * all conversations (with messages), all memories, all knowledge-base
 * documents, all mood entries, all reminders. This is a full backup, not
 * a share-a-conversation feature — /api/conversations/[id]/export still
 * exists separately for that.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const format = searchParams.get('format') === 'markdown' ? 'markdown' : 'json'

    const [user, conversations, memories, knowledge, moods, reminders] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, tier: true, createdAt: true } }),
      db.conversation.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      }),
      db.memory.findMany({ where: { userId }, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }] }),
      // Knowledge rows are chunked (one row per ~3000 chars) — group them back
      // into whole documents by documentId before exporting, so the export
      // reads as complete documents, not fragmented chunks.
      db.knowledge.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      db.mood.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      db.reminder.findMany({ where: { userId }, orderBy: { dueAt: 'asc' } }),
    ])

    // Reassemble Knowledge chunks into whole documents by documentId
    const knowledgeByDoc = new Map<string, { title: string; source: string; sourceUrl: string | null; createdAt: Date; chunks: string[] }>()
    for (const k of knowledge) {
      const docId = k.documentId || k.id // fall back to row id for any pre-migration rows without documentId
      const baseTitle = k.title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')
      if (!knowledgeByDoc.has(docId)) {
        knowledgeByDoc.set(docId, { title: baseTitle, source: k.source, sourceUrl: k.sourceUrl, createdAt: k.createdAt, chunks: [] })
      }
      knowledgeByDoc.get(docId)!.chunks.push(k.content)
    }
    const knowledgeDocs = Array.from(knowledgeByDoc.values()).map((d) => ({
      title: d.title,
      source: d.source,
      sourceUrl: d.sourceUrl,
      createdAt: d.createdAt,
      content: d.chunks.join('\n\n'),
    }))

    const dateStr = new Date().toISOString().slice(0, 10)

    if (format === 'markdown') {
      const md = buildFullMarkdown(user, conversations, memories, knowledgeDocs, moods, reminders)
      return new Response(md, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="aria-full-export-${dateStr}.md"`,
        },
      })
    }

    const json = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        format: 'aria-full-export-v1',
        user: { name: user?.name, email: user?.email, tier: user?.tier, memberSince: user?.createdAt },
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          pinned: c.pinned,
          summary: c.summary,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messages: c.messages.map((m) => ({ role: m.role, content: m.content, toolUsed: m.toolUsed, createdAt: m.createdAt })),
        })),
        memories: memories.map((m) => ({ content: m.content, category: m.category, pinned: m.pinned, source: m.source, createdAt: m.createdAt })),
        knowledge: knowledgeDocs,
        moods: moods.map((m) => ({ mood: m.mood, note: m.note, createdAt: m.createdAt })),
        reminders: reminders.map((r) => ({ title: r.title, dueAt: r.dueAt, completed: r.completed })),
      },
      null,
      2
    )

    return new Response(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="aria-full-export-${dateStr}.json"`,
      },
    })
  } catch (err) {
    console.error('[export.all]', err)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}

function buildFullMarkdown(
  user: { name: string | null; email: string | null; tier: string | null; createdAt: Date } | null,
  conversations: Array<{ id: string; title: string; pinned: boolean; createdAt: Date; summary: string | null; messages: Array<{ role: string; content: string; createdAt: Date }> }>,
  memories: Array<{ content: string; category: string; pinned: boolean; createdAt: Date }>,
  knowledgeDocs: Array<{ title: string; source: string; createdAt: Date; content: string }>,
  moods: Array<{ mood: string; note: string | null; createdAt: Date }>,
  reminders: Array<{ title: string; dueAt: Date | null; completed: boolean }>
): string {
  const lines: string[] = []
  lines.push(`# ARIA — Full Export`)
  lines.push('')
  lines.push(`> User: ${user?.name || 'Unknown'} (${user?.email || ''})`)
  lines.push(`> Exported: ${new Date().toLocaleString()}`)
  lines.push(`> Member since: ${user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'unknown'}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  lines.push('## Memories')
  lines.push('')
  if (memories.length === 0) lines.push('_No memories yet._')
  for (const m of memories) {
    lines.push(`- ${m.pinned ? '📌 ' : ''}[${m.category}] ${m.content}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  lines.push('## Knowledge Base')
  lines.push('')
  if (knowledgeDocs.length === 0) lines.push('_Nothing fed yet._')
  for (const doc of knowledgeDocs) {
    lines.push(`### ${doc.title}`)
    lines.push(`*Source: ${doc.source} · Added ${new Date(doc.createdAt).toLocaleDateString()}*`)
    lines.push('')
    lines.push(doc.content.slice(0, 5000) + (doc.content.length > 5000 ? '\n\n*(truncated in this export — full content is in the JSON export)*' : ''))
    lines.push('')
  }
  lines.push('---')
  lines.push('')

  lines.push('## Conversations')
  lines.push('')
  for (const c of conversations) {
    lines.push(`### ${c.pinned ? '📌 ' : ''}${c.title}`)
    lines.push(`*${new Date(c.createdAt).toLocaleString()} · ${c.messages.length} messages*`)
    if (c.summary) {
      lines.push(`*Summary: ${c.summary}*`)
    }
    lines.push('')
    for (const m of c.messages) {
      lines.push(`**${m.role === 'user' ? (user?.name || 'You') : 'ARIA'}:** ${m.content}`)
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }

  lines.push('## Mood History')
  lines.push('')
  if (moods.length === 0) lines.push('_No mood entries._')
  for (const m of moods) {
    lines.push(`- **${m.mood}** *${new Date(m.createdAt).toLocaleString()}*${m.note ? ` — "${m.note}"` : ''}`)
  }
  lines.push('')

  lines.push('## Reminders')
  lines.push('')
  if (reminders.length === 0) lines.push('_No reminders._')
  for (const r of reminders) {
    lines.push(`- [${r.completed ? 'x' : ' '}] ${r.title} — due ${r.dueAt ? new Date(r.dueAt).toLocaleDateString() : 'no date'}`)
  }
  lines.push('')

  return lines.join('\n')
}
