import { NextResponse } from 'next/server'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'
import { db } from '@/lib/db'
import { CURATED_CLASSICS } from '@/lib/gutenberg-classics'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/library-suggest/surprise — user-initiated "Surprise me" book suggestion.
 * Uses a curated list of pre-verified Gutenberg classics (no live Gutendex search).
 * The LLM picks from the known-good list based on the user's context; if the LLM
 * call fails entirely, a random fallback from the list is used — this route never
 * dead-ends the user with "couldn't find a match."
 */
export async function POST() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [existingBooks, memories] = await Promise.all([
      db.knowledge.findMany({ where: { userId }, distinct: ['documentId'], select: { title: true }, take: 20 }),
      db.memory.findMany({ where: { userId, category: 'reading-list' }, select: { content: true }, take: 10 }),
    ])

    const alreadyFedTitles = new Set(existingBooks.map(b => b.title.toLowerCase()))
    const candidates = CURATED_CLASSICS.filter(c => !alreadyFedTitles.has(c.title.toLowerCase()))

    if (candidates.length === 0) {
      // User has already been fed every curated classic — rare, but handle it.
      return NextResponse.json({ suggestion: null })
    }

    const prompt = `Pick ONE book from this list that best fits this reader, based on what they've engaged with. If you have no signal either way, pick a widely-loved, accessible one over a dense/difficult one.

LIST (respond with the exact title from this list, nothing else):
${candidates.map(c => `- "${c.title}" by ${c.author} [${c.tags.join(', ')}]`).join('\n')}

Already read/fed: ${existingBooks.map(b => b.title).join(', ') || 'nothing yet'}
Interested in: ${memories.map(m => m.content).join('; ') || 'unknown'}

Respond with ONLY JSON: {"title": "...", "why": "one sentence, casual, said like a friend recommending it — not a book-jacket blurb"}`

    const raw = await generateWithFallback(prompt)
    let picked = candidates[Math.floor(Math.random() * candidates.length)] // safe fallback if LLM call fails entirely
    let why = "Been meaning to suggest this one."

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/)
        if (match) {
          const parsed = JSON.parse(match[0]) as { title?: string; why?: string }
          const found = candidates.find(c => c.title.toLowerCase() === parsed.title?.toLowerCase())
          if (found) {
            picked = found
            why = parsed.why ?? why
          }
          // If the LLM's returned title doesn't exactly match a candidate,
          // we keep the random fallback picked above rather than failing —
          // this is the whole point of this rewrite: never dead-end the user.
        }
      } catch {
        // keep the random fallback
      }
    }

    return NextResponse.json({
      suggestion: {
        title: picked.title,
        author: picked.author,
        why,
        gutenbergUrl: picked.textUrl,
      },
    })
  } catch (err) {
    console.error('[library-suggest.surprise]', err)
    return NextResponse.json({ suggestion: null })
  }
}
