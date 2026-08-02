import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { cleanChapterText } from '@/lib/audiobook-prep-agent'
import { EdgeTTS } from 'edge-tts-universal'
import { put } from '@vercel/blob'

const VOICE = 'en-US-AriaNeural'
const BATCH_SIZE = 3 // chapters processed per invocation (cleaning + TTS) — small enough to fit in 60s

/** Split very long chapter text into sub-segments aligned on paragraph
 *  boundaries for TTS. Edge TTS handles fairly long input, but very large
 *  chapters (10K+ chars) can fail or time out. We split at 5000 chars,
 *  generate each segment, and concatenate the audio Blobs into one MP3. */
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

/** Generate TTS audio for a single chapter's cleanedText using Edge TTS.
 *  Splits into sub-segments if needed, concatenates into one MP3 Blob.
 *  Returns { audioBlob, durationSeconds }. */
async function generateChapterAudio(cleanedText: string): Promise<{ audioBlob: Blob; durationSeconds: number }> {
  const segments = splitForTts(cleanedText)
  const audioBuffers: Blob[] = []
  let totalDurationHundredsOfNs = 0

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    try {
      const tts = new EdgeTTS(segment, VOICE)
      const result = await tts.synthesize()
      audioBuffers.push(result.audio)

      // Accumulate real duration from word-boundary timing
      if (result.subtitle && result.subtitle.length > 0) {
        const lastWord = result.subtitle[result.subtitle.length - 1]
        const segmentDuration = (lastWord.offset ?? 0) + (lastWord.duration ?? 0)
        totalDurationHundredsOfNs += segmentDuration
      }
    } catch (ttsErr) {
      console.error(`[audiobook.prep-batch] EdgeTTS failed for segment ${i + 1}/${segments.length}:`, ttsErr instanceof Error ? ttsErr.message : String(ttsErr))
      throw new Error(`EdgeTTS synthesis failed: ${ttsErr instanceof Error ? ttsErr.message : String(ttsErr)}`)
    }
  }

  const audioBlob = new Blob(audioBuffers, { type: 'audio/mpeg' })
  const durationSeconds = totalDurationHundredsOfNs > 0
    ? Math.round(totalDurationHundredsOfNs / 10_000_000)
    : Math.round((cleanedText.split(/\s+/).length / 155) * 60) // fallback: word count estimate

  return { audioBlob, durationSeconds }
}

/** Upload audio to Vercel Blob. Falls back to a data URL if Blob isn't configured. */
async function uploadChapterAudio(audiobookId: string, chapterOrder: number, audioBlob: Blob): Promise<string> {
  // Check if Vercel Blob is configured
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[audiobook.prep-batch] BLOB_READ_WRITE_TOKEN not set — storing audio as data URL (not recommended for production)')
    // Fall back to data URL — works but bloats the DB. Better than failing entirely.
    const arrayBuffer = await audioBlob.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    return `data:audio/mpeg;base64,${base64}`
  }

  const blob = await put(
    `audiobooks/${audiobookId}/chapter-${chapterOrder}.mp3`,
    audioBlob,
    { access: 'public', contentType: 'audio/mpeg' }
  )
  return blob.url
}

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
        chapters: {
          orderBy: { chapterOrder: 'asc' },
          select: { id: true, chapterOrder: true, title: true, rawText: true, cleanedText: true, status: true, audioUrl: true },
        },
      },
    })

    if (!audiobook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Already completed — idempotent
    if (audiobook.status === 'COMPLETED') {
      return NextResponse.json({ done: true, status: 'COMPLETED', progress: audiobook.chapters.length, total: audiobook.chapters.length })
    }
    if (audiobook.status === 'FAILED') {
      return NextResponse.json({ done: true, status: 'FAILED' })
    }

    // No chapters — can't proceed
    if (audiobook.chapters.length === 0) {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'FAILED' } })
      return NextResponse.json({ done: true, status: 'FAILED', error: 'No chapters' })
    }

    // Set status to GENERATING if still PENDING
    if (audiobook.status === 'PENDING') {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'GENERATING' } })
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
          const cleaned = await cleanChapterText(chapter.rawText)
          await db.audiobookChapter.update({
            where: { id: chapter.id },
            data: { cleanedText: cleaned },
          })
          chapter.cleanedText = cleaned
          processed++

          // If we've hit the batch limit, return — cleaning is the expensive part
          if (processed >= BATCH_SIZE) break
        }

        // Step 2: Generate TTS audio if cleaned but not yet generated.
        // Skip chapters with status 'generating' (another request is working on them)
        // and status 'failed' (already failed, don't retry).
        if (chapter.cleanedText && !chapter.audioUrl && chapter.status !== 'generating' && chapter.status !== 'failed') {
          console.log(`[audiobook.prep-batch] ${audiobook.id}: generating TTS for chapter ${chapter.chapterOrder + 1}/${total}`)
          await db.audiobookChapter.update({ where: { id: chapter.id }, data: { status: 'generating' } })

          try {
            const { audioBlob, durationSeconds } = await generateChapterAudio(chapter.cleanedText)
            const audioUrl = await uploadChapterAudio(audiobook.id, chapter.chapterOrder, audioBlob)

            await db.audiobookChapter.update({
              where: { id: chapter.id },
              data: {
                status: 'ready',
                audioUrl,
                durationSeconds,
              },
            })

            console.log(`[audiobook.prep-batch] ${audiobook.id}: chapter ${chapter.chapterOrder + 1} ready (${durationSeconds}s)`)
            processed++
          } catch (genErr) {
            console.error(`[audiobook.prep-batch] ${audiobook.id}: TTS/upload failed for chapter ${chapter.chapterOrder + 1}:`, genErr instanceof Error ? genErr.message : String(genErr))
            await db.audiobookChapter.update({ where: { id: chapter.id }, data: { status: 'failed' } })
            // Continue to next chapter — one failure shouldn't block the whole book
            processed++
          }
        }
      } catch (e) {
        console.error(`[audiobook.prep-batch] ${audiobook.id}: processing failed for chapter ${chapter.chapterOrder + 1}:`, e)
        processed++
      }
    }

    // Check if all chapters now have audioUrl
    const refreshedChapters = await db.audiobookChapter.findMany({
      where: { audiobookId: audiobook.id },
      select: { audioUrl: true, status: true },
    })

    const readyCount = refreshedChapters.filter(c => c.audioUrl).length
    const allReady = readyCount === total

    if (allReady) {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'COMPLETED' } })
      console.log(`[audiobook.prep-batch] ${audiobook.id}: COMPLETED (${readyCount}/${total} chapters)`)
      return NextResponse.json({ done: true, status: 'COMPLETED', progress: readyCount, total })
    }

    // Check if all chapters failed (no point continuing)
    const allFailed = refreshedChapters.every(c => c.status === 'failed')
    if (allFailed) {
      await db.audiobook.update({ where: { id: audiobook.id }, data: { status: 'FAILED' } })
      return NextResponse.json({ done: true, status: 'FAILED', progress: 0, total })
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
