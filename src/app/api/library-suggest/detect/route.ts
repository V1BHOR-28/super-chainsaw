import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'
import { checkArchiveOrgAvailability } from '@/lib/archive-org'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/library-suggest/detect
 * Body: { ariaReply: string, usedLibrary: boolean }
 *
 * Only worth calling when usedLibrary is false (client should check the
 * assistant message's toolUsed !== 'library' before calling this at all —
 * this route doesn't re-derive that, the caller owns that decision).
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const ariaReply = (body.ariaReply as string) ?? ''
    if (ariaReply.length < 20) return NextResponse.json({ suggestion: null })

    // Cheap prefilter before spending an LLM call — most replies won't mention a book at all.
    const looksBookish = /\bby [A-Z][a-z]+ [A-Z][a-z]+/.test(ariaReply) || /"[A-Z][^"]{3,60}"/.test(ariaReply)
    if (!looksBookish) return NextResponse.json({ suggestion: null })

    const prompt = `Read this reply from an AI companion. Did it mention ONE specific real book by title and author (not a vague genre or theme)? This reply was NOT drawing from the user's fed library — if a book is mentioned, it came from the AI's own training knowledge.

REPLY: "${ariaReply.slice(0, 1500)}"

Respond with ONLY JSON: {"book": {"title": "...", "author": "..."} } or {"book": null} if no specific book was named.`

    const raw = await generateWithFallback(prompt)
    if (!raw) return NextResponse.json({ suggestion: null })

    let parsed: { book: { title: string; author: string } | null } = { book: null }
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0])
    } catch {
      return NextResponse.json({ suggestion: null })
    }
    if (!parsed.book) return NextResponse.json({ suggestion: null })

    const { title, author } = parsed.book

    // Don't re-suggest a book the user already has an interest-memory for,
    // or that's already in the Knowledge Base — reuse existing rows to check.
    const [existingMemory, existingKnowledge] = await Promise.all([
      db.memory.findFirst({ where: { userId, category: 'reading-list', content: { contains: title, mode: 'insensitive' } } }),
      db.knowledge.findFirst({ where: { userId, title: { contains: title, mode: 'insensitive' } } }),
    ])
    if (existingMemory || existingKnowledge) return NextResponse.json({ suggestion: null })

    const archiveResult = await checkArchiveOrgAvailability(title, author)

    return NextResponse.json({
      suggestion: {
        title,
        author,
        canAddFullText: archiveResult.available,
        sourceUrl: archiveResult.downloadUrl ?? null,
      },
    })
  } catch (err) {
    console.error('[library-suggest.detect]', err)
    return NextResponse.json({ suggestion: null })
  }
}
