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
 * Accepts an .epub file upload, parses it to get the title/author,
 * uploads the raw EPUB to Vercel Blob (so GitHub Actions can download it),
 * creates the Audiobook row, and dispatches a GitHub Actions workflow
 * to convert the EPUB into an audiobook.
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

    // Parse the EPUB to get title/author/chapter count (for the DB row)
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

    // Create the Audiobook row (no chapters yet — the GitHub Actions job will
    // create them via the callback route when TTS generation is complete)
    const audiobook = await db.audiobook.create({
      data: {
        userId,
        documentId,
        title,
        author,
        fullText,
        status: 'PENDING',
        prepStatus: 'pending',
      },
      select: { id: true, title: true },
    })

    // Create an AudiobookJob and dispatch the GitHub Actions workflow
    const job = await db.audiobookJob.create({
      data: {
        userId,
        documentId,
        audiobookId: audiobook.id,
        epubUrl: epubBlobUrl,
        status: 'queued',
      },
    })

    // Dispatch the GitHub Actions workflow
    const dispatchRes = await fetch(
      `https://api.github.com/repos/V1BHOR-28/super-chainsaw/actions/workflows/audiobook-convert.yml/dispatches`,
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
            audiobook_id: audiobook.id,
          },
        }),
      }
    )

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => '')
      console.error('[audiobooks.upload-epub] GitHub dispatch failed:', dispatchRes.status, errText)
      await db.audiobookJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: 'Could not start conversion job' },
      })
      await db.audiobook.update({
        where: { id: audiobook.id },
        data: { status: 'FAILED' },
      })
      return NextResponse.json({ error: 'Could not start audiobook conversion. Make sure GITHUB_DISPATCH_TOKEN is set.' }, { status: 502 })
    }

    // Update audiobook status to GENERATING
    await db.audiobook.update({
      where: { id: audiobook.id },
      data: { status: 'GENERATING' },
    })

    console.log(`[audiobooks.upload-epub] Created audiobook "${title}" with ${chapters.length} chapters, dispatched job ${job.id}`)

    return NextResponse.json({
      audiobookId: audiobook.id,
      jobId: job.id,
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
