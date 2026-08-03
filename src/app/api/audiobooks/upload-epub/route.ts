import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { parseEpub } from '@/lib/epub-parser'
import { put } from '@vercel/blob'

/**
 * POST /api/audiobooks/upload-epub
 *
 * Accepts an .epub file upload, parses it to extract title/author/chapters,
 * uploads the raw EPUB to Vercel Blob (so GitHub Actions can download it
 * later), and creates the Audiobook row + ALL AudiobookChapter rows upfront
 * with status='pending' and cleanedText populated.
 *
 * The book lands in the library as READY_TO_SELECT — the user must open it
 * and pick which chapters to convert via the /convert route. This avoids
 * spending TTS quota on chapters the user may not want, and matches the
 * audiobook-maker.com UX where users see a chapter list with checkboxes
 * after upload.
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
      return NextResponse.json({ error: 'Please upload an .epub file.' }, { status: 400 })
    }

    const MAX_EPUB_SIZE = 50 * 1024 * 1024
    if (file.size > MAX_EPUB_SIZE) {
      return NextResponse.json({ error: `EPUB too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.` }, { status: 413 })
    }

    // Read the file once — used for both parsing and Blob upload
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Parse the EPUB to get title/author/chapters (chapters now persisted upfront)
    const { title, author, chapters, fullText } = await parseEpub(buffer)

    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No readable chapters found in this EPUB.' }, { status: 400 })
    }

    // Dedup: check if an audiobook with the same title already exists
    const existing = await db.audiobook.findFirst({
      where: { userId, title },
      select: { id: true, status: true },
    })
    if (existing) {
      return NextResponse.json({
        audiobookId: existing.id,
        title,
        chapterCount: 0,
        alreadyExists: true,
      })
    }

    // Upload the raw EPUB file to Vercel Blob so GitHub Actions can download it
    let epubBlobUrl = ''
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const epubBlob = await put(
        `epubs/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`,
        buffer,
        { access: 'public', contentType: 'application/epub+zip', addRandomSuffix: false }
      )
      epubBlobUrl = epubBlob.url
      console.log(`[audiobooks.upload-epub] EPUB uploaded to Blob: ${epubBlobUrl}`)
    } else {
      console.warn('[audiobooks.upload-epub] BLOB_READ_WRITE_TOKEN not set — cannot upload EPUB for GitHub Actions')
      return NextResponse.json({ error: 'Audio storage is not configured. Set BLOB_READ_WRITE_TOKEN.' }, { status: 500 })
    }

    const documentId = `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create the Audiobook row + ALL AudiobookChapter rows upfront.
    // Chapters land with status='pending' and cleanedText populated from the
    // parser. The user selects which to convert via the /convert route; this
    // route does NOT dispatch GitHub Actions anymore.
    //
    // READY_TO_SELECT tells the library UI to show a "Select chapters" affordance
    // instead of a "Converting…" spinner.
    const audiobook = await db.audiobook.create({
      data: {
        userId,
        documentId,
        title,
        author,
        fullText,
        status: 'READY_TO_SELECT',
        prepStatus: 'pending',
        chapters: {
          create: chapters.map((ch, idx) => ({
            chapterOrder: ch.order ?? idx,
            chapterIndex: ch.order ?? idx,
            title: ch.title,
            rawText: ch.rawText,
            cleanedText: ch.rawText,
            status: 'pending',
          })),
        },
      },
      select: { id: true, title: true },
    })

    console.log(`[audiobooks.upload-epub] Created audiobook "${title}" with ${chapters.length} chapters (READY_TO_SELECT — awaiting user chapter selection)`)

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
