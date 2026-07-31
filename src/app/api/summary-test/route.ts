import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { updateConversationSummary } from '@/lib/conversation-summary'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Temporary diagnostic: generates a real rolling summary on the conversation
// with the most messages, so we can verify the feature works end-to-end on
// Vercel's production infrastructure. Will be removed after verification.
export async function GET() {
  try {
    const convos = await db.$queryRaw<Array<{ id: string; title: string; msgcount: bigint }>>`
      SELECT c.id, c.title, COUNT(m.id)::bigint as msgcount
      FROM "Conversation" c
      JOIN "Message" m ON m."conversationId" = c.id
      GROUP BY c.id, c.title
      HAVING COUNT(m.id) >= 10
      ORDER BY msgcount DESC
      LIMIT 1
    `
    if (convos.length === 0) {
      return NextResponse.json({ ok: false, error: 'No conversation with 10+ messages found.' })
    }
    const target = convos[0]
    // Reset so it re-summarizes from scratch for the demo
    await db.conversation.update({ where: { id: target.id }, data: { summary: null, summaryMessageCount: 0 } })
    await updateConversationSummary(target.id)
    const updated = await db.conversation.findUnique({ where: { id: target.id }, select: { summary: true, summaryMessageCount: true } })
    return NextResponse.json({
      ok: true,
      conversation: { id: target.id, title: target.title, messageCount: Number(target.msgcount) },
      summary: updated?.summary ?? null,
      summaryMessageCount: updated?.summaryMessageCount ?? 0,
      summaryLength: updated?.summary?.length ?? 0,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'unknown' }, { status: 500 })
  }
}
