import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { generateWithFallback } from '@/lib/llm-fallback'

/**
 * GET /api/cron/daily-digest — triggered by Vercel Cron (see vercel.json).
 * For every user, builds a short digest from recent mood + upcoming
 * reminders + a one-paragraph recap, and stores it for the frontend to
 * display next time they open the app. Does NOT send email/push — this
 * project has no notification channel set up, and adding one isn't free.
 * It's a "waiting for you" digest, not a push notification.
 */
export async function GET(req: NextRequest) {
  // Verify this is actually Vercel Cron calling, not a public hit
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const users = await db.user.findMany({ select: { id: true, name: true } })
  let processed = 0

  for (const user of users) {
    try {
      const [recentMoods, upcomingReminders, recentConvo] = await Promise.all([
        db.mood.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
        db.reminder.findMany({
          where: { userId: user.id, dueAt: { gte: new Date() }, completed: false },
          orderBy: { dueAt: 'asc' },
          take: 5,
        }),
        db.conversation.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' }, select: { summary: true } }),
      ])

      if (recentMoods.length === 0 && upcomingReminders.length === 0 && !recentConvo?.summary) {
        continue // nothing to say — don't manufacture a digest from nothing
      }

      const prompt = `Write a short (under 100 words), warm, plain-prose daily check-in for ${user.name || 'the user'} from their AI companion ARIA. Use only what's given below — do not invent anything not listed.

Recent mood entries: ${recentMoods.map((m) => m.mood).join(', ') || 'none logged'}
Upcoming reminders: ${upcomingReminders.map((r) => `${r.title} (due ${r.dueAt.toDateString()})`).join('; ') || 'none'}
Last conversation summary: ${recentConvo?.summary || 'none yet'}

Write it as ARIA speaking directly to them. No headers, no bullet points, just a short warm paragraph.`

      const digest = await generateWithFallback(prompt)
      if (!digest) continue

      await db.dailyDigest.upsert({
        where: { userId_date: { userId: user.id, date: new Date(new Date().toDateString()) } },
        create: { userId: user.id, date: new Date(new Date().toDateString()), content: digest },
        update: { content: digest },
      })
      processed++
    } catch (err) {
      console.error(`[daily-digest] failed for user ${user.id}:`, err)
      // Continue to the next user — one failure shouldn't block everyone else's digest
    }
  }

  return NextResponse.json({ ok: true, processed, total: users.length })
}
