import { NextResponse } from 'next/server'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'
import { checkGutenbergAvailability } from '@/lib/gutenberg'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/library-suggest/surprise — user-initiated "Surprise me" book suggestion.
 * Uses the user's existing library + reading-list memories as context, suggests a
 * public-domain classic, confirms it's on Gutenberg before returning.
 * Reuses checkGutenbergAvailability from the existing library-suggest feature.
 */
export async function POST() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Pull context so the suggestion isn't random noise
    const [existingBooks, memories] = await Promise.all([
      db.knowledge.findMany({ where: { userId }, distinct: ['documentId'], select: { title: true }, take: 20 }),
      db.memory.findMany({ where: { userId, category: 'reading-list' }, select: { content: true }, take: 10 }),
    ])

    const prompt = `Suggest ONE well-known public-domain classic (published before 1929, so it's likely on Project Gutenberg) that this reader would probably enjoy, based on what they've already engaged with. If they have no history yet, suggest a widely-loved, accessible classic — not an obscure or difficult one; the goal is a good first public-domain read, not showing off.

Already read/fed: ${existingBooks.map(b => b.title).join(', ') || 'nothing yet'}
Interested in: ${memories.map(m => m.content).join('; ') || 'unknown'}

Respond with ONLY JSON: {"title": "...", "author": "...", "why": "one sentence, casual, said like a friend recommending it — not a book-jacket blurb"}`

    const raw = await generateWithFallback(prompt)
    if (!raw) return NextResponse.json({ suggestion: null })

    let parsed: { title?: string; author?: string; why?: string } = {}
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0])
    } catch {
      return NextResponse.json({ suggestion: null })
    }
    if (!parsed.title || !parsed.author) return NextResponse.json({ suggestion: null })

    const gutenberg = await checkGutenbergAvailability(parsed.title, parsed.author)
    if (!gutenberg.available) {
      return NextResponse.json({ suggestion: null, retry: true })
    }

    return NextResponse.json({
      suggestion: {
        title: gutenberg.matchedTitle ?? parsed.title,
        author: parsed.author,
        why: parsed.why ?? '',
        gutenbergUrl: gutenberg.downloadUrl,
      },
    })
  } catch (err) {
    console.error('[library-suggest.surprise]', err)
    return NextResponse.json({ suggestion: null })
  }
}
