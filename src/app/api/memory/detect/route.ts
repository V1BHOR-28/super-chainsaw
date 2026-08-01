import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateWithFallback, callGeminiForExtraction } from '@/lib/llm-fallback'

/**
 * POST /api/memory/detect
 * Body: { userMessage: string, ariaReply: string }
 *
 * Uses free LLM providers (no OpenRouter credits) to extract memory candidates.
 *
 * Detection pipeline (in order):
 *   1. Deterministic pattern-match fallback (extractObviousCandidates) —
 *      catches common preference phrasings WITHOUT depending on any LLM call.
 *   2. Groq 70B (llama-3.3-70b-versatile) via generateWithFallback — larger
 *      model, more precise named-entity extraction than the 8B default.
 *   3. Gemini 2.0 Flash via callGeminiForExtraction — enforced JSON output
 *      (responseMimeType: application/json), distinct second opinion.
 *   4. Regex fallback parse of whichever LLM responded (safety net for Groq,
 *      which doesn't enforce JSON).
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
  // Preference phrasings — near-unambiguous, low false-positive risk
  { regex: /\b(?:always had|always have) a soft spot for ([^.!?]{2,60})/i, category: 'preference' },
  { regex: /\bi'?m a (?:big|huge|massive) fan of ([^.!?]{2,60})/i, category: 'preference' },
  { regex: /\bi'?m (?:really |quite |very )?into ([^.!?]{2,60})/i, category: 'preference' },
  { regex: /\bi (?:really |absolutely )?love ([^.!?]{2,60})/i, category: 'preference' },
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

/** Word-overlap ratio between two strings (0-1). Duplicated from memory/route.ts
 *  (not exported there) to avoid cross-file coupling — same exact logic. */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean))
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let shared = 0
  for (const w of wordsA) if (wordsB.has(w)) shared++
  return shared / Math.min(wordsA.size, wordsB.size)
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
- CRITICAL: if the user names a specific movie, book, artist, band, place, or person, your candidate text MUST include that exact name. NEVER generalize it into a category or theme.
  BAD: "sci-fi interests" — GOOD: "Likes the movie Blade Runner"
  BAD: "appreciation for atmospheric storytelling" — GOOD: "Enjoys atmospheric, slow-paced films like Blade Runner"
  If the user's statement doesn't actually name anything specific, it's fine to generalize — only avoid generalizing when a specific name was given and got lost.

Respond with ONLY JSON: {"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

    let raw = ''
    try {
      // Tier 1: Groq 70B (larger model for precise named-entity extraction).
      // generateWithFallback runs Groq + Pollinations in parallel; passing
      // the 70B model only affects the Groq leg, not Pollinations.
      raw = await generateWithFallback(prompt, { model: 'llama-3.3-70b-versatile' }) ?? ''
    } catch (e) {
      console.error(`[memory.detect] generateWithFallback threw: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Tier 2: Gemini 2.0 Flash with enforced JSON output — distinct second
    // opinion, NOT bundled into generateWithFallback's Promise.any. Only
    // runs if Groq + Pollinations both failed (raw is empty).
    if (!raw) {
      console.log(`[memory.detect] Groq tier empty — trying Gemini extraction tier.`)
      try {
        raw = await callGeminiForExtraction(prompt) ?? ''
      } catch (e) {
        console.error(`[memory.detect] callGeminiForExtraction threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (!raw) {
      // Both Groq and Gemini failed — llm-fallback.ts already logged the
      // per-provider reasons. Return the deterministic floor (re-derived
      // fresh so it doesn't depend on any earlier variable state), filtered
      // against recently-declined candidates so we don't re-ask.
      console.error(`[memory.detect] Both Groq and Gemini extraction failed — using deterministic patterns only. Message: "${userMessage.slice(0, 80)}"`)
      const declinedTexts = decisions.filter((d) => !d.accepted).map((d) => d.candidateText)
      const isRecentlyDeclined = (candidateText: string): boolean =>
        declinedTexts.some((declined) => wordOverlap(declined, candidateText) > 0.6)
      const floorCandidates = extractObviousCandidates(userMessage).filter((c) => !isRecentlyDeclined(c.text))
      if (floorCandidates.length > 0) {
        console.log(`[memory.detect] Returning ${floorCandidates.length} obvious candidate(s) despite LLM failure.`)
      }
      return NextResponse.json({ candidates: floorCandidates.slice(0, 2) })
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

    // Hard-filter against recently-declined candidates. The in-context hint
    // in the prompt (past decisions list) is a suggestion the model can ignore;
    // this is an enforced filter so "Not now" is actually respected for the
    // near term. Scoped to the last 8 decisions (the existing query limit) —
    // not a permanent block-list, so a fact declined once out of context can
    // still be saved later via the Memory panel's Add box if you change your mind.
    const declinedTexts = decisions.filter((d) => !d.accepted).map((d) => d.candidateText)
    const isRecentlyDeclined = (candidateText: string): boolean =>
      declinedTexts.some((declined) => wordOverlap(declined, candidateText) > 0.6)

    const candidates = merged.filter((c) => !isRecentlyDeclined(c.text)).slice(0, 2)

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
