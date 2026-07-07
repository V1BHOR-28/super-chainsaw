import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { getZAI } from '@/lib/aria'

/**
 * POST /api/memory/detect
 * Body: { userMessage: string, ariaReply: string }
 *
 * Runs a lightweight LLM call to extract 0-2 memory candidates from the
 * exchange, using the user's past 8 memory decisions as in-context examples
 * so the model learns THIS user's saving pattern over time.
 *
 * Returns: { candidates: [{ text, category, confidence }] }
 *   confidence: "high" (auto-save) | "medium" (ask the user) | omitted (skip)
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const userMessage = (body.userMessage as string)?.trim()
    const ariaReply = (body.ariaReply as string)?.trim()

    if (!userMessage || !ariaReply) {
      return NextResponse.json({ error: 'userMessage and ariaReply required' }, { status: 400 })
    }

    // Skip detection for tiny messages (small talk) to save API calls
    if (userMessage.length < 30) {
      return NextResponse.json({ candidates: [] })
    }

    // Load past decisions for in-context learning
    const decisions = await db.memoryDecision.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    })

    // Load existing memories so we can dedup against them
    const existingMemories = await db.memory.findMany({
      where: { userId },
      select: { content: true },
      take: 30,
    })

    const examplesBlock =
      decisions.length > 0
        ? `\n\nTHE USER'S PAST MEMORY DECISIONS (most recent first — learn their pattern):\n${decisions
            .map(
              (d) =>
                `- ${d.accepted ? 'SAVED' : 'SKIPPED'}: "${d.candidateText}" (${d.category})`
            )
            .join('\n')}\n`
        : '\n\n(No past decisions yet — this is a new user. Be conservative: lean toward "medium" so they can decide.)\n'

    const existingBlock =
      existingMemories.length > 0
        ? `\n\nEXISTING MEMORIES (do not propose duplicates of these):\n${existingMemories
            .map((m) => `- "${m.content}"`)
            .join('\n')}\n`
        : ''

    const zai = await getZAI()

    const prompt = `You are ARIA's memory curator. Your job: read the exchange below and extract 0-2 memory candidates — things worth remembering permanently about the user.

USER SAID: "${userMessage.slice(0, 800)}"
ARIA REPLIED: "${ariaReply.slice(0, 800)}"${examplesBlock}${existingBlock}

RULES:
- SAVE candidates: permanent facts, stable preferences, identities, goals, relationships, roles, allergies, phobias
- SKIP candidates: transient states, temporary emotions, small talk, opinions about today, ARIA's own words
- If a candidate is a clear, unambiguous fact (e.g., "I'm allergic to peanuts", "I work at Stripe as a designer") → confidence "high"
- If borderline or personal (e.g., "I've been thinking about quitting", "I'm struggling with my marriage") → confidence "medium"
- If clearly not worth saving → don't include it
- NEVER propose a duplicate of an existing memory
- Each candidate text should be a concise statement in third person about the user (e.g., "Allergic to peanuts", "Works as a designer at Stripe", "Prefers direct feedback over sugar-coating")

Respond with ONLY valid JSON, no markdown fences:
{"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

    const completion = await zai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      thinking: { type: 'disabled' },
    })

    const raw = completion.choices?.[0]?.message?.content ?? ''

    // Parse JSON robustly — the model may wrap in fences or add prose
    let parsed: { candidates?: Array<{ text: string; category: string; confidence: string }> } = { candidates: [] }
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      }
    } catch {
      // If parsing fails, return no candidates
    }

    const candidates = (parsed.candidates || [])
      .filter(
        (c) =>
          c.text &&
          c.text.length > 3 &&
          c.text.length < 300 &&
          ['high', 'medium'].includes(c.confidence)
      )
      // Never auto-save "personal" category — always ask
      .map((c) =>
        c.category === 'personal' && c.confidence === 'high'
          ? { ...c, confidence: 'medium' as const }
          : c
      )
      .slice(0, 2)

    return NextResponse.json({ candidates })
  } catch (err) {
    console.error('[memory.detect]', err)
    return NextResponse.json({ candidates: [] })
  }
}
