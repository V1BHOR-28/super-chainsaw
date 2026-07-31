/**
 * generateWithFallback — a minimal, self-contained LLM call used for
 * background compression tasks (conversation summaries, etc.).
 *
 * Mirrors the provider pattern in src/app/api/chat/route.ts: fires Groq
 * (fastest, free 8B) and OpenRouter (free Llama 70B) in parallel via
 * Promise.any, first success wins. This is the cheapest available path —
 * NOT the main conversational model. Summarization is a compression task.
 *
 * Returns the trimmed text content, or null if every provider fails.
 */
export async function generateWithFallback(prompt: string): Promise<string | null> {
  const messages = [{ role: 'user' as const, content: prompt }]

  const callGroq = async (): Promise<string> => {
    if (!process.env.GROQ_API_KEY) throw new Error('Groq: no API key')
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`Groq ${res.status}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content?.trim()) throw new Error('Groq empty')
    return content.trim()
  }

  const callOpenRouter = async (model: string): Promise<string> => {
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter: no API key')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ariav2-seven.vercel.app',
        'X-Title': 'ARIA',
      },
      body: JSON.stringify({ model, messages, max_tokens: 800 }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content?.trim()) throw new Error('OpenRouter empty')
    return content.trim()
  }

  const providers: Array<() => Promise<string>> = []
  if (process.env.GROQ_API_KEY) providers.push(callGroq)
  providers.push(() => callOpenRouter('meta-llama/llama-3.3-70b-instruct:free'))

  if (providers.length === 0) return null

  try {
    return await Promise.any(providers.map((fn) => fn()))
  } catch {
    return null
  }
}
