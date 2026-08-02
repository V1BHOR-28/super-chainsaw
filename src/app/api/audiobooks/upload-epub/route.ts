import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { parseEpub } from '@/lib/epub-parser'

/**
 * POST /api/audiobooks/upload-epub
 *
 * Accepts an .epub file upload, parses it server-side to extract the TOC
 * and chapter HTML, and creates the Audiobook + AudiobookChapter rows.
 *
 * The Audiobook is created with status='PENDING'. Chapter cleaning + TTS
 * generation happens later via the prep-batch route, driven by client polling.
 *
 * Body (multipart/form-data): { file: Blob (.epub) }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const formData = await req.formData()
    const file = formData.get('file')
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const fileName = (file as File).name || 'upload.epub'
    if (!fileName.toLowerCase().endsWith('.epub') && file.type !== 'application/epub+zip') {
      return NextResponse.json({ error: 'Please upload an .epub file. PDF files are no longer supported.' }, { status: 400 })
    }

    // Parse the EPUB server-side
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const { title, author, chapters, fullText } = await parseEpub(buffer)

    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No readable chapters found in this EPUB.' }, { status: 400 })
    }

    const documentId = `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create the Audiobook + AudiobookChapter rows
    const audiobook = await db.audiobook.create({
      data: {
        userId,
        documentId,
        title,
        author,
        fullText,
        status: 'PENDING',
        prepStatus: 'pending',
        chapters: {
          create: chapters.map((ch) => ({
            chapterOrder: ch.order,
            chapterIndex: ch.order, // keep both in sync for backward compat
            title: ch.title,
            rawHtml: ch.rawHtml,
            rawText: ch.rawText,
            cleanedText: '', // will be filled by the prep agent
            status: 'pending',
          })),
        },
      },
      select: { id: true, title: true },
    })

    console.log(`[audiobooks.upload-epub] Created audiobook "${title}" with ${chapters.length} chapters`)

    return NextResponse.json({
      audiobookId: audiobook.id,
      title: audiobook.title,
      chapterCount: chapters.length,
    })
  } catch (err) {
    console.error('[audiobooks.upload-epub]', err)
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Failed to upload EPUB'
    }, { status: 500 })
  }
}
