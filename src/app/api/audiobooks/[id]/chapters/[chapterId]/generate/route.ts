import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { EdgeTTS } from 'edge-tts-universal'
import { put } from '@vercel/blob'

const VOICE = 'en-US-AriaNeural' // warm, natural — reasonable default; consider making this a user setting later

/** Split very long chapter text into sub-segments aligned on paragraph
 *  boundaries, so Edge TTS doesn't choke on a single massive input.
 *
 *  Raised from 3000 to 5000 chars/segment — Edge TTS handles this reliably
 *  (the practical failure point is well above this), and fewer segments
 *  means fewer MP3-boundary concatenation artifacts per chapter.
 *  If a chapter is short enough to fit in one segment (<5000 chars), no
 *  concatenation happens at all — the audio is a single clean MP3. */
function splitForTts(text: string, maxLen = 5000): string[] {
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

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; chapterId: string }> }
) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { chapterId } = await params
    const chapter = await db.audiobookChapter.findFirst({
      where: { id: chapterId, audiobook: { userId } },
    })
    if (!chapter) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Already generated — return the stored URL
    if (chapter.status === 'ready' && chapter.audioUrl) {
      return NextResponse.json({ audioUrl: chapter.audioUrl, status: 'ready' })
    }

    // Mark as generating so concurrent requests don't double-generate
    await db.audiobookChapter.update({ where: { id: chapter.id }, data: { status: 'generating' } })

    try {
      // Split long chapters into sub-segments, generate each, then concatenate.
      // Each segment's synthesize() returns { audio: Blob, subtitle: WordBoundary[] }.
      // We accumulate the subtitle timing across segments to compute the REAL
      // audio duration (offset + duration of the last word boundary) instead
      // of estimating from word count.
      const segments = splitForTts(chapter.cleanedText)
      const audioBuffers: Blob[] = []
      let totalDurationHundredsOfNs = 0 // accumulated duration in 100-nanosecond units

      for (const segment of segments) {
        const tts = new EdgeTTS(segment, VOICE)
        const result = await tts.synthesize()
        // result.audio is a Blob (MP3 data) per edge-tts-universal's types
        audioBuffers.push(result.audio)

        // Accumulate real duration from word boundary timing.
        // Each segment's subtitle offsets are relative to that segment's start,
        // so we add the segment's max(offset + duration) to the running total.
        if (result.subtitle && result.subtitle.length > 0) {
          const lastWord = result.subtitle[result.subtitle.length - 1]
          const segmentDuration = (lastWord.offset ?? 0) + (lastWord.duration ?? 0)
          totalDurationHundredsOfNs += segmentDuration
        }
      }

      // Concatenate all segment Blobs into one MP3 file.
      // NOTE: raw Blob concatenation of MP3 streams can produce minor audible
      // artifacts at segment boundaries (clicks/gaps). This is a known limitation
      // of not having ffmpeg available in Vercel's serverless environment for
      // proper audio-frame-aligned stitching. We mitigate by using larger segments
      // (5000 chars vs the previous 3000) so fewer boundaries exist per chapter.
      // A proper fix would require either a Vercel-compatible ffmpeg layer or
      // switching to a TTS service that handles long-form synthesis natively.
      const combined = new Blob(audioBuffers, { type: 'audio/mpeg' })

      const blob = await put(
        `audiobooks/${chapter.audiobookId}/chapter-${chapter.order}.mp3`,
        combined,
        { access: 'public', contentType: 'audio/mpeg' }
      )

      // Compute actual duration from accumulated word-boundary timing.
      // 100-nanosecond units → seconds: divide by 10,000,000.
      // Fall back to word-count estimate only if subtitle data was missing.
      let durationSeconds: number
      if (totalDurationHundredsOfNs > 0) {
        durationSeconds = Math.round(totalDurationHundredsOfNs / 10_000_000)
      } else {
        const wordCount = chapter.cleanedText.split(/\s+/).length
        durationSeconds = Math.round((wordCount / 155) * 60)
      }

      await db.audiobookChapter.update({
        where: { id: chapter.id },
        data: {
          status: 'ready',
          audioUrl: blob.url,
          durationSeconds,
        },
      })

      return NextResponse.json({ audioUrl: blob.url, status: 'ready' })
    } catch (genErr) {
      console.error('[audiobook.generate]', genErr)
      await db.audiobookChapter.update({ where: { id: chapter.id }, data: { status: 'failed' } })
      return NextResponse.json({ error: 'Generation failed', status: 'failed' }, { status: 500 })
    }
  } catch (err) {
    console.error('[audiobook.generate]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
