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
 * chapterUrls is: Array<{ order: number, title: string, url: string | null }>
 *
 * PARTIAL COMPLETION SUPPORT:
 * The job's `chapterIndices` field lists which chapter orders were in scope
 * for this job. We only update chapters whose order is in that list —
 * unselected chapters (and previously-converted ones from prior jobs) are
 * left untouched. This enables the selective-conversion flow: a user can
 * convert chapters 1-3, then later convert 4-6, and the first batch is
 * preserved.
 *
 * If `chapterIndices` is empty (legacy behavior / whole-book conversion),
 * we fall back to the old delete-all-then-recreate behavior.
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

    // If the job is complete and linked to an audiobook, update the chapter rows
    if (status === 'complete' && job.audiobookId && chapterUrls?.length > 0) {
      type ChapterResult = { order: number; title: string; url: string | null }
      const results = chapterUrls as ChapterResult[]

      if (job.chapterIndices.length > 0) {
        // ── SELECTIVE CONVERSION: only update chapters in this job's scope ──
        // Chapters not in `chapterIndices` are left untouched (they may be
        // `pending` from a future selection, or `ready` from a prior job).
        const inScope = new Set(job.chapterIndices)
        const resultsInScope = results.filter(r => inScope.has(r.order))

        for (const r of resultsInScope) {
          if (r.url) {
            await db.audiobookChapter.updateMany({
              where: {
                audiobookId: job.audiobookId,
                chapterOrder: r.order,
              },
              data: {
                status: 'ready',
                audioUrl: r.url,
                title: r.title,  // sync any title refinements from the parser
              },
            })
          } else {
            // Chapter failed — mark it so the UI can show a retry affordance
            await db.audiobookChapter.updateMany({
              where: {
                audiobookId: job.audiobookId,
                chapterOrder: r.order,
              },
              data: { status: 'failed' },
            })
          }
        }

        // Determine aggregate audiobook status based on all chapters now
        const allChapters = await db.audiobookChapter.findMany({
          where: { audiobookId: job.audiobookId },
          select: { status: true },
        })
        const readyCount = allChapters.filter(c => c.status === 'ready').length
        const failedCount = allChapters.filter(c => c.status === 'failed').length
        const pendingCount = allChapters.filter(c => c.status === 'pending' || c.status === 'generating').length

        let newStatus: string
        if (readyCount === 0) {
          newStatus = 'FAILED'
        } else if (failedCount > 0 || pendingCount > 0) {
          newStatus = 'COMPLETED_WITH_ERRORS'
        } else {
          newStatus = 'COMPLETED'
        }
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: { status: newStatus },
        })

        console.log(`[audiobook.callback] Job ${jobId} complete (selective): ${resultsInScope.filter(r => r.url).length}/${resultsInScope.length} chapters in scope. Audiobook ${job.audiobookId} → ${newStatus} (ready=${readyCount}, failed=${failedCount}, pending=${pendingCount})`)
      } else {
        // ── LEGACY: whole-book conversion (no chapterIndices) ──
        // Delete existing chapters and recreate from the callback payload.
        // This path is kept for backward compat with any jobs dispatched
        // before the selective-conversion feature shipped.
        await db.audiobookChapter.deleteMany({
          where: { audiobookId: job.audiobookId },
        })

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

        const hasFailures = results.some(c => !c.url)
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: { status: hasFailures ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED' },
        })

        console.log(`[audiobook.callback] Job ${jobId} complete (legacy full-book): ${succeeded.length}/${results.length} chapters, audiobook ${job.audiobookId} → ${hasFailures ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'}`)
      }
    } else if (status === 'failed' && job.audiobookId) {
      // Mark any chapters that were in-scope for this job as failed (not stuck at 'generating')
      if (job.chapterIndices.length > 0) {
        await db.audiobookChapter.updateMany({
          where: {
            audiobookId: job.audiobookId,
            chapterOrder: { in: job.chapterIndices },
            status: 'generating',
          },
          data: { status: 'failed' },
        })
      }
      // Only flip the audiobook to FAILED if NO chapters are ready — otherwise
      // keep it COMPLETED_WITH_ERRORS so the user can still play what's there
      const readyCount = await db.audiobookChapter.count({
        where: { audiobookId: job.audiobookId, status: 'ready' },
      })
      if (readyCount === 0) {
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: { status: 'FAILED' },
        })
      } else {
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: { status: 'COMPLETED_WITH_ERRORS' },
        })
      }
      console.error(`[audiobook.callback] Job ${jobId} failed: ${errorMessage}`)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[audiobook.callback]', err)
    return NextResponse.json({ error: 'Callback failed' }, { status: 500 })
  }
}
