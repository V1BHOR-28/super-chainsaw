/**
 * generate-chapter-audio.ts — shared TTS pipeline for audiobook chapters.
 *
 * Uses Edge TTS (edge-tts-universal) — Microsoft's free neural voices via
 * WebSocket. No API key needed, no model download, works within Vercel's
 * 60-second serverless timeout.
 *
 * Both routes that synthesize a chapter's audio (the batched prep-batch worker
 * and the per-chapter /generate endpoint called by the player) share this
 * module so they:
 *
 *   1. Use the same Blob path (`audiobooks/{audiobookId}/chapter-{order}.mp3`)
 *      with `addRandomSuffix: false`, so re-generating a chapter overwrites
 *      its own file instead of orphaning a duplicate.
 *
 *   2. Coordinate via an atomic DB-level claim (`claimChapterForGeneration`)
 *      so concurrent calls never double-synthesize the same chapter.
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
 * is no longer in a claimable state). Uses Prisma's atomic updateMany.
 */
export async function claimChapterForGeneration(chapterId: string): Promise<boolean> {
  const result = await db.audiobookChapter.updateMany({
    where: { id: chapterId, status: { in: ['pending', 'failed'] } },
    data: { status: 'generating' },
  })
  return result.count > 0
}

/**
 * Generate TTS audio for a chapter using Edge TTS. Caller MUST have won
 * claimChapterForGeneration first.
 *
 * On success: sets status='ready', audioUrl, durationSeconds, returns the result.
 * On failure: sets status='failed', returns null.
 */
export async function generateChapterAudioTask(
  chapterId: string
): Promise<{ audioUrl: string; durationSeconds: number } | null> {
  const chapter = await db.audiobookChapter.findUnique({ where: { id: chapterId } })
  if (!chapter?.cleanedText?.trim()) {
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
        const result = await tts.synthesize()
        audioBuffers.push(result.audio)

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

    // Upload to Vercel Blob (or fall back to data URL if not configured)
    let audioUrl: string
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.warn('[generate-chapter-audio] BLOB_READ_WRITE_TOKEN not set — storing audio as data URL')
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
      : Math.round((chapter.cleanedText.split(/\s+/).length / 155) * 60)

    await db.audiobookChapter.update({
      where: { id: chapterId },
      data: { status: 'ready', audioUrl, durationSeconds },
    })

    console.log(`[generate-chapter-audio] Chapter ${chapterId} ready (${durationSeconds}s)`)
    return { audioUrl, durationSeconds }
  } catch (e) {
    console.error('[generate-chapter-audio] failed:', e)
    await db.audiobookChapter.update({ where: { id: chapterId }, data: { status: 'failed' } })
    return null
  }
}
