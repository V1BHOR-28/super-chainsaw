import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Temporary diagnostic: exercises /api/memory/detect with two test cases
// to verify the hardening works end-to-end on Vercel production.
// Case 1: "my favorite movie is Vanilla Sky" (tests deterministic fallback)
// Case 2: "honestly I've always had a soft spot for Blade Runner" (tests LLM path)
// Will be removed after verification.
export async function GET() {
  const cases = [
    {
      label: 'Case 1 — deterministic fallback (pattern match)',
      userMessage: 'ummm my favorite movie is vanilla sky',
      ariaReply: 'Vanilla Sky! That\'s a fascinating pick — Cameron Crowe\'s most divisive film. The way it blurs reality and dreams still holds up.',
    },
    {
      label: 'Case 2 — LLM path with structured output',
      userMessage: 'honestly I\'ve always had a soft spot for Blade Runner',
      ariaReply: 'Blade Runner is a masterpiece of atmosphere. The rain-soaked neon LA is one of the most influential worlds ever built on film.',
    },
  ]

  const results = []
  for (const c of cases) {
    try {
      const res = await fetch('https://ariav2-seven.vercel.app/api/memory/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: c.userMessage, ariaReply: c.ariaReply }),
      })
      const data = await res.json()
      results.push({
        label: c.label,
        userMessage: c.userMessage,
        httpStatus: res.status,
        candidates: data.candidates || [],
      })
    } catch (err) {
      results.push({
        label: c.label,
        userMessage: c.userMessage,
        error: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  return NextResponse.json({ ok: true, results })
}
