import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/reminders — list reminders (incomplete first, then by due date)
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const reminders = await db.reminder.findMany({
      where: { userId },
      orderBy: [{ completed: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
    })
    return NextResponse.json({ reminders })
  } catch (err) {
    console.error('[reminders.list]', err)
    return NextResponse.json({ error: 'Failed to load reminders' }, { status: 500 })
  }
}

/**
 * POST /api/reminders — create a reminder
 * Body: { title: string, dueAt?: string (ISO) }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const title = (body.title as string)?.trim()
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })

    const dueAt = body.dueAt ? new Date(body.dueAt as string) : null
    if (dueAt && isNaN(dueAt.getTime())) {
      return NextResponse.json({ error: 'invalid dueAt' }, { status: 400 })
    }

    const reminder = await db.reminder.create({
      data: {
        userId,
        title: title.slice(0, 200),
        dueAt,
      },
    })
    return NextResponse.json({ reminder })
  } catch (err) {
    console.error('[reminders.create]', err)
    return NextResponse.json({ error: 'Failed to create reminder' }, { status: 500 })
  }
}
