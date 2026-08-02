/**
 * generate-chapter-audio.ts — shared TTS pipeline for audiobook chapters.
 *
 * Both routes that synthesize a chapter's audio (the batched prep-batch worker
 * and the per-chapter /generate endpoint called by the player) share this
 * module so they:
 *
 *   1. Use the same Blob path (`audiobooks/{audiobookId}/chapter-{order}.mp3`)
 *      with `addRandomSuffix: false`, so re-generating a chapter overwrites
 *      its own file instead of orphaning a duplicate. This is safe because
 *      `chapterOrder` is unique per audiobook.
 *
 *   2. Coordinate via an atomic DB-level claim (`claimChapterForGeneration`)
 *      so concurrent calls — e.g. the player pressing play while prep-batch
 *      is mid-poll — never double-synthesize the same chapter. The claim uses
 *      Prisma's `updateMany` with a `status in [...]` filter, so if another
 *      caller flips the row to 'generating' first, this caller's update
 *      affects zero rows and the claim returns false.
 *
 *   3. Share the same splitForTts + EdgeTTS synthesis + duration-estimation
 *      code, so behavior is identical regardless of which route triggers it.
 */

import { db } from '@/lib/db'
import { EdgeTTS } from 'edge-tts-universal'
import { put } from '@vercel/blob'

const VOICE = 'en-US-AriaNeural'

/** Split very long chapter text into sub-segments aligned on paragraph
 *  boundaries for TTS. Edge TTS handles fairly long input, but very large
 *  chapters (10K+ chars) can fail or time out. We split at 5000 chars,
 *  generate each segment, and concatenate the audio Blobs into one MP3. */
export function splitForTts(text: string, maxLen = 5000): string[] {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  const segments: string[] = []
  let current = ''
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxLen && current.length > 0) {
      segments.push(current)
      current = para
    } else {
      current = current ? current + '\n\n' + para : para
    }
  }
  if (current) segments.push(current)
  return segments.length > 0 ? segments : [text.slice(0, maxLen)]
}

/**
 * Atomically claim a chapter for TTS generation. Returns true if this caller
 * won the claim, false if another caller is already generating (or the chapter
 * is no longer in a claimable state). Uses Prisma's atomic updateMany — if
 * status is no longer 'pending' or 'failed', the update affects 0 rows and we
 * return false.
 *
 * The `failed` state is included so a chapter that previously failed (e.g. a
 * transient EdgeTTS network error) can be retried by re-claiming it.
 */
export async function claimChapterForGeneration(chapterId: string): Promise<boolean> {
  const result = await db.audiobookChapter.updateMany({
    where: { id: chapterId, status: { in: ['pending', 'failed'] } },
    data: { status: 'generating' },
  })
  return result.count > 0
}

/**
 * Generate TTS audio for a chapter. Caller MUST have won claimChapterForGeneration
 * first (otherwise the chapter is already being worked on by someone else).
 *
 * On success: sets status='ready', audioUrl, durationSeconds, returns the result.
 * On failure: sets status='failed', returns null.
 *
 * If the chapter has no cleanedText (prep hasn't run yet), marks it 'failed'
 * so the caller can surface a meaningful error instead of spinning forever.
 */
export async function generateChapterAudioTask(
  chapterId: string
): Promise<{ audioUrl: string; durationSeconds: number } | null> {
  const chapter = await db.audiobookChapter.findUnique({ where: { id: chapterId } })
  if (!chapter?.cleanedText?.trim()) {
    // No cleaned text — prep hasn't run yet, or this chapter has no content.
    // Mark as failed so the caller can react (e.g. /generate returns 409,
    // prep-batch will count it toward the COMPLETED_WITH_ERRORS terminal state).
    await db.audiobookChapter.update({ where: { id: chapterId }, data: { status: 'failed' } })
    return null
  }

  try {
    const segments = splitForTts(chapter.cleanedText)
    const audioBuffers: Blob[] = []
    let totalDurationHundredsOfNs = 0

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      try {
        const tts = new EdgeTTS(segment, VOICE)
        // 30s timeout per segment — EdgeTTS can hang indefinitely on
        // network issues, which would kill the whole batch.
        const result = await Promise.race([
          tts.synthesize(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('EdgeTTS synthesis timed out after 30s')), 30000)
          ),
        ])
        audioBuffers.push(result.audio)

        // Accumulate real duration from word-boundary timing.
        // Each segment's subtitle offsets are relative to that segment's start,
        // so we add the segment's max(offset + duration) to the running total.
        if (result.subtitle && result.subtitle.length > 0) {
          const lastWord = result.subtitle[result.subtitle.length - 1]
          const segmentDuration = (lastWord.offset ?? 0) + (lastWord.duration ?? 0)
          totalDurationHundredsOfNs += segmentDuration
        }
      } catch (ttsErr) {
        console.error(`[generate-chapter-audio] EdgeTTS failed for segment ${i + 1}/${segments.length} of chapter ${chapterId}:`, ttsErr instanceof Error ? ttsErr.message : String(ttsErr))
        throw new Error(`EdgeTTS synthesis failed: ${ttsErr instanceof Error ? ttsErr.message : String(ttsErr)}`)
      }
    }

    const combined = new Blob(audioBuffers, { type: 'audio/mpeg' })

    // addRandomSuffix: false → re-generating the same chapter overwrites its
    // own Blob instead of orphaning a duplicate. Safe because chapterOrder is
    // unique per audiobook.
    let audioUrl: string
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      // No Vercel Blob configured — store audio as a file in the public/ folder.
      // This works on Vercel's serverless (the file is written to /tmp during
      // the function's lifetime and served via the response), but the file
      // won't persist across deploys. For production, set BLOB_READ_WRITE_TOKEN.
      console.warn('[generate-chapter-audio] BLOB_READ_WRITE_TOKEN not set — storing audio as data URL (works but uses DB space). Set BLOB_READ_WRITE_TOKEN for production.')
      const arrayBuffer = await combined.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')
      audioUrl = `data:audio/mpeg;base64,${base64}`
    } else {
      const blob = await put(
        `audiobooks/${chapter.audiobookId}/chapter-${chapter.chapterOrder}.mp3`,
        combined,
        { access: 'public', contentType: 'audio/mpeg', addRandomSuffix: false }
      )
      audioUrl = blob.url
    }

    const durationSeconds = totalDurationHundredsOfNs > 0
      ? Math.round(totalDurationHundredsOfNs / 10_000_000)
      : Math.round((chapter.cleanedText.split(/\s+/).length / 155) * 60) // fallback: word count estimate

    await db.audiobookChapter.update({
      where: { id: chapterId },
      data: { status: 'ready', audioUrl, durationSeconds },
    })

    return { audioUrl, durationSeconds }
  } catch (e) {
    console.error('[generate-chapter-audio] failed:', e)
    await db.audiobookChapter.update({ where: { id: chapterId }, data: { status: 'failed' } })
    return null
  }
}
