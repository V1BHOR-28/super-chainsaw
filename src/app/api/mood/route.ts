import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/mood — list mood entries (most recent first)
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const moods = await db.mood.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 90,
    })
    return NextResponse.json({ moods })
  } catch (err) {
    console.error('[mood.list]', err)
    return NextResponse.json({ error: 'Failed to load moods' }, { status: 500 })
  }
}

/**
 * POST /api/mood — log a mood entry
 * Body: { mood: 'great'|'good'|'okay'|'low'|'rough', note?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const valid = ['great', 'good', 'okay', 'low', 'rough']
    const mood = body.mood as string
    if (!valid.includes(mood)) {
      return NextResponse.json({ error: 'invalid mood' }, { status: 400 })
    }

    const entry = await db.mood.create({
      data: {
        userId,
        mood,
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
      },
    })
    return NextResponse.json({ mood: entry })
  } catch (err) {
    console.error('[mood.create]', err)
    return NextResponse.json({ error: 'Failed to log mood' }, { status: 500 })
  }
}
