import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'

const INACTIVITY_THRESHOLD_DAYS = 30

/**
 * GET /api/cron/auto-destruct — triggered by Vercel Cron (see vercel.json).
 *
 * For every user who has `UserSettings.autoDestruct = true`, checks whether
 * their most recent Message (across all conversations) is older than 30 days.
 * If so, deletes ALL of that user's Memory rows.
 *
 * "Inactivity" = no Message row created by that user's conversations in the
 * last 30 days. Computed from Message.createdAt joined through Conversation.userId,
 * not from login time.
 *
 * Every deletion is logged (userId, count, timestamp) via console.log — this
 * is a destructive, irreversible action and needs a trace.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - INACTIVITY_THRESHOLD_DAYS)

  // Find users with autoDestruct enabled
  const autoDestructUsers = await db.userSettings.findMany({
    where: { autoDestruct: true },
    select: { userId: true },
  })

  let processed = 0
  let deleted = 0

  for (const { userId } of autoDestructUsers) {
    try {
      // Find the most recent message across all this user's conversations
      const lastMessage = await db.message.findFirst({
        where: { conversation: { userId } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })

      // If no messages at all, or the most recent is older than the cutoff,
      // wipe all memories for this user.
      if (!lastMessage || lastMessage.createdAt < cutoff) {
        const result = await db.memory.deleteMany({ where: { userId } })
        if (result.count > 0) {
          console.log(`[auto-destruct] Deleted ${result.count} memory row(s) for user ${userId} (last activity: ${lastMessage?.createdAt.toISOString() ?? 'never'}, cutoff: ${cutoff.toISOString()}, timestamp: ${new Date().toISOString()})`)
          deleted += result.count
        }
      }
      processed++
    } catch (err) {
      console.error(`[auto-destruct] failed for user ${userId}:`, err)
    }
  }

  console.log(`[auto-destruct] Processed ${processed} user(s) with autoDestruct enabled. ${deleted} memory row(s) deleted total.`)

  return NextResponse.json({ ok: true, processed, deleted })
}
