import { NextResponse } from 'next/server'
import { extractObviousCandidates } from '@/app/api/memory/detect/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Temporary diagnostic: verifies memory detection hardening on Vercel production.
// Case 1: deterministic fallback (extractObviousCandidates) — no LLM call needed.
// Case 2: LLM path with response_format: json_object — tests structured output.
// Will be removed after verification.
export async function GET() {
  const results: Array<{
    label: string
    userMessage: string
    obviousCandidates?: Array<{ text: string; category: string; confidence: string }>
    llmCandidates?: unknown
    openRouterStatus?: number
    openRouterError?: string
  }> = []

  // === Case 1: deterministic fallback ===
  const case1Msg = 'ummm my favorite movie is vanilla sky'
  const obvious = extractObviousCandidates(case1Msg)
  results.push({
    label: 'Case 1 — deterministic fallback (pattern match)',
    userMessage: case1Msg,
    obviousCandidates: obvious,
  })

  // === Case 2: LLM path with structured output ===
  const case2Msg = "honestly I've always had a soft spot for Blade Runner"
  const prompt = `You are ARIA's memory curator. Read the exchange and extract 0-2 memory candidates.

USER SAID: "${case2Msg}"
ARIA REPLIED: "Blade Runner is a masterpiece of atmosphere."

RULES:
- SAVE: permanent facts, stable preferences, identities, goals, relationships
- SKIP: transient states, temporary emotions, small talk
- "high" = clear fact (auto-save), "medium" = borderline (ask user)

Respond with ONLY JSON: {"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ariav2-seven.vercel.app',
        'X-Title': 'ARIA',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(25000),
    })
    const data = await res.json()
    const raw = data.choices?.[0]?.message?.content ?? ''
    let parsed: { candidates?: Array<{ text: string; category: string; confidence: string }> } = { candidates: [] }
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
    } catch {
      // keep empty
    }
    results.push({
      label: 'Case 2 — LLM path with structured output',
      userMessage: case2Msg,
      llmCandidates: parsed.candidates || [],
      openRouterStatus: res.status,
      ...(res.ok ? {} : { openRouterError: JSON.stringify(data.error || data).slice(0, 200) }),
    })
  } catch (err) {
    results.push({
      label: 'Case 2 — LLM path with structured output',
      userMessage: case2Msg,
      openRouterError: err instanceof Error ? err.message : 'unknown',
    })
  }

  return NextResponse.json({ ok: true, results })
}
