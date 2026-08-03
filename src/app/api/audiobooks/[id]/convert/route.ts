import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/audiobooks/[id]/convert
 *
 * Converts a user-selected subset of chapters for an audiobook.
 *
 * Body: { chapterIds: string[] }  — the AudiobookChapter IDs the user picked
 *
 * Flow:
 *   1. Validate ownership + that the chapters belong to this audiobook.
 *   2. Filter out any chapters already `ready` (no re-converting).
 *   3. Mark the selected chapters `status: 'generating'`.
 *   4. Look up the epubUrl from the most recent AudiobookJob for this audiobook.
 *   5. Create a new AudiobookJob with `chapterIndices` = the chapter `order`s.
 *   6. Dispatch GitHub Actions with `chapter_indices` input (comma-separated).
 *   7. Set Audiobook.status = 'GENERATING'.
 *
 * The callback route uses `chapterIndices` to update only those chapters,
 * leaving unselected ones (and any previously-converted ones) untouched.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: audiobookId } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { chapterIds } = await req.json()
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      return NextResponse.json({ error: 'chapterIds must be a non-empty array' }, { status: 400 })
    }

    // Verify the audiobook belongs to the user
    const audiobook = await db.audiobook.findFirst({
      where: { id: audiobookId, userId },
      select: { id: true, title: true, status: true },
    })
    if (!audiobook) {
      return NextResponse.json({ error: 'Audiobook not found' }, { status: 404 })
    }

    // Fetch the requested chapters, validating they belong to this audiobook
    const chapters = await db.audiobookChapter.findMany({
      where: {
        id: { in: chapterIds },
        audiobookId,
      },
      select: { id: true, chapterOrder: true, status: true, title: true },
    })

    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No matching chapters found for this audiobook' }, { status: 404 })
    }

    // Filter out already-ready chapters (no point re-converting)
    const toConvert = chapters.filter(c => c.status !== 'ready')
    if (toConvert.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'All selected chapters are already ready — nothing to convert',
        jobId: null,
      })
    }

    const chapterOrders = toConvert.map(c => c.chapterOrder).sort((a, b) => a - b)

    // Mark the selected chapters as generating (so the UI shows the spinner)
    await db.audiobookChapter.updateMany({
      where: { id: { in: toConvert.map(c => c.id) } },
      data: { status: 'generating' },
    })

    // Look up the epubUrl from the most recent job for this audiobook
    // (the upload route stored it on the audiobook's first job; subsequent
    // convert jobs reuse the same EPUB)
    let epubUrl = ''
    const lastJob = await db.audiobookJob.findFirst({
      where: { userId, audiobookId },
      orderBy: { createdAt: 'desc' },
      select: { epubUrl: true, documentId: true },
    })
    if (lastJob) {
      epubUrl = lastJob.epubUrl
    } else {
      // No prior job — the upload route should have created the audiobook
      // without dispatching, so we need the epubUrl from somewhere.
      // The upload route uploads to Blob but doesn't store the URL on the
      // Audiobook row. This is a gap — return an error so the user knows.
      return NextResponse.json({
        error: 'No EPUB URL found for this audiobook. Re-upload the EPUB.',
      }, { status: 400 })
    }

    // Create the job row with the chapter indices
    const job = await db.audiobookJob.create({
      data: {
        userId,
        documentId: lastJob.documentId,
        audiobookId,
        epubUrl,
        status: 'queued',
        chapterIndices: chapterOrders,
      },
    })

    // Dispatch the GitHub Actions workflow with the chapter list
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
            epub_url: epubUrl,
            audiobook_id: audiobookId,
            chapter_indices: chapterOrders.join(','),
          },
        }),
      }
    )

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => '')
      console.error('[audiobooks.convert] GitHub dispatch failed:', dispatchRes.status, errText)
      await db.audiobookJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: 'Could not start conversion job' },
      })
      // Revert chapter statuses so the UI doesn't show them stuck at 'generating'
      await db.audiobookChapter.updateMany({
        where: { id: { in: toConvert.map(c => c.id) } },
        data: { status: 'pending' },
      })
      return NextResponse.json({ error: 'Could not start conversion' }, { status: 502 })
    }

    // Update audiobook status to GENERATING
    await db.audiobook.update({
      where: { id: audiobookId },
      data: { status: 'GENERATING' },
    })

    console.log(`[audiobooks.convert] Dispatched job ${job.id} for audiobook ${audiobookId} — chapters: ${chapterOrders.join(',')}`)

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      chapterCount: toConvert.length,
    })
  } catch (err) {
    console.error('[audiobooks.convert]', err)
    return NextResponse.json({ error: 'Failed to start conversion' }, { status: 500 })
  }
}
