import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'

/**
 * POST /api/audiobooks/callback
 *
 * Called by the GitHub Actions workflow when the audiobook conversion
 * is complete (or failed). Authenticated via APP_CALLBACK_SECRET
 * shared between this route and the workflow's environment.
 *
 * Body: { jobId, status, chapterUrls?, errorMessage? }
 * chapterUrls is now: Array<{ order: number, title: string, url: string | null }>
 */
export async function POST(req: NextRequest) {
  // Verify the callback secret
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.APP_CALLBACK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { jobId, status, chapterUrls, errorMessage } = await req.json()

    const job = await db.audiobookJob.findUnique({ where: { id: jobId } })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // Update the job status
    await db.audiobookJob.update({
      where: { id: jobId },
      data: {
        status,
        chapterUrls: chapterUrls ?? [],
        errorMessage: errorMessage ?? null,
      },
    })

    // If the job is complete and linked to an audiobook, update the audiobook
    // and create AudiobookChapter rows from the structured chapter results.
    if (status === 'complete' && job.audiobookId && chapterUrls?.length > 0) {
      // Delete any existing chapters (from a previous failed attempt)
      await db.audiobookChapter.deleteMany({
        where: { audiobookId: job.audiobookId },
      })

      // chapterUrls is now: Array<{ order: number, title: string, url: string | null }>
      // Only create rows for chapters that actually have audio (url is not null).
      type ChapterResult = { order: number; title: string; url: string | null }
      const results = chapterUrls as ChapterResult[]
      const succeeded = results.filter(c => c.url)

      await db.audiobookChapter.createMany({
        data: succeeded.map((c) => ({
          audiobookId: job.audiobookId!,
          chapterOrder: c.order,
          chapterIndex: c.order,
          title: c.title,
          rawHtml: '',
          rawText: '',
          cleanedText: '',
          status: 'ready',
          audioUrl: c.url!,
        })),
      })

      // Mark the audiobook as completed (even if some chapters failed — the
      // user can still play the ones that succeeded)
      await db.audiobook.update({
        where: { id: job.audiobookId },
        data: { status: 'COMPLETED' },
      })

      console.log(`[audiobook.callback] Job ${jobId} complete: ${succeeded.length}/${results.length} chapters, audiobook ${job.audiobookId} marked COMPLETED`)
    } else if (status === 'failed' && job.audiobookId) {
      await db.audiobook.update({
        where: { id: job.audiobookId },
        data: { status: 'FAILED' },
      })
      console.error(`[audiobook.callback] Job ${jobId} failed: ${errorMessage}`)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[audiobook.callback]', err)
    return NextResponse.json({ error: 'Callback failed' }, { status: 500 })
  }
}
