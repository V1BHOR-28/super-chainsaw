import { NextResponse } from 'next/server'
import { generateWithFallback } from '@/lib/llm-fallback'
import { extractObviousCandidates } from '@/app/api/memory/detect/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Temporary diagnostic: verifies the detect route's LLM path now uses the
// free llm-fallback helper (Groq + Pollinations) instead of OpenRouter.
// Case 1: deterministic pattern (no LLM needed) — "my favorite band is Radiohead"
// Case 2: LLM path (free providers) — "I've always had a soft spot for Blade Runner"
// Will be removed after verification.
export async function GET() {
  const results: Array<{
    label: string
    userMessage: string
    obviousCandidates?: unknown
    llmRaw?: string | null
    llmParsed?: unknown
    llmStatus?: string
  }> = []

  // === Case 1: deterministic fallback (pattern match, no LLM) ===
  const case1Msg = 'my favorite band is Radiohead'
  const obvious = extractObviousCandidates(case1Msg)
  results.push({
    label: 'Case 1 — deterministic fallback (pattern match)',
    userMessage: case1Msg,
    obviousCandidates: obvious,
  })

  // === Case 2: LLM path via generateWithFallback (free providers) ===
  const case2Msg = "honestly I've always had a soft spot for Blade Runner"
  const prompt = `You are ARIA's memory curator. Read the exchange and extract 0-2 memory candidates.

USER SAID: "${case2Msg}"
ARIA REPLIED: "Blade Runner is a masterpiece of atmosphere."

RULES:
- SAVE: permanent facts, stable preferences, identities, goals, relationships
- SKIP: transient states, temporary emotions, small talk
- "high" = clear fact (auto-save), "medium" = borderline (ask user)

Respond with ONLY JSON: {"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

  const raw = await generateWithFallback(prompt)
  let parsed: { candidates?: Array<{ text: string; category: string; confidence: string }> } = { candidates: [] }
  if (raw) {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
    } catch {
      // keep empty
    }
  }
  results.push({
    label: 'Case 2 — LLM path via generateWithFallback (free Groq + Pollinations)',
    userMessage: case2Msg,
    llmRaw: raw ? raw.slice(0, 300) : null,
    llmParsed: parsed.candidates || [],
    llmStatus: raw ? 'SUCCESS — free provider responded' : 'FAILED — all free providers down (check logs for [llm-fallback] line)',
  })

  return NextResponse.json({ ok: true, results })
}
