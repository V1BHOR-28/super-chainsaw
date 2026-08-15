import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'
import { checkArchiveOrgAvailability } from '@/lib/archive-org'
import { db } from '@/lib/db'
import { CURATED_CLASSICS } from '@/lib/archive-org-classics'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/library-suggest/surprise — user-initiated "Surprise me" book suggestion.
 *
 * The LLM suggests ANY real book from its own knowledge (not a fixed list), then we
 * verify it's actually available on Internet Archive live. If verification fails, we
 * retry with a different suggestion (up to 3 attempts total). If all attempts fail,
 * we fall back to the curated list of pre-verified classics — this route never
 * dead-ends the user with a null suggestion.
 *
 * The curated list is a last-resort safety net, not the suggestion pool.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const excludeTitles: string[] = (body.excludeTitles as string[]) || []

    const [existingBooks, memories] = await Promise.all([
      db.knowledge.findMany({ where: { userId }, distinct: ['documentId'], select: { title: true }, take: 20 }),
      db.memory.findMany({ where: { userId, category: 'reading-list' }, select: { content: true }, take: 10 }),
    ])

    const alreadyFedTitles = new Set(existingBooks.map(b => b.title.toLowerCase()))
    const excludeSet = new Set(excludeTitles.map(t => t.toLowerCase()))

    const startTime = Date.now()
    const failedTitles: string[] = []

    // === LIVE SUGGESTION + VERIFICATION (up to 3 attempts) ===
    for (let attempt = 0; attempt < 3; attempt++) {
      // Elapsed-time guard: don't start a 3rd attempt if we're already past 20s
      if (Date.now() - startTime > 20000) break

      const prompt = `You're a well-read friend recommending ONE specific real book to this reader — not from a fixed list, from your own knowledge of literature. Prioritize public-domain works (originally published before 1929) since those are the ones we can source full text for, but a great match matters more than a technicality — if you genuinely believe something published after 1929 fits far better, suggest it anyway, and we'll offer it as an interest even if we can't source the full text.

Already read/fed: ${existingBooks.map(b => b.title).join(', ') || 'nothing yet'}
Interested in: ${memories.map(m => m.content).join('; ') || 'unknown — pick something widely loved and accessible'}
Already suggested this session, don't repeat: ${excludeTitles.length ? excludeTitles.join(', ') : 'none'}
${failedTitles.length ? `Not available on Archive.org, don't suggest again: ${failedTitles.join(', ')}` : ''}

Respond with ONLY JSON: {"title": "...", "author": "...", "why": "one sentence, casual, said like a friend recommending it — not a book-jacket blurb"}`

      const raw = await generateWithFallback(prompt, { model: 'openai/gpt-oss-120b' })
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

      const title = parsed.title
      const author = parsed.author

      // Skip if this was already suggested/excluded this session
      if (excludeSet.has(title.toLowerCase()) || alreadyFedTitles.has(title.toLowerCase())) continue

      // Check Archive.org availability
      const archiveResult = await checkArchiveOrgAvailability(title, author)
      if (archiveResult.available) {
        console.log(`[surprise] "${title}" by ${author} → matched Archive.org item "${archiveResult.matchedTitle}"`)
        return NextResponse.json({
          suggestion: {
            title,
            author,
            why: parsed.why ?? 'Been meaning to suggest this one.',
            canAddFullText: true,
            sourceUrl: archiveResult.downloadUrl!,
          },
        })
      }

      // Not available — record and retry
      failedTitles.push(`"${title}" by ${author}`)
    }

    // === FALLBACK: curated list (last resort) ===
    console.log(`[library-suggest.surprise] fell back to curated list after ${failedTitles.length} failed live attempts`)

    const candidates = CURATED_CLASSICS.filter(c =>
      !alreadyFedTitles.has(c.title.toLowerCase()) &&
      !excludeSet.has(c.title.toLowerCase())
    )

    if (candidates.length === 0) {
      // Extremely rare: user has been fed every curated classic AND every live suggestion failed
      return NextResponse.json({ suggestion: null })
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)]
    return NextResponse.json({
      suggestion: {
        title: picked.title,
        author: picked.author,
        why: 'A classic worth revisiting.',
        canAddFullText: true,
        sourceUrl: picked.textUrl,
      },
    })
  } catch (err) {
    console.error('[library-suggest.surprise]', err)
    return NextResponse.json({ suggestion: null })
  }
}
