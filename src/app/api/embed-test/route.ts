import { NextResponse } from 'next/server'
export const runtime = "nodejs"

/**
 * GET /api/embed-test — tests the Gemini embedding API from Vercel's
 * infrastructure. Returns the full response so we can see exactly what's
 * happening (error message, dimensions, etc).
 */
export async function GET() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY

  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not set' })
  }

  const results: Record<string, unknown> = {
    keyPresent: true,
    keyPreview: GEMINI_API_KEY.slice(0, 8) + '...',
    keyLength: GEMINI_API_KEY.length,
  }

  // Test 1: Try OpenAI-compatible endpoint
  try {
    const res1 = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gemini-embedding-001',
        input: 'test embedding for ARIA',
        dimensions: 768,
      }),
      signal: AbortSignal.timeout(10000),
    })

    const body1 = await res1.text()
    results.openaiCompatible = {
      status: res1.status,
      ok: res1.ok,
      body: body1.slice(0, 500),
    }

    if (res1.ok) {
      try {
        const parsed = JSON.parse(body1)
        const embedding = parsed.data?.[0]?.embedding
        results.openaiCompatible.dimensions = embedding?.length
        results.openaiCompatible.firstValues = embedding?.slice(0, 3)
      } catch {}
    }
  } catch (err) {
    results.openaiCompatible = { error: err instanceof Error ? err.message : String(err) }
  }

  // Test 2: Try native Gemini endpoint (embedContent)
  try {
    const res2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: 'test embedding for ARIA' }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 768,
      }),
      signal: AbortSignal.timeout(10000),
    })

    const body2 = await res2.text()
    results.nativeGemini = {
      status: res2.status,
      ok: res2.ok,
      body: body2.slice(0, 500),
    }

    if (res2.ok) {
      try {
        const parsed = JSON.parse(body2)
        const embedding = parsed.embedding?.values
        results.nativeGemini.dimensions = embedding?.length
        results.nativeGemini.firstValues = embedding?.slice(0, 3)
      } catch {}
    }
  } catch (err) {
    results.nativeGemini = { error: err instanceof Error ? err.message : String(err) }
  }

  // Test 3: List available models to check if text-embedding-004 exists
  try {
    const res3 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`, {
      signal: AbortSignal.timeout(10000),
    })
    const body3 = await res3.text()
    if (res3.ok) {
      const parsed = JSON.parse(body3)
      const embedModels = (parsed.models || []).filter((m: { supportedGenerationMethods?: string[] }) =>
        m.supportedGenerationMethods?.includes('embedContent')
      )
      results.availableEmbedModels = embedModels.map((m: { name: string }) => m.name)
    } else {
      results.modelsList = { status: res3.status, body: body3.slice(0, 300) }
    }
  } catch (err) {
    results.modelsList = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json(results, { headers: { 'Cache-Control': 'no-cache' } })
}
