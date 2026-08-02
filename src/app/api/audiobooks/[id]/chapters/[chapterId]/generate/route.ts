import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { claimChapterForGeneration, generateChapterAudioTask } from '@/lib/generate-chapter-audio'

/**
 * POST /api/audiobooks/[id]/chapters/[chapterId]/generate
 *
 * Generate (or return the cached) TTS audio for a single chapter.
 *
 * Shares the actual TTS pipeline with the prep-batch worker via
 * `generateChapterAudioTask` in `src/lib/generate-chapter-audio.ts`, and uses
 * the same atomic `claimChapterForGeneration` claim. This means:
 *
 *   - If prep-batch is mid-poll when the player presses play on the same
 *     chapter, only one TTS generation runs. The losing caller gets a 409
 *     with status='generating' and should poll.
 *   - Re-generating an existing chapter overwrites the same Blob path — no
 *     orphaned MP3s accumulate.
 *
 * Status codes:
 *   200 — audioUrl ready (either already-ready, or freshly generated)
 *   409 — chapter is pending prep (cleanedText empty), OR another caller is
 *         currently generating this chapter. Client should react accordingly
 *         (trigger prep-batch for pending, or poll for generating).
 *   500 — TTS generation actually failed.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; chapterId: string }> }
) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { chapterId } = await params
    // Filter by audiobook.userId so a logged-in user can only touch their own chapters.
    const chapter = await db.audiobookChapter.findFirst({
      where: { id: chapterId, audiobook: { userId } },
    })
    if (!chapter) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Already generated — return the stored URL (cache hit, no work to do).
    if (chapter.status === 'ready' && chapter.audioUrl) {
      return NextResponse.json({ audioUrl: chapter.audioUrl, status: 'ready' })
    }

    // No cleanedText means prep hasn't run for this chapter yet. Return 409
    // (not 500) so the client can distinguish "prep needed" from "TTS broke".
    // Edge TTS would fail on empty input anyway — better to short-circuit here.
    if (!chapter.cleanedText?.trim()) {
      return NextResponse.json(
        { error: 'Chapter not prepared yet', status: 'pending' },
        { status: 409 }
      )
    }

    // Atomically claim the chapter. If another caller (prep-batch polling, or
    // the same chapter being clicked in another tab) already flipped the row
    // to 'generating', this update affects 0 rows and we return 409 so the
    // client polls instead of double-synthesizing.
    const claimed = await claimChapterForGeneration(chapter.id)
    if (!claimed) {
      // Another caller is generating — return current status, client should poll.
      return NextResponse.json({ status: 'generating' }, { status: 409 })
    }

    // We won the claim — run the shared TTS pipeline.
    const result = await generateChapterAudioTask(chapter.id)
    if (result) {
      return NextResponse.json({ audioUrl: result.audioUrl, status: 'ready' })
    }
    return NextResponse.json(
      { error: 'Generation failed', status: 'failed' },
      { status: 500 }
    )
  } catch (err) {
    console.error('[audiobook.generate]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
