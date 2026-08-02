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
        chapters: {
          select: { status: true },
        },
      },
    })

    // Compute narrated chapter counts for each audiobook
    const audiobooksWithCounts = audiobooks.map(a => {
      const total = a.chapters.length
      const narrated = a.chapters.filter(c => c.status === 'ready').length
      // Strip the full chapters array — just return counts
      const { chapters: _chapters, ...rest } = a
      return { ...rest, chapterCount: total, narratedCount: narrated }
    })

    return NextResponse.json({ audiobooks: audiobooksWithCounts })
  } catch (err) {
    console.error('[audiobooks.list]', err)
    return NextResponse.json({ error: 'Failed to load audiobooks' }, { status: 500 })
  }
}
