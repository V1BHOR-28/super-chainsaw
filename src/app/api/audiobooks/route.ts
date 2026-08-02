import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { isCurrentUserAdmin } from '@/lib/usage'
import { prepareAudiobookChapters } from '@/lib/audiobook-prep-agent'

/**
 * Auto-backfill: for admin users, check if any existing Knowledge documents
 * are missing Audiobook rows and create them on the fly. This is a one-time
 * cost — once the missing audiobooks are created, subsequent requests skip
 * this entirely. Runs inline (not background) so the first reload shows the
 * books immediately rather than requiring a second reload.
 */
async function autoBackfillMissingAudiobooks(userId: string): Promise<void> {
  try {
    // Find distinct documentIds in Knowledge that don't have an Audiobook yet
    const allDocs = await db.knowledge.groupBy({
      by: ['documentId', 'userId'],
      _count: { _all: true },
    })

    const existingAudiobookDocIds = new Set(
      (await db.audiobook.findMany({ select: { documentId: true } })).map(a => a.documentId)
    )

    const docsToProcess = allDocs.filter(
      d => d.documentId && d.userId === userId && !existingAudiobookDocIds.has(d.documentId)
    )

    if (docsToProcess.length === 0) return

    console.log(`[audiobooks.autoBackfill] Found ${docsToProcess.length} documents without audiobooks`)

    for (const doc of docsToProcess) {
      const chunks = await db.knowledge.findMany({
        where: { documentId: doc.documentId, source: { not: 'summary' } },
        orderBy: { title: 'asc' },
        select: { content: true, title: true },
      })

      if (chunks.length === 0) continue

      // For backfilled docs, the Knowledge chunks are all we have (the original
      // raw text wasn't stored before this fix). Concatenate them as fullText.
      const fullText = chunks.map(c => c.content).join('\n\n')
      if (fullText.length <= 8000) continue

      const bookTitle = chunks[0].title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')

      try {
        // Create the audiobook row immediately with fullText + chaptersReady=false
        const audiobook = await db.audiobook.create({
          data: {
            userId: doc.userId,
            documentId: doc.documentId!,
            title: bookTitle,
            author: null,
            fullText,
            chaptersReady: false,
          },
        })

        // Fire-and-forget background chapter prep (same pattern as knowledge route)
        prepareAudiobookChapters(fullText)
          .then(async (prepared) => {
            if (prepared.length > 0) {
              await db.audiobookChapter.createMany({
                data: prepared.map((ch) => ({
                  audiobookId: audiobook.id,
                  chapterIndex: ch.index,
                  title: ch.title,
                  cleanedText: ch.cleanedText,
                  status: 'pending',
                })),
              })
            }
            await db.audiobook.update({ where: { id: audiobook.id }, data: { chaptersReady: true } })
            console.log(`[audiobooks.autoBackfill] Background prep complete for "${bookTitle}" (${prepared.length} chapters)`)
          })
          .catch(async (e) => {
            console.error(`[audiobooks.autoBackfill] Background prep failed for "${bookTitle}":`, e instanceof Error ? e.message : String(e))
            await db.audiobook.update({ where: { id: audiobook.id }, data: { chaptersReady: true } })
          })

        console.log(`[audiobooks.autoBackfill] Created audiobook for "${bookTitle}" (${fullText.length} chars, prep running in background)`)
      } catch (e) {
        console.error(`[audiobooks.autoBackfill] Failed for ${doc.documentId}:`, e)
      }
    }
  } catch (e) {
    console.error('[audiobooks.autoBackfill] Failed:', e)
  }
}

/**
 * GET /api/audiobooks — list the authenticated user's audiobooks, newest first.
 * Audiobooks are auto-created when book-length content is fed via /api/knowledge.
 * For admin users, also auto-backfills any existing Knowledge documents that
 * were fed before the audiobook feature existed.
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Auto-backfill for admin users (one-time, skips if already done)
    if (await isCurrentUserAdmin()) {
      await autoBackfillMissingAudiobooks(userId)
    }

    const audiobooks = await db.audiobook.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        author: true,
        accent: true,
        documentId: true,
        createdAt: true,
        progressChapter: true,
        progressCharOffset: true,
        chaptersReady: true,
        chapters: {
          select: { status: true },
        },
      },
    })

    // Compute narrated chapter counts for each audiobook
    const audiobooksWithCounts = audiobooks.map(a => {
      const total = a.chapters.length
      const narrated = a.chapters.filter(c => c.status === 'ready').length
      // Strip the full chapters array — just return counts
      const { chapters: _chapters, ...rest } = a
      return { ...rest, chapterCount: total, narratedCount: narrated }
    })

    return NextResponse.json({ audiobooks: audiobooksWithCounts })
  } catch (err) {
    console.error('[audiobooks.list]', err)
    return NextResponse.json({ error: 'Failed to load audiobooks' }, { status: 500 })
  }
}
