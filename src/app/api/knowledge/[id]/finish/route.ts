import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'

/**
 * POST /api/knowledge/[id]/finish — mark all chunks of a document as finished,
 * then best-effort: ARIA writes a closing reflection as a journal memory entry.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: documentId } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const chunks = await db.knowledge.findMany({ where: { userId, documentId }, select: { id: true, title: true } })
    if (chunks.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const bookTitle = chunks[0].title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')
    const now = new Date()
    await db.knowledge.updateMany({ where: { userId, documentId }, data: { finishedAt: now } })

    // Best-effort: ARIA writes a closing reflection
    try {
      const existingJournal = await db.memory.findFirst({
        where: { userId, category: 'journal', content: { contains: bookTitle } },
      })
      const prompt = `You are ARIA, an AI reading companion. The user just finished reading "${bookTitle}". ${existingJournal ? `Your past reflections on it: ${existingJournal.content.slice(0, 500)}` : "You haven't discussed this book much yet."} Write a short (2-4 sentence), warm, first-person closing reflection — like a friend processing finishing a book together, not a book report. No headers, plain prose.`
      const reflection = await generateWithFallback(prompt)
      if (reflection) {
        const closingEntry = `Finished "${bookTitle}". ${reflection.trim()}`
        if (existingJournal) {
          await db.memory.update({
            where: { id: existingJournal.id },
            data: { content: `${existingJournal.content}\n\n${closingEntry}`.slice(0, 1000) },
          })
        } else {
          await db.memory.create({ data: { userId, content: closingEntry.slice(0, 500), category: 'journal' } })
        }
      }
    } catch (e) {
      console.error('[knowledge.finish.journal]', e)
    }

    return NextResponse.json({ ok: true, finishedAt: now.toISOString(), bookTitle })
  } catch (err) {
    console.error('[knowledge.finish]', err)
    return NextResponse.json({ error: 'Failed to mark as finished' }, { status: 500 })
  }
}
