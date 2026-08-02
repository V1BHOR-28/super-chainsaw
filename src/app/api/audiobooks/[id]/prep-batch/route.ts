import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import {
  cleanChapterText,
  detectChapterBoundaries,
  cleanChapterBatch,
  type ChapterBoundary,
} from '@/lib/audiobook-prep-agent'
import { claimChapterForGeneration, generateChapterAudioTask } from '@/lib/generate-chapter-audio'

const BATCH_SIZE = 1 // process ONE chapter per call (cleaning + TTS) to stay within 60s.
// The LLM cleaning call has a 25s timeout and Kokoro TTS synthesis can take 10-30s
// per chapter, so 1 chapter per call = ~35-55s, safely within the 60s budget.
// Multiple chapters per call risks timeout → chapter stuck at 'generating' forever.

// Stale-generation recovery threshold — a chapter stuck in 'generating' for
// longer than this is assumed to have been orphaned by a function timeout
// (Vercel maxDuration=60s) and is reset to 'pending' so it can be retried.
// 5 minutes is well above any legitimate TTS synthesis duration.
const STALE_GENERATING_MS = 5 * 60 * 1000

/**
 * POST /api/audiobooks/[id]/prep-batch — batched, resumable chapter preparation
 * + TTS generation.
 *
 * This route is the Phase 4 batch worker. The client polls it every few
 * seconds while the library view is open. Each call advances the audiobook
 * through its stages:
 *
 * 1. For each chapter without cleanedText: run cleanChapterText() (LLM cleaning).
 * 2. For each chapter with cleanedText but without audioUrl: generate TTS audio
 *    via Edge TTS, upload to Vercel Blob, save audioUrl + durationSeconds.
 * 3. When all chapters have audioUrl: set Audiobook.status = 'COMPLETED'.
 *
 * Processes BATCH_SIZE chapters per call to stay within the 60s function budget.
 * Idempotent — safe to call repeatedly. Returns { done, progress, total, status }.
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
        title: true,
        status: true,
        // Include fullText + chapterBoundaries so we can run pass A (detection)
        // and pass B (batched cleaning) inline — see the chapter-boundary
        // detection block below.
        fullText: true,
        chapterBoundaries: true,
        chapters: {
          orderBy: { chapterOrder: 'asc' },
          // updatedAt is needed by the stuck-chapter recovery pass below.
          select: {
            id: true,
            chapterOrder: true,
            title: true,
            rawText: true,
            cleanedText: true,
            status: true,
            audioUrl: true,
            updatedAt: true,
          },
        },
      },
    })

    if (!audiobook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Already completed — idempotent
    if (audiobook.status === 'COMPLETED') {
      return NextResponse.json({ done: true, status: 'COMPLETED', progress: audiobook.chapters.length, total: audiobook.chapters.length })
    }
    if (audiobook.status === 'FAILED') {
      // Allow retry — reset failed chapters back to pending and set status to GENERATING.
      // This lets the user click "Retry" on a failed audiobook to re-attempt generation.
      console.log(`[audiobook.prep-batch] ${audiobook.id}: retrying FAILED audiobook — resetting failed chapters to pending`)
      await db.audiobookChapter.updateMany({
        where: { audiobookId: audiobook.id, status: 'failed' },
        data: { status: 'pending' },
      })
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'GENERATING' } })
      // Update local copies
      audiobook.chapters = audiobook.chapters.map(c =>
        c.status === 'failed' ? { ...c, status: 'pending' } : c
      )
    }
    // COMPLETED_WITH_ERRORS is also a terminal state — treat like COMPLETED for polling.
    if (audiobook.status === 'COMPLETED_WITH_ERRORS') {
      const readyCount = audiobook.chapters.filter(c => c.audioUrl).length
      return NextResponse.json({ done: true, status: 'COMPLETED_WITH_ERRORS', progress: readyCount, total: audiobook.chapters.length })
    }

    // Set status to GENERATING if still PENDING
    if (audiobook.status === 'PENDING') {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'GENERATING' } })
    }

    // === CHAPTER BOUNDARY DETECTION (Bug #10) ===
    // If the audiobook has fullText but no stored chapter boundaries yet,
    // run detectChapterBoundaries now and persist the result. This is the
    // "pass A" step from the file header — runs once, result is reused on
    // every subsequent poll. If the audiobook has zero chapter rows (e.g.
    // legacy backfilled books created before the autoBackfill fix), create
    // them from the boundaries.
    if (!audiobook.chapterBoundaries && audiobook.fullText) {
      try {
        console.log(`[audiobook.prep-batch] ${audiobook.id}: detecting chapter boundaries (pass A)`)
        const boundaries = await detectChapterBoundaries(audiobook.fullText)
        if (boundaries.length > 0) {
          await db.audiobook.update({
            where: { id: audiobook.id },
            data: { chapterBoundaries: boundaries as unknown as PrismaJson, prepStatus: 'cleaning' },
          })
          audiobook.chapterBoundaries = boundaries as unknown as PrismaJson
          console.log(`[audiobook.prep-batch] ${audiobook.id}: stored ${boundaries.length} chapter boundaries`)

          // If no chapter rows exist yet, create them from the boundaries.
          // This is the path that rescues legacy backfilled books that were
          // created before autoBackfill started creating chapter rows.
          if (audiobook.chapters.length === 0) {
            const chaptersData = boundaries.map((b) => ({
              audiobookId: audiobook.id,
              chapterOrder: b.index,
              chapterIndex: b.index, // keep both in sync for backward compat
              title: b.title,
              rawHtml: '',
              rawText: audiobook.fullText!.slice(b.startOffset, b.endOffset),
              cleanedText: '',
              status: 'pending' as const,
            }))
            await db.audiobookChapter.createMany({ data: chaptersData })
            // Re-fetch so the rest of the route sees the newly-created rows
            audiobook.chapters = await db.audiobookChapter.findMany({
              where: { audiobookId: audiobook.id },
              orderBy: { chapterOrder: 'asc' },
              select: {
                id: true,
                chapterOrder: true,
                title: true,
                rawText: true,
                cleanedText: true,
                status: true,
                audioUrl: true,
                updatedAt: true,
              },
            })
            console.log(`[audiobook.prep-batch] ${audiobook.id}: created ${chaptersData.length} chapter rows from boundaries`)
          }
        } else {
          console.log(`[audiobook.prep-batch] ${audiobook.id}: detectChapterBoundaries returned 0 boundaries, skipping detection`)
        }
      } catch (detectErr) {
        console.error(`[audiobook.prep-batch] ${audiobook.id}: chapter boundary detection failed:`, detectErr instanceof Error ? detectErr.message : String(detectErr))
        // Non-fatal — fall back to existing chapters + cleanChapterText path below
      }
    }

    // No chapters — can't proceed (also covers the case where detection above
    // returned 0 boundaries and no chapters exist)
    if (audiobook.chapters.length === 0) {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'FAILED' } })
      return NextResponse.json({ done: true, status: 'FAILED', error: 'No chapters' })
    }

    // === STUCK CHAPTER RECOVERY (Bug #6 Part B) ===
    // Reset chapters stuck in 'generating' for more than STALE_GENERATING_MS —
    // they were likely orphaned by a function timeout (Vercel maxDuration=60s).
    // The 5-minute threshold is well above any legitimate TTS synthesis
    // duration, so we won't accidentally reset in-flight work. The updatedAt
    // column (added in the chapter_updated_at migration) lets us detect this.
    const now = Date.now()
    for (const chapter of audiobook.chapters) {
      if (chapter.status === 'generating' && !chapter.audioUrl) {
        const updatedAtMs = chapter.updatedAt instanceof Date ? chapter.updatedAt.getTime() : 0
        const stuckForMs = now - updatedAtMs
        if (stuckForMs > STALE_GENERATING_MS) {
          console.log(`[audiobook.prep-batch] ${audiobook.id}: resetting stale 'generating' chapter ${chapter.chapterOrder + 1} to pending (stuck for ${Math.round(stuckForMs / 1000)}s)`)
          await db.audiobookChapter.update({
            where: { id: chapter.id },
            data: { status: 'pending' },
          })
          chapter.status = 'pending' // update local copy too
        }
      }
    }

    const total = audiobook.chapters.length
    let processed = 0

    // Find chapters that need work (either cleaning or TTS generation)
    // Process up to BATCH_SIZE per call. Skip chapters that have already
    // failed (status === 'failed') so we don't get stuck retrying the same
    // failed chapter on every poll while chapters 4-9 never get processed.
    for (const chapter of audiobook.chapters) {
      if (processed >= BATCH_SIZE) break

      // Skip chapters that already failed — don't retry them in this pass
      if (chapter.status === 'failed') continue

      try {
        // Step 1: Clean if not yet cleaned
        // Use a explicit check for empty string AND not-yet-cleaned status,
        // rather than !chapter.cleanedText (which is truthy for empty string)
        if (chapter.cleanedText === '' && chapter.status === 'pending') {
          // If rawText is also empty, mark as failed and skip
          if (!chapter.rawText || chapter.rawText.trim().length === 0) {
            console.warn(`[audiobook.prep-batch] ${audiobook.id}: chapter ${chapter.chapterOrder + 1} has empty rawText, marking as failed`)
            await db.audiobookChapter.update({ where: { id: chapter.id }, data: { status: 'failed' } })
            continue
          }

          console.log(`[audiobook.prep-batch] ${audiobook.id}: cleaning chapter ${chapter.chapterOrder + 1}/${total}`)

          // Use the batched cleaning path (cleanChapterBatch) when chapter
          // boundaries are available — this is the "pass B (batched)" path
          // the file header promised, and completes the resumable two-pass
          // design. Falls back to cleanChapterText (per-chapter path) when
          // boundaries aren't available or the chapter index is out of range.
          let cleaned: string | null = null
          const boundaries = (audiobook.chapterBoundaries as unknown as ChapterBoundary[] | null) ?? null
          if (boundaries && audiobook.fullText && chapter.chapterOrder >= 0 && chapter.chapterOrder < boundaries.length) {
            try {
              const prepared = await cleanChapterBatch(
                audiobook.fullText,
                boundaries,
                chapter.chapterOrder,
                1
              )
              cleaned = prepared[0]?.cleanedText ?? null
            } catch (batchErr) {
              console.error(`[audiobook.prep-batch] ${audiobook.id}: cleanChapterBatch failed for chapter ${chapter.chapterOrder + 1}, falling back to cleanChapterText:`, batchErr instanceof Error ? batchErr.message : String(batchErr))
              cleaned = null
            }
          }
          if (cleaned === null) {
            cleaned = await cleanChapterText(chapter.rawText)
          }

          await db.audiobookChapter.update({
            where: { id: chapter.id },
            data: { cleanedText: cleaned },
          })
          chapter.cleanedText = cleaned

          // Advance the resumable prep counter so progress survives resumes.
          await db.audiobook.update({
            where: { id: audiobook.id },
            data: { prepChaptersCleaned: { increment: 1 } },
          })

          processed++

          // If we've hit the batch limit, return — cleaning is the expensive part
          if (processed >= BATCH_SIZE) break
        }

        // Step 2: Generate TTS audio via the shared claim + task pipeline.
        // claimChapterForGeneration atomically flips status pending/failed → generating.
        // If another caller (e.g. the /generate route, or another prep-batch tab)
        // already claimed it, we skip and let them finish — this prevents the
        // double-TTS + orphaned-Blob problem from Bug #5.
        // Skip chapters with status 'generating' (another request is working on them)
        // and status 'failed' (already failed, don't retry).
        if (chapter.cleanedText && !chapter.audioUrl && chapter.status !== 'generating' && chapter.status !== 'failed') {
          console.log(`[audiobook.prep-batch] ${audiobook.id}: generating TTS for chapter ${chapter.chapterOrder + 1}/${total}`)
          const claimed = await claimChapterForGeneration(chapter.id)
          if (claimed) {
            const result = await generateChapterAudioTask(chapter.id)
            if (result) {
              chapter.audioUrl = result.audioUrl
              chapter.status = 'ready'
              console.log(`[audiobook.prep-batch] ${audiobook.id}: chapter ${chapter.chapterOrder + 1} ready (${result.durationSeconds}s)`)
            } else {
              chapter.status = 'failed'
              console.error(`[audiobook.prep-batch] ${audiobook.id}: TTS failed for chapter ${chapter.chapterOrder + 1}`)
            }
            processed++
            if (processed >= BATCH_SIZE) break
          }
          // If not claimed, another caller is generating — leave it alone and
          // move on to the next chapter. We'll see the result on the next poll.
        }
      } catch (e) {
        console.error(`[audiobook.prep-batch] ${audiobook.id}: processing failed for chapter ${chapter.chapterOrder + 1}:`, e)
        processed++
      }
    }

    // Re-fetch chapter statuses — the loop above updated its in-memory copies,
    // but concurrent invocations of prep-batch (or the per-chapter /generate
    // route) may have changed rows we didn't touch in this call.
    const refreshedChapters = await db.audiobookChapter.findMany({
      where: { audiobookId: audiobook.id },
      select: { audioUrl: true, status: true },
    })

    // Check terminal state across all chapters. Three terminal outcomes:
    //   - all chapters ready            → COMPLETED
    //   - some ready, some failed       → COMPLETED_WITH_ERRORS (still playable, with a warning)
    //   - none ready, all failed        → FAILED
    // The old code only checked the first and last case, leaving mixed
    // ready+failed states stuck in GENERATING forever (the client would
    // keep polling, and the loop would keep re-attempting the failed chapter).
    const readyCount = refreshedChapters.filter(c => c.audioUrl).length
    const failedCount = refreshedChapters.filter(c => c.status === 'failed').length
    const pendingCount = refreshedChapters.filter(c => c.status === 'pending' || c.status === 'generating').length

    if (pendingCount === 0) {
      if (failedCount === 0) {
        await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'COMPLETED' } })
        console.log(`[audiobook.prep-batch] ${audiobook.id}: COMPLETED (${readyCount}/${total} chapters)`)
        return NextResponse.json({ done: true, status: 'COMPLETED', progress: readyCount, total })
      }
      // Some chapters failed — mark COMPLETED_WITH_ERRORS so the user can
      // still play the ready ones, with a warning badge on the failures.
      const status = readyCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'FAILED'
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status } })
      console.log(`[audiobook.prep-batch] ${audiobook.id}: ${status} (${readyCount} ready, ${failedCount} failed)`)
      return NextResponse.json({ done: true, status, progress: readyCount, total, failedCount })
    }

    return NextResponse.json({
      done: false,
      status: 'GENERATING',
      progress: readyCount,
      total,
    })
  } catch (err) {
    console.error('[audiobook.prep-batch]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// Local type alias for Prisma JSON values — using `any` to avoid importing
// the Prisma namespace (which isn't available as a global in this context).
type PrismaJson = any
