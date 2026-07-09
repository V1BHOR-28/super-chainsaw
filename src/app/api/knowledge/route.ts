import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/knowledge — list all knowledge entries
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const knowledge = await db.knowledge.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, source: true, sourceUrl: true, createdAt: true, content: true },
    })

    // Truncate content for list view
    const list = knowledge.map(k => ({
      ...k,
      content: k.content.slice(0, 200) + (k.content.length > 200 ? '...' : ''),
      contentLength: k.content.length,
    }))

    return NextResponse.json({ knowledge: list })
  } catch (err) {
    console.error('[knowledge.list]', err)
    return NextResponse.json({ error: 'Failed to load knowledge' }, { status: 500 })
  }
}
