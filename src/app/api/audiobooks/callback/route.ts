import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'

/**
 * POST /api/audiobooks/callback
 *
 * Called by GitHub Actions workflows (parse + convert). Authenticated via
 * APP_CALLBACK_SECRET shared between this route and the workflows.
 *
 * Two callback types:
 *
 * 1. PARSE callback (from audiobook-parse.yml / parse_epub.py):
 *    Body: { jobId, status: 'parse_complete', bookTitle, bookAuthor, chapters: [{title, text, order}] }
 *    or:   { jobId, status: 'parse_failed', errorMessage }
 *    Creates AudiobookChapter rows and sets the audiobook to READY_TO_SELECT.
 *
 * 2. CONVERT callback (from audiobook-convert.yml / convert_audiobook.py):
 *    Body: { jobId, status: 'complete', chapterUrls: [{order, title, url|null}] }
 *    or:   { jobId, status: 'failed', errorMessage }
 *    Updates chapter rows (only those in job.chapterIndices) and sets the
 *    audiobook status based on aggregate chapter statuses.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.APP_CALLBACK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { jobId, status, errorMessage } = body

    const job = await db.audiobookJob.findUnique({ where: { id: jobId } })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // ── PARSE callbacks ───────────────────────────────────────────────────
    if (status === 'parse_complete') {
      const { bookTitle, bookAuthor, chapters } = body as {
        bookTitle?: string
        bookAuthor?: string
        chapters: Array<{ title: string; text: string; order: number }>
      }

      if (!chapters || chapters.length === 0) {
        await db.audiobookJob.update({
          where: { id: jobId },
          data: { status: 'failed', errorMessage: 'No chapters found' },
        })
        if (job.audiobookId) {
          await db.audiobook.update({
            where: { id: job.audiobookId },
            data: { status: 'FAILED' },
          })
        }
        return NextResponse.json({ ok: true })
      }

      // Update the job status
      await db.audiobookJob.update({
        where: { id: jobId },
        data: { status: 'complete' },
      })

      if (job.audiobookId) {
        // Update the audiobook with the real title/author from the EPUB metadata
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: {
            title: bookTitle || 'Untitled',
            author: bookAuthor || null,
            status: 'READY_TO_SELECT',
          },
        })

        // Create AudiobookChapter rows from the parsed chapters
        await db.audiobookChapter.createMany({
          data: chapters.map((ch) => ({
            audiobookId: job.audiobookId!,
            chapterOrder: ch.order,
            chapterIndex: ch.order,
            title: ch.title,
            rawText: ch.text,
            cleanedText: ch.text,
            status: 'pending',
          })),
        })

        console.log(`[audiobook.callback] Parse complete: audiobook ${job.audiobookId} "${bookTitle}" — ${chapters.length} chapters created, status → READY_TO_SELECT`)
      }

      return NextResponse.json({ ok: true })
    }

    if (status === 'parse_failed') {
      await db.audiobookJob.update({
        where: { id: jobId },
        data: { status: 'failed', errorMessage: errorMessage ?? 'Parse failed' },
      })
      if (job.audiobookId) {
        await db.audiobook.update({
          where: { id: job.audiobookId },
          data: { status: 'FAILED' },
        })
      }
      console.error(`[audiobook.callback] Parse failed for job ${jobId}: ${errorMessage}`)
      return NextResponse.json({ ok: true })
    }

    // ── CONVERT callbacks ─────────────────────────────────────────────────
    const { chapterUrls } = body

    // Update the job status
    await db.audiobookJob.update({
      where: { id: jobId },
      data: {
        status,
        chapterUrls: chapterUrls ?? [],
        errorMessage: errorMessage ?? null,
      },
    })

    if (status === 'complete' && job.audiobookId && chapterUrls?.length > 0) {
      type ChapterResult = { order: number; title: string; url: string | null }
      const results = chapterUrls as ChapterResult[]

      if (job.chapterIndices.length > 0) {
        // ── SELECTIVE CONVERSION: only update chapters in this job's scope ──
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
                title: r.title,
              },
            })
          } else {
            await db.audiobookChapter.updateMany({
              where: {
                audiobookId: job.audiobookId,
                chapterOrder: r.order,
              },
              data: { status: 'failed' },
            })
          }
        }

        // Determine aggregate audiobook status
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

        console.log(`[audiobook.callback] Job ${jobId} complete (selective): ${resultsInScope.filter(r => r.url).length}/${resultsInScope.length} in scope. Audiobook → ${newStatus} (ready=${readyCount}, failed=${failedCount}, pending=${pendingCount})`)
      } else {
        // ── LEGACY: whole-book conversion (no chapterIndices) ──
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
        console.log(`[audiobook.callback] Job ${jobId} complete (legacy): ${succeeded.length}/${results.length} chapters`)
      }
    } else if (status === 'failed' && job.audiobookId) {
      // Mark in-scope generating chapters as failed
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
      // Only flip to FAILED if no chapters are ready
      const readyCount = await db.audiobookChapter.count({
        where: { audiobookId: job.audiobookId, status: 'ready' },
      })
      await db.audiobook.update({
        where: { id: job.audiobookId },
        data: { status: readyCount === 0 ? 'FAILED' : 'COMPLETED_WITH_ERRORS' },
      })
      console.error(`[audiobook.callback] Job ${jobId} failed: ${errorMessage}`)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[audiobook.callback]', err)
    return NextResponse.json({ error: 'Callback failed' }, { status: 500 })
  }
}
