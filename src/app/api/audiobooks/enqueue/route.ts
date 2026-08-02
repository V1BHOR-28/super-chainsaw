import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { getAuthenticatedUserId } from '@/lib/user'
import { db } from '@/lib/db'

/**
 * POST /api/audiobooks/enqueue
 *
 * Creates an AudiobookJob row and dispatches the GitHub Actions workflow
 * to convert the EPUB into an audiobook. The workflow runs on a free
 * GitHub-hosted runner (up to 45 minutes), installs epub2tts + ffmpeg,
 * generates TTS audio per chapter, uploads to Vercel Blob, then calls
 * the callback route to report completion.
 *
 * Body: { documentId, epubUrl, audiobookId? }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { documentId, epubUrl, audiobookId } = await req.json()

    // If only audiobookId is provided (retry case), look up the epubUrl from
    // the most recent job for this audiobook.
    let finalEpubUrl = epubUrl
    let finalDocumentId = documentId
    let finalAudiobookId = audiobookId

    if (!finalEpubUrl && finalAudiobookId) {
      const lastJob = await db.audiobookJob.findFirst({
        where: { userId, audiobookId: finalAudiobookId },
        orderBy: { createdAt: 'desc' },
        select: { epubUrl: true, documentId: true },
      })
      if (lastJob) {
        finalEpubUrl = lastJob.epubUrl
        finalDocumentId = finalDocumentId || lastJob.documentId
      }
    }

    if (!finalDocumentId || !finalEpubUrl) {
      return NextResponse.json({ error: 'documentId and epubUrl required (or audiobookId for retry)' }, { status: 400 })
    }

    // Create the job row
    const job = await db.audiobookJob.create({
      data: {
        userId,
        documentId: finalDocumentId,
        audiobookId: finalAudiobookId || null,
        epubUrl: finalEpubUrl,
        status: 'queued',
      },
    })

    // If audiobookId is provided, update the audiobook status to GENERATING
    if (finalAudiobookId) {
      await db.audiobook.update({
        where: { id: finalAudiobookId, userId },
        data: { status: 'GENERATING' },
      })
    }

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
            epub_url: finalEpubUrl,
            audiobook_id: finalAudiobookId || '',
          },
        }),
      }
    )

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => '')
      console.error('[audiobook.enqueue] GitHub dispatch failed:', dispatchRes.status, errText)
      await db.audiobookJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: 'Could not start conversion job' },
      })
      if (finalAudiobookId) {
        await db.audiobook.update({
          where: { id: finalAudiobookId, userId },
          data: { status: 'FAILED' },
        })
      }
      return NextResponse.json({ error: 'Could not start conversion' }, { status: 502 })
    }

    console.log(`[audiobook.enqueue] Dispatched job ${job.id} for ${finalEpubUrl}`)
    return NextResponse.json({ jobId: job.id })
  } catch (err) {
    console.error('[audiobook.enqueue]', err)
    return NextResponse.json({ error: 'Failed to enqueue' }, { status: 500 })
  }
}
