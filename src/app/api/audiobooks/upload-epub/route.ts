import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { put } from '@vercel/blob'

/**
 * POST /api/audiobooks/upload-epub
 *
 * Accepts an .epub file upload, uploads the raw EPUB to Vercel Blob,
 * creates the Audiobook row, and dispatches a GitHub Actions PARSE job
 * (not a conversion job). The parse job runs the Python tts_brain parser
 * (the same parser used for conversion) and calls back with the chapter list.
 *
 * This ensures the chapter list the user sees in the selector is IDENTICAL
 * to what the conversion script will produce — no TS/Python parser mismatch.
 *
 * The book lands as `PARSING`. When the parse callback arrives (~20-30s),
 * the callback route creates AudiobookChapter rows and sets the book to
 * `READY_TO_SELECT`.
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

    // Read the file for Blob upload
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Extract title from filename for dedup check (the Python parser will
    // give us the real title, but we need something for dedup now)
    const dedupTitle = fileName.replace(/\.epub$/i, '').replace(/[_-]/g, ' ').trim()

    // Dedup: check if an audiobook with the same filename-based title exists
    const existing = await db.audiobook.findFirst({
      where: { userId, title: dedupTitle },
      select: { id: true, status: true },
    })
    if (existing) {
      return NextResponse.json({
        audiobookId: existing.id,
        title: dedupTitle,
        chapterCount: 0,
        alreadyExists: true,
      })
    }

    // Upload the raw EPUB file to Vercel Blob
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.warn('[audiobooks.upload-epub] BLOB_READ_WRITE_TOKEN not set')
      return NextResponse.json({ error: 'Audio storage is not configured. Set BLOB_READ_WRITE_TOKEN.' }, { status: 500 })
    }
    const epubBlob = await put(
      `epubs/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`,
      buffer,
      { access: 'public', contentType: 'application/epub+zip', addRandomSuffix: false }
    )
    const epubBlobUrl = epubBlob.url
    console.log(`[audiobooks.upload-epub] EPUB uploaded to Blob: ${epubBlobUrl}`)

    const documentId = `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create the Audiobook row with status PARSING — the parse callback will
    // update the title/author from the EPUB metadata and create chapter rows.
    const audiobook = await db.audiobook.create({
      data: {
        userId,
        documentId,
        title: dedupTitle, // temporary — parse callback updates with real title
        status: 'PARSING',
        prepStatus: 'pending',
      },
      select: { id: true, title: true },
    })

    // Create a job row for the parse step
    const job = await db.audiobookJob.create({
      data: {
        userId,
        documentId,
        audiobookId: audiobook.id,
        epubUrl: epubBlobUrl,
        status: 'queued',
      },
    })

    // Dispatch the PARSE workflow (not the conversion workflow)
    const dispatchRes = await fetch(
      `https://api.github.com/repos/V1BHOR-28/super-chainsaw/actions/workflows/audiobook-parse.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            job_id: job.id,
            epub_url: epubBlobUrl,
          },
        }),
      }
    )

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => '')
      console.error('[audiobooks.upload-epub] GitHub dispatch failed:', dispatchRes.status, errText)
      await db.audiobookJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: 'Could not start parse job' },
      })
      await db.audiobook.update({
        where: { id: audiobook.id },
        data: { status: 'FAILED' },
      })
      return NextResponse.json({ error: 'Could not start parsing. Make sure GITHUB_DISPATCH_TOKEN is set.' }, { status: 502 })
    }

    console.log(`[audiobooks.upload-epub] Dispatched parse job ${job.id} for audiobook ${audiobook.id}`)

    return NextResponse.json({
      audiobookId: audiobook.id,
      jobId: job.id,
      title: audiobook.title,
      chapterCount: 0, // chapters not yet available — parse job will create them
      parsing: true,
    })
  } catch (err) {
    console.error('[audiobooks.upload-epub]', err)
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Failed to upload EPUB'
    }, { status: 500 })
  }
}
