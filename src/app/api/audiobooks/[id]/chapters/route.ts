import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

export interface ChapterRow {
  id: string
  chapterOrder: number
  title: string
  cleanedText: string
  rawText: string
  status: string // pending | generating | ready | failed
  audioUrl: string | null
  durationSeconds: number | null
}

/**
 * GET /api/audiobooks/[id]/chapters — returns the AudiobookChapter rows
 * for this audiobook, ordered by `order` (chapter position from the PDF's TOC).
 * Each chapter carries its own TTS generation status and audio URL.
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
        status: true,
        progressChapter: true,
        progressCharOffset: true,
      },
    })

    if (!audiobook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const chapterRows = await db.audiobookChapter.findMany({
      where: { audiobookId: id },
      orderBy: { chapterOrder: 'asc' },
      select: {
        id: true,
        chapterOrder: true,
        title: true,
        cleanedText: true,
        rawText: true,        // needed by feed-aria-modal to build fullText for RAG indexing
        status: true,
        audioUrl: true,
        durationSeconds: true,
      },
    })

    const chapters: ChapterRow[] = chapterRows

    return NextResponse.json({
      audiobook,
      chapters,
    })
  } catch (err) {
    console.error('[audiobooks.chapters]', err)
    return NextResponse.json({ error: 'Failed to load chapters' }, { status: 500 })
  }
}
