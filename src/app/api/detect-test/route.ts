import { NextResponse } from 'next/server'
import { generateWithFallback, callGeminiForExtraction } from '@/lib/llm-fallback'
import { extractObviousCandidates } from '@/app/api/memory/detect/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Temporary diagnostic: verifies the detection quality fixes on Vercel production.
// Case 1: "honestly I've always had a soft spot for Blade Runner" — now matches the
//         new "soft spot for" deterministic pattern (Fix 4). Should save instantly
//         without any LLM call, and the text should say "Blade Runner".
// Case 2: "the new Denis Villeneuve movie really stuck with me, I think I need to
//         rewatch it" — can't be pattern-matched, must go through the LLM path
//         (Fix 1: Groq 70B, Fix 2: Gemini tier, Fix 3: specificity rule).
//         Does it name Villeneuve specifically, or is it still vague?
// Will be removed after verification.
export async function GET() {
  const results: Array<{
    label: string
    userMessage: string
    obviousCandidates?: unknown
    llmTier1Raw?: string | null
    llmTier2Raw?: string | null
    llmParsed?: unknown
    llmStatus?: string
  }> = []

  // === Case 1: deterministic pattern (new "soft spot for" pattern) ===
  const case1Msg = "honestly I've always had a soft spot for Blade Runner"
  const obvious = extractObviousCandidates(case1Msg)
  results.push({
    label: 'Case 1 — deterministic pattern (soft spot for)',
    userMessage: case1Msg,
    obviousCandidates: obvious,
  })

  // === Case 2: LLM path (no pattern match) ===
  const case2Msg = "the new Denis Villeneuve movie really stuck with me, I think I need to rewatch it"
  const prompt = `You are ARIA's memory curator. Read the exchange and extract 0-2 memory candidates.

USER SAID: "${case2Msg}"
ARIA REPLIED: "Villeneuve's craft is undeniable — the restraint is the point."

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

  // Tier 1: Groq 70B
  let raw = await generateWithFallback(prompt, { model: 'llama-3.3-70b-versatile' })
  let tier = 'Groq 70B'
  // Tier 2: Gemini (only if Groq failed)
  if (!raw) {
    raw = await callGeminiForExtraction(prompt)
    tier = 'Gemini 2.0 Flash'
  }

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
    label: `Case 2 — LLM path (${tier})`,
    userMessage: case2Msg,
    llmTier1Raw: raw ? raw.slice(0, 400) : null,
    llmParsed: parsed.candidates || [],
    llmStatus: raw ? `${tier} responded` : 'Both Groq + Gemini failed',
  })

  return NextResponse.json({ ok: true, results })
}
