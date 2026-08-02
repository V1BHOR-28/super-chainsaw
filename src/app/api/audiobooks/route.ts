import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/audiobooks — list the authenticated user's audiobooks, newest first.
 * Audiobooks are auto-created when book-length content is fed via /api/knowledge.
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const audiobooks = await db.audiobook.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        author: true,
        accent: true,
        documentId: true,
        createdAt: true,
        progressChapter: true,
        progressCharOffset: true,
      },
    })

    return NextResponse.json({ audiobooks })
  } catch (err) {
    console.error('[audiobooks.list]', err)
    return NextResponse.json({ error: 'Failed to load audiobooks' }, { status: 500 })
  }
}
