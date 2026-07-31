import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    return NextResponse.json({ ok: false, error: 'GROQ_API_KEY not set' }, { status: 500 })
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'Say "ok" in one word.' }],
        max_tokens: 5,
      }),
    })

    const body = await res.text()
    let parsed: unknown = null
    try { parsed = JSON.parse(body) } catch { /* keep raw */ }

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      keyPreview: `${key.slice(0, 8)}...${key.slice(-4)} (${key.length} chars)`,
      reply: (parsed as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? null,
      errorBody: !res.ok ? body.slice(0, 300) : null,
    })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'unknown',
    }, { status: 500 })
  }
}
