import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { deriveChapters, type DerivedChapter } from '@/lib/audiobook-chapters'

/**
 * GET /api/audiobooks/[id]/chapters — fetch the linked Knowledge chunks for
 * that audiobook's documentId (ordered, concatenated), run them through
 * deriveChapters(), and return the chapter list including full text (needed
 * client-side to feed the speech synthesizer).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const audiobook = await db.audiobook.findFirst({
      where: { id, userId },
      select: {
        id: true,
        title: true,
        author: true,
        accent: true,
        documentId: true,
        progressChapter: true,
        progressCharOffset: true,
      },
    })

    if (!audiobook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Fetch all Knowledge chunks for this documentId, ordered by title
    // (which encodes "Part N/M" so they sort in the right order).
    const chunks = await db.knowledge.findMany({
      where: { userId, documentId: audiobook.documentId, source: { not: 'summary' } },
      orderBy: { title: 'asc' },
      select: { content: true, title: true },
    })

    // Concatenate all chunks into the full text — chapters are derived from
    // the complete document, not per-chunk, so chapter headings that span
    // chunk boundaries are detected correctly.
    const fullText = chunks.map(c => c.content).join('\n\n')

    const chapters: DerivedChapter[] = deriveChapters(fullText)

    return NextResponse.json({
      audiobook,
      chapters,
    })
  } catch (err) {
    console.error('[audiobooks.chapters]', err)
    return NextResponse.json({ error: 'Failed to load chapters' }, { status: 500 })
  }
}
