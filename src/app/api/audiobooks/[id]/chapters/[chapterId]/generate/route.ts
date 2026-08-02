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
 *  ~3000 chars per segment is well within Edge TTS's practical limits. */
function splitForTts(text: string, maxLen = 3000): string[] {
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
      // Split long chapters into sub-segments, generate each, then concatenate
      const segments = splitForTts(chapter.cleanedText)
      const audioBuffers: Blob[] = []

      for (const segment of segments) {
        const tts = new EdgeTTS(segment, VOICE)
        const result = await tts.synthesize()
        // result.audio is a Blob (MP3 data) per edge-tts-universal's types
        audioBuffers.push(result.audio)
      }

      // Concatenate all segment Blobs into one MP3 file
      const combined = new Blob(audioBuffers, { type: 'audio/mpeg' })

      const blob = await put(
        `audiobooks/${chapter.audiobookId}/chapter-${chapter.chapterIndex}.mp3`,
        combined,
        { access: 'public', contentType: 'audio/mpeg' }
      )

      // Estimate duration from text length (~155 wpm) since we can't easily
      // read MP3 duration without an audio parsing library. This is close
      // enough for the progress bar.
      const wordCount = chapter.cleanedText.split(/\s+/).length
      const estimatedDuration = Math.round((wordCount / 155) * 60)

      await db.audiobookChapter.update({
        where: { id: chapter.id },
        data: {
          status: 'ready',
          audioUrl: blob.url,
          durationSeconds: estimatedDuration,
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
