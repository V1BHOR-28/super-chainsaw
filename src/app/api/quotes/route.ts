import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/quotes — list the user's saved quotes, newest first.
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const quotes = await db.quote.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return NextResponse.json({ quotes })
  } catch (err) {
    console.error('[quotes.list]', err)
    return NextResponse.json({ error: 'Failed to load quotes' }, { status: 500 })
  }
}

/**
 * POST /api/quotes — save a new quote.
 * Body: { text: string, bookTitle?: string, author?: string, note?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const text = (body.text as string)?.trim()
    if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })
    if (text.length > 2000) return NextResponse.json({ error: 'Quote too long (max 2000 chars)' }, { status: 400 })

    const quote = await db.quote.create({
      data: {
        userId,
        text,
        bookTitle: (body.bookTitle as string)?.trim().slice(0, 200) || null,
        author: (body.author as string)?.trim().slice(0, 100) || null,
        note: (body.note as string)?.trim().slice(0, 500) || null,
      },
    })

    return NextResponse.json({ quote })
  } catch (err) {
    console.error('[quotes.create]', err)
    return NextResponse.json({ error: 'Failed to save quote' }, { status: 500 })
  }
}
