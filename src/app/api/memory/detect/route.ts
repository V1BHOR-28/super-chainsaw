import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback } from '@/lib/llm-fallback'

/**
 * POST /api/memory/detect
 * Body: { userMessage: string, ariaReply: string }
 *
 * Uses the shared free LLM helper (src/lib/llm-fallback.ts — Groq +
 * Pollinations, both free) to extract memory candidates. Does NOT depend
 * on OpenRouter credits.
 *
 * Detection pipeline (in order):
 *   1. Deterministic pattern-match fallback (extractObviousCandidates) —
 *      catches "my favorite X is Y", "I work at X", etc. WITHOUT depending
 *      on an LLM call succeeding. These are the most common, clearest cases.
 *   2. Free LLM call via generateWithFallback (Groq 8B primary, Pollinations
 *      keyless backstop) — handles nuanced phrasings the patterns can't catch.
 *   3. Regex fallback parse of the LLM response (safety net — the free
 *      providers don't support response_format: json_object, so we still
 *      regex-extract {...} out of free-form text).
 *
 * Every exit point logs a distinguishable line so failures aren't silent.
 * The deterministic floor (extractObviousCandidates) is returned on every
 * LLM failure path, so a fully-down LLM still catches the obvious phrasings.
 */

const OBVIOUS_PATTERNS: Array<{ regex: RegExp; category: string }> = [
  { regex: /\bmy favou?rite (movie|book|band|song|food|color|colour|show|game) is ([^.!?]{2,60})/i, category: 'preference' },
  { regex: /\bi work at ([^.!?]{2,60})/i, category: 'personal' },
  { regex: /\bi live in ([^.!?]{2,60})/i, category: 'personal' },
  { regex: /\bmy name is ([^.!?]{2,60})/i, category: 'personal' },
]

export function extractObviousCandidates(userMessage: string): Array<{ text: string; category: string; confidence: string }> {
  const found: Array<{ text: string; category: string; confidence: string }> = []
  for (const { regex, category } of OBVIOUS_PATTERNS) {
    const match = userMessage.match(regex)
    if (match) {
      found.push({ text: match[0].trim(), category, confidence: 'high' })
    }
  }
  return found
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const userMessage = (body.userMessage as string)?.trim()
    const ariaReply = (body.ariaReply as string)?.trim()

    if (!userMessage || !ariaReply) {
      return NextResponse.json({ candidates: [] })
    }

    // Skip detection for tiny messages
    if (userMessage.length < 12) {
      return NextResponse.json({ candidates: [] })
    }

    // === DETERMINISTIC FALLBACK ===
    // Catch the obvious, extremely-common personal-preference patterns that
    // shouldn't ever depend on an LLM call succeeding. "my favorite movie is
    // Vanilla Sky" is the canonical case this exists for.
    const obviousCandidates = extractObviousCandidates(userMessage)

    // Load past decisions for in-context learning
    const decisions = await db.memoryDecision.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    })

    // Load existing memories for dedup
    const existingMemories = await db.memory.findMany({
      where: { userId },
      select: { content: true },
      take: 30,
    })

    const examplesBlock =
      decisions.length > 0
        ? `\n\nTHE USER'S PAST MEMORY DECISIONS:\n${decisions
            .map((d) => `- ${d.accepted ? 'SAVED' : 'SKIPPED'}: "${d.candidateText}" (${d.category})`)
            .join('\n')}\n`
        : '\n\n(No past decisions yet — be conservative.)\n'

    const existingBlock =
      existingMemories.length > 0
        ? `\n\nEXISTING MEMORIES (do not propose duplicates):\n${existingMemories.map((m) => `- "${m.content}"`).join('\n')}\n`
        : ''

    const prompt = `You are ARIA's memory curator. Read the exchange and extract 0-2 memory candidates.

USER SAID: "${userMessage.slice(0, 800)}"
ARIA REPLIED: "${ariaReply.slice(0, 800)}"${examplesBlock}${existingBlock}

RULES:
- SAVE: permanent facts, stable preferences, identities, goals, relationships
- SKIP: transient states, temporary emotions, small talk
- "high" = clear fact (auto-save), "medium" = borderline (ask user)
- NEVER propose duplicates

Respond with ONLY JSON: {"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

    let raw = ''
    try {
      raw = await generateWithFallback(prompt) ?? ''
      if (!raw) {
        // generateWithFallback already logged the per-provider failure reasons
        // inside llm-fallback.ts. Log the detect-route context here too, and
        // return the obvious candidates as the deterministic floor.
        console.error(`[memory.detect] llm-fallback returned empty for message: "${userMessage.slice(0, 80)}"`)
        if (obviousCandidates.length > 0) {
          console.log(`[memory.detect] Returning ${obviousCandidates.length} obvious candidate(s) despite LLM failure.`)
        }
        return NextResponse.json({ candidates: obviousCandidates.slice(0, 2) })
      }
    } catch (e) {
      console.error(`[memory.detect] llm-fallback threw: ${e instanceof Error ? e.message : String(e)}`)
      // Deterministic floor — the obvious patterns don't depend on any LLM call.
      return NextResponse.json({ candidates: extractObviousCandidates(userMessage).slice(0, 2) })
    }

    let parsed: { candidates?: Array<{ text: string; category: string; confidence: string }> } = { candidates: [] }
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        console.warn(`[memory.detect] No JSON found in model response for message: "${userMessage.slice(0, 80)}" — raw: ${raw.slice(0, 200)}`)
      }
    } catch (e) {
      console.error(`[memory.detect] JSON parse failed: ${e instanceof Error ? e.message : String(e)} — raw: ${raw.slice(0, 200)}`)
    }

    const llmCandidates = (parsed.candidates || [])
      .filter((c) => c.text && c.text.length > 3 && c.text.length < 300 && ['high', 'medium'].includes(c.confidence))

    // Merge obvious + LLM candidates, deduping by rough text similarity so the
    // same fact doesn't get proposed twice (e.g. both the pattern and the LLM
    // catch "my favorite movie is Vanilla Sky").
    const merged = [...obviousCandidates]
    for (const c of llmCandidates) {
      const isDupe = merged.some((m) => m.text.toLowerCase().includes(c.text.toLowerCase().slice(0, 15)))
      if (!isDupe) merged.push(c)
    }

    const candidates = merged.slice(0, 2)

    if (candidates.length === 0) {
      console.log(`[memory.detect] Zero candidates for message: "${userMessage.slice(0, 80)}"`)
    } else {
      console.log(`[memory.detect] ${candidates.length} candidate(s) for message: "${userMessage.slice(0, 80)}" — ${candidates.map((c) => `[${c.category}/${c.confidence}] "${c.text.slice(0, 40)}"`).join(', ')}`)
    }

    return NextResponse.json({ candidates })
  } catch (err) {
    console.error('[memory.detect] Unhandled error:', err)
    return NextResponse.json({ candidates: [] })
  }
}
