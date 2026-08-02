import { NextResponse } from 'next/server'
import { getAuthenticatedUserId } from '@/lib/user'
import { isCurrentUserAdmin } from '@/lib/usage'
import { db } from '@/lib/db'
import { deriveChapters } from '@/lib/audiobook-chapters'
import { cleanForNarration } from '@/lib/narration-clean'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/admin/backfill-audiobooks — one-time admin-gated backfill.
 *
 * Creates Audiobook + AudiobookChapter rows for existing Knowledge documents
 * that were fed before the audiobook feature's DB migration landed. Safe to
 * delete this file after running once.
 */
export async function POST() {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isCurrentUserAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Find every distinct documentId in Knowledge, grouped by documentId/userId/title.
  // We group by title too so we can use the first chunk's title as the book title.
  const allDocs = await db.knowledge.groupBy({
    by: ['documentId', 'userId', 'title'],
    _count: { _all: true },
  })

  // Filter out documents that already have an Audiobook row
  const existingAudiobookDocIds = new Set(
    (await db.audiobook.findMany({ select: { documentId: true } })).map(a => a.documentId)
  )

  // Also filter out null documentIds (legacy rows without one)
  const docsToProcess = allDocs.filter(d => d.documentId && !existingAudiobookDocIds.has(d.documentId))

  const results: { documentId: string; title: string; status: string }[] = []

  for (const doc of docsToProcess) {
    // Reassemble the full text for this document from its chunks, in order.
    // Chunks were inserted with titles like "Book Title — Part N/M" which sort
    // correctly, so we order by title to get them in the right sequence.
    const chunks = await db.knowledge.findMany({
      where: { documentId: doc.documentId, source: { not: 'summary' } },
      orderBy: { title: 'asc' },
      select: { content: true },
    })
    const fullText = chunks.map(c => c.content).join('\n\n')

    if (fullText.length <= 8000) {
      results.push({ documentId: doc.documentId!, title: doc.title, status: 'skipped (too short)' })
      continue
    }

    try {
      // Strip the " — Part N/M" suffix that per-chunk titles have
      const bookTitle = doc.title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')

      const audiobook = await db.audiobook.create({
        data: { userId: doc.userId, documentId: doc.documentId!, title: bookTitle, author: null },
      })
      const derivedChapters = deriveChapters(fullText)
      await db.audiobookChapter.createMany({
        data: derivedChapters.map((ch) => ({
          audiobookId: audiobook.id,
          chapterIndex: ch.index,
          title: ch.title,
          cleanedText: cleanForNarration(ch.text),
          status: 'pending',
        })),
      })
      results.push({ documentId: doc.documentId!, title: bookTitle, status: `created (${derivedChapters.length} chapters)` })
    } catch (e) {
      console.error('[backfill-audiobooks]', doc.documentId, e)
      results.push({ documentId: doc.documentId!, title: doc.title, status: `failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return NextResponse.json({
    processed: results.length,
    skipped: allDocs.length - docsToProcess.length,
    results,
  })
}
