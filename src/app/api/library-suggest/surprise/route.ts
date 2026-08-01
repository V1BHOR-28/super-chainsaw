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
 * Retries up to 3 times server-side before giving up — much better hit rate
 * than a single attempt that the user has to manually retry.
 */
export async function POST() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [existingBooks, memories] = await Promise.all([
      db.knowledge.findMany({ where: { userId }, distinct: ['documentId'], select: { title: true }, take: 20 }),
      db.memory.findMany({ where: { userId, category: 'reading-list' }, select: { content: true }, take: 10 }),
    ])

    const alreadySuggested: string[] = []

    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = `Suggest ONE well-known public-domain classic (published before 1929, so it's on Project Gutenberg) that this reader would probably enjoy, based on what they've already engaged with. Favor WIDELY-KNOWN, commonly-anthologized classics (Austen, Dickens, Twain, Tolstoy, Dostoevsky, Melville, Brontë, etc. in their standard English titles) over obscure picks — the goal is a book that's near-certain to be on Project Gutenberg under its standard title, not an obscure or hard-to-match one.${alreadySuggested.length ? `\n\nAlready tried and NOT available, don't suggest these again: ${alreadySuggested.join(', ')}` : ''}

Already read/fed: ${existingBooks.map(b => b.title).join(', ') || 'nothing yet'}
Interested in: ${memories.map(m => m.content).join('; ') || 'unknown'}

Respond with ONLY JSON: {"title": "...", "author": "...", "why": "one sentence, casual, said like a friend recommending it — not a book-jacket blurb"}`

      const raw = await generateWithFallback(prompt)
      if (!raw) continue

      let parsed: { title?: string; author?: string; why?: string } = {}
      try {
        const match = raw.match(/\{[\s\S]*\}/)
        if (match) parsed = JSON.parse(match[0])
      } catch {
        continue
      }
      if (!parsed.title || !parsed.author) {
        console.log(`[surprise] attempt ${attempt}: LLM response did not parse to a valid title/author. Raw: ${raw?.slice(0, 200)}`)
        continue
      }

      const gutenberg = await checkGutenbergAvailability(parsed.title, parsed.author)
      if (gutenberg.available) {
        return NextResponse.json({
          suggestion: {
            title: gutenberg.matchedTitle ?? parsed.title,
            author: parsed.author,
            why: parsed.why ?? '',
            gutenbergUrl: gutenberg.downloadUrl,
          },
        })
      }
      alreadySuggested.push(`"${parsed.title}" by ${parsed.author}`)
    }

    // All 3 attempts failed to find an available match
    return NextResponse.json({ suggestion: null, retry: true })
  } catch (err) {
    console.error('[library-suggest.surprise]', err)
    return NextResponse.json({ suggestion: null })
  }
}
