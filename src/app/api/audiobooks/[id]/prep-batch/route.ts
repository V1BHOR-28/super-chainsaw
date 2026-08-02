import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { detectChapterBoundaries, cleanChapterBatch, type ChapterBoundary } from '@/lib/audiobook-prep-agent'

const BATCH_SIZE = 5 // chapters cleaned per invocation — small enough to fit in 60s alongside detection overhead

/**
 * POST /api/audiobooks/[id]/prep-batch — batched, resumable chapter preparation.
 *
 * Replaces the fire-and-forget .then()/.catch() pattern that Vercel kills when
 * the HTTP response is sent. Instead, the client polls this endpoint every few
 * seconds while the library view is open, and each call advances the audiobook
 * through its prep stages:
 *
 * 1. prepStatus === 'pending' → run detectChapterBoundaries(), store result in
 *    chapterBoundaries, set prepStatus='cleaning'. Returns { done: false, progress: 0, total: N }.
 * 2. prepStatus === 'cleaning' → run cleanChapterBatch() for BATCH_SIZE chapters
 *    starting at prepChaptersCleaned, upsert AudiobookChapter rows, increment
 *    prepChaptersCleaned. If this was the last batch, set prepStatus='ready',
 *    chaptersReady=true. Returns { done: false/true, progress, total }.
 * 3. prepStatus === 'ready' or 'failed' → idempotent, returns { done: true } immediately.
 *
 * Each call is designed to comfortably fit within a 60-second function budget.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const audiobook = await db.audiobook.findFirst({
      where: { id, userId },
      select: {
        id: true,
        fullText: true,
        chapterBoundaries: true,
        prepStatus: true,
        prepChaptersCleaned: true,
      },
    })

    if (!audiobook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Already done — idempotent
    if (audiobook.prepStatus === 'ready' || audiobook.prepStatus === 'failed') {
      return NextResponse.json({ done: true, status: audiobook.prepStatus })
    }

    // No fullText — can't prep (shouldn't happen for new uploads, but handle gracefully)
    if (!audiobook.fullText) {
      await db.audiobook.update({
        where: { id: audiobook.id },
        data: { prepStatus: 'failed', chaptersReady: true },
      })
      return NextResponse.json({ done: true, status: 'failed', error: 'No source text' })
    }

    // === Stage 1: chapter boundary detection (pass A) ===
    if (audiobook.prepStatus === 'pending') {
      try {
        await db.audiobook.update({
          where: { id: audiobook.id },
          data: { prepStatus: 'detecting' },
        })

        const boundaries = await detectChapterBoundaries(audiobook.fullText)

        if (boundaries.length === 0) {
          // No chapters detected — mark as failed but chaptersReady=true so UI doesn't hang
          await db.audiobook.update({
            where: { id: audiobook.id },
            data: { prepStatus: 'failed', chaptersReady: true },
          })
          return NextResponse.json({ done: true, status: 'failed', error: 'No chapters detected' })
        }

        // Store boundaries as JSON so pass A never re-runs on resume
        await db.audiobook.update({
          where: { id: audiobook.id },
          data: {
            chapterBoundaries: boundaries as any,
            prepStatus: 'cleaning',
            prepChaptersCleaned: 0,
          },
        })

        console.log(`[audiobook.prep-batch] ${audiobook.id}: detected ${boundaries.length} chapters, starting cleaning`)
        return NextResponse.json({
          done: false,
          status: 'cleaning',
          progress: 0,
          total: boundaries.length,
        })
      } catch (e) {
        console.error(`[audiobook.prep-batch] ${audiobook.id}: detection failed:`, e)
        await db.audiobook.update({
          where: { id: audiobook.id },
          data: { prepStatus: 'failed', chaptersReady: true },
        })
        return NextResponse.json({ done: true, status: 'failed', error: 'Detection failed' })
      }
    }

    // === Stage 2: chapter cleaning (pass B, batched) ===
    if (audiobook.prepStatus === 'cleaning' || audiobook.prepStatus === 'detecting') {
      // 'detecting' shouldn't normally be hit here (we transition to 'cleaning'
      // within the same call as detection), but handle it gracefully in case
      // a previous call crashed mid-detection.
      if (!audiobook.chapterBoundaries) {
        // Boundaries not stored — re-run detection
        await db.audiobook.update({ where: { id: audiobook.id }, data: { prepStatus: 'pending' } })
        return NextResponse.json({ done: false, status: 'pending', progress: 0, total: 0 })
      }

      const boundaries = audiobook.chapterBoundaries as unknown as ChapterBoundary[]
      const startIndex = audiobook.prepChaptersCleaned
      const total = boundaries.length

      if (startIndex >= total) {
        // All chapters already cleaned — finalize
        await db.audiobook.update({
          where: { id: audiobook.id },
          data: { prepStatus: 'ready', chaptersReady: true },
        })
        return NextResponse.json({ done: true, status: 'ready', progress: total, total })
      }

      try {
        // Clean a batch of chapters
        const batch = await cleanChapterBatch(
          audiobook.fullText,
          boundaries,
          startIndex,
          BATCH_SIZE
        )

        // Upsert each chapter as an AudiobookChapter row
        for (const ch of batch) {
          if (!ch.cleanedText) continue // skip empty chapters
          await db.audiobookChapter.upsert({
            where: {
              audiobookId_chapterIndex: {
                audiobookId: audiobook.id,
                chapterIndex: ch.index,
              },
            },
            update: {
              title: ch.title,
              cleanedText: ch.cleanedText,
              status: 'pending',
            },
            create: {
              audiobookId: audiobook.id,
              chapterIndex: ch.index,
              title: ch.title,
              cleanedText: ch.cleanedText,
              status: 'pending',
            },
          })
        }

        const newCleanedCount = startIndex + batch.length
        const isLastBatch = newCleanedCount >= total

        if (isLastBatch) {
          await db.audiobook.update({
            where: { id: audiobook.id },
            data: {
              prepChaptersCleaned: newCleanedCount,
              prepStatus: 'ready',
              chaptersReady: true,
            },
          })
          console.log(`[audiobook.prep-batch] ${audiobook.id}: cleaning complete (${newCleanedCount}/${total} chapters)`)
          return NextResponse.json({
            done: true,
            status: 'ready',
            progress: newCleanedCount,
            total,
          })
        } else {
          await db.audiobook.update({
            where: { id: audiobook.id },
            data: { prepChaptersCleaned: newCleanedCount },
          })
          console.log(`[audiobook.prep-batch] ${audiobook.id}: cleaned ${newCleanedCount}/${total} chapters`)
          return NextResponse.json({
            done: false,
            status: 'cleaning',
            progress: newCleanedCount,
            total,
          })
        }
      } catch (e) {
        console.error(`[audiobook.prep-batch] ${audiobook.id}: cleaning batch failed:`, e)
        // Don't mark as failed on a single batch error — the client will retry
        // and the next batch might succeed. Only mark failed if this is a
        // persistent issue (the client will eventually give up polling).
        return NextResponse.json({
          done: false,
          status: 'cleaning',
          progress: startIndex,
          total,
          error: 'Batch failed, will retry',
        })
      }
    }

    // Shouldn't reach here, but handle gracefully
    return NextResponse.json({ done: true, status: audiobook.prepStatus })
  } catch (err) {
    console.error('[audiobook.prep-batch]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
