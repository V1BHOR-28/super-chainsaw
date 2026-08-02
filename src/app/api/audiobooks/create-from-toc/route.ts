import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

interface TocChapter {
  title: string
  rawText: string
}

/**
 * POST /api/audiobooks/create-from-toc
 *
 * Creates an Audiobook + AudiobookChapter rows from the PDF's Table of
 * Contents (extracted client-side via pdfjs-dist's getOutline()). This is
 * the Phase 2 endpoint — the client sends the structured chapter data
 * (title + rawText per chapter) and we create the DB rows.
 *
 * The Audiobook is created with status='PENDING'. Chapter preparation
 * (cleaning + TTS generation) happens later via the prep-batch route,
 * driven by client polling.
 *
 * Body: { documentId, title, chapters: TocChapter[] }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const { documentId, title, chapters } = body as { documentId: string; title: string; chapters: TocChapter[] }

    if (!documentId || !title || !Array.isArray(chapters) || chapters.length === 0) {
      return NextResponse.json({ error: 'Missing required fields: documentId, title, chapters[]' }, { status: 400 })
    }

    // Check if an audiobook already exists for this documentId (idempotent)
    const existing = await db.audiobook.findFirst({
      where: { userId, documentId },
      select: { id: true },
    })

    if (existing) {
      return NextResponse.json({ audiobookId: existing.id, alreadyExists: true })
    }

    // Create the Audiobook + AudiobookChapter rows in a single transaction
    const audiobook = await db.audiobook.create({
      data: {
        userId,
        documentId,
        title,
        author: null,
        fullText: chapters.map(c => c.rawText).join('\n\n'),
        status: 'PENDING',
        prepStatus: 'pending',
        chapters: {
          create: chapters.map((ch, i) => ({
            order: i,
            title: ch.title.slice(0, 200),
            rawText: ch.rawText,
            cleanedText: '', // will be filled by the prep agent
            status: 'pending',
          })),
        },
      },
      select: { id: true },
    })

    console.log(`[audiobooks.create-from-toc] Created audiobook "${title}" with ${chapters.length} chapters`)

    return NextResponse.json({ audiobookId: audiobook.id, chapterCount: chapters.length })
  } catch (err) {
    console.error('[audiobooks.create-from-toc]', err)
    return NextResponse.json({ error: 'Failed to create audiobook' }, { status: 500 })
  }
}
