/**
 * callGeminiForExtraction — a distinct Gemini call for tasks that benefit
 * from enforced JSON output (which Groq's small models don't reliably honor).
 *
 * Uses Gemini's native generateContent endpoint with responseMimeType:
 * 'application/json' — the model is forced to return valid JSON, no regex
 * extraction needed. Model: gemini-2.0-flash (confirmed working for
 * generation in this project's chat route).
 *
 * Returns the raw text content (which will be valid JSON), or null on failure.
 * Exported separately so the detect route can call it as a distinct second
 * tier AFTER Groq, not bundled into generateWithFallback's Promise.any.
 */
export async function callGeminiForExtraction(prompt: string): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) {
    console.error('[llm-fallback] Gemini extraction: no GEMINI_API_KEY')
    return null
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(25000),
      }
    )
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error(`[llm-fallback] Gemini extraction error: ${res.status} ${errBody.slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!content?.trim()) {
      console.error('[llm-fallback] Gemini extraction: empty content')
      return null
    }
    return content.trim()
  } catch (e) {
    console.error(`[llm-fallback] Gemini extraction threw: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * generateWithFallback — a minimal, self-contained LLM call used for
 * background compression tasks (conversation summaries, memory detection).
 *
 * Mirrors the provider pattern in src/app/api/chat/route.ts: fires Groq
 * (fastest, free) and Pollinations (keyless backstop) in parallel via
 * Promise.any, first success wins.
 *
 * Callers can override the default Groq model via opts.model — e.g. memory
 * detection passes 'llama-3.3-70b-versatile' (larger, more precise for
 * named-entity extraction); conversation-summary uses the default
 * 'llama-3.1-8b-instant' (smaller, faster for pure compression).
 *
 * Returns the trimmed text content, or null if every provider fails.
 */
export async function generateWithFallback(
  prompt: string,
  opts?: { model?: string; maxTokens?: number }
): Promise<string | null> {
  const messages = [{ role: 'user' as const, content: prompt }]
  const groqModel = opts?.model ?? 'llama-3.1-8b-instant' // default stays small/fast
  // Default max_tokens stays at 800 to preserve existing behavior for short
  // background tasks (conversation-summary, memory-detect). Chapter cleaning
  // passes a larger value sized to its input — see cleanChapterLLM.
  const maxTokens = opts?.maxTokens ?? 800

  const callGroq = async (): Promise<string> => {
    if (!process.env.GROQ_API_KEY) throw new Error('Groq: no API key')
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: groqModel,
        messages,
        max_tokens: maxTokens,
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
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content?.trim()) throw new Error('OpenRouter empty')
    return content.trim()
  }

  // Pollinations — keyless backstop (same as the chat route's callPollinations).
  // Always available, no API key needed, no rate limits. The safety net.
  // NOTE: The POST /openai endpoint now returns 402 for large anonymous requests
  // (chapter cleaning needs ~1576 output tokens). The GET endpoint below is the
  // true backstop — it doesn't enforce the pollen budget.
  const callPollinations = async (): Promise<string> => {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`Pollinations ${res.status}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content?.trim()) throw new Error('Pollinations empty')
    return content.trim()
  }

  // Pollinations GET endpoint — the POST /openai endpoint now returns 402 for
  // large anonymous requests (chapter cleaning needs ~1576 output tokens).
  // The GET endpoint (text.pollinations.ai/{prompt}) does NOT enforce the
  // pollen budget for anonymous requests — it's the original free API.
  // URL-encode the prompt and cap its length to stay under URL length limits.
  const callPollinationsGet = async (): Promise<string> => {
    // Cap prompt to 60000 chars (well under URL length limits for most servers).
    // For chapter cleaning, this covers chapters up to ~15K chars (plenty).
    const cappedPrompt = prompt.slice(0, 60000)
    const encoded = encodeURIComponent(cappedPrompt)
    const res = await fetch(`https://text.pollinations.ai/${encoded}`, {
      method: 'GET',
      signal: AbortSignal.timeout(60000), // GET can be slower for long outputs
    })
    if (!res.ok) throw new Error(`Pollinations GET ${res.status}`)
    const text = await res.text()
    if (!text?.trim()) throw new Error('Pollinations GET empty')
    return text.trim()
  }

  const providers: Array<() => Promise<string>> = []
  // Groq is the fastest + cheapest — primary path (works from Vercel/production).
  if (process.env.GROQ_API_KEY) providers.push(callGroq)
  // Pollinations POST is the first keyless backstop.
  providers.push(callPollinations)
  // Pollinations GET is the true keyless backstop — doesn't enforce pollen budget.
  providers.push(callPollinationsGet)

  if (providers.length === 0) {
    console.error('[llm-fallback] No providers available (GROQ_API_KEY unset and Pollinations unreachable)')
    return null
  }

  try {
    return await Promise.any(providers.map((fn) => fn()))
  } catch (err) {
    // All providers failed — log which providers were tried + the aggregate error
    // so every caller (conversation-summary, memory-detect, etc.) gets the same
    // visibility without each having to re-log. AggregateError (Node 15+) carries
    // the per-provider rejection reasons on .errors.
    const tried = providers.length === 1
      ? 'Pollinations only'
      : 'Groq + Pollinations'
    const reasons = err instanceof AggregateError
      ? err.errors.map((e, i) => `[${i}] ${e instanceof Error ? e.message : String(e)}`).join(' | ')
      : (err instanceof Error ? err.message : String(err))
    console.error(`[llm-fallback] All providers failed (${tried}) — ${reasons}`)
    return null
  }
}

// Warn once at module load if no LLM API keys are set — Pollinations POST
// now returns 402 for large requests, so the GET endpoint is the only free
// backstop. Quality will be lower without Groq or OpenRouter.
if (!process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
  console.warn('[llm-fallback] No GROQ_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY set. Falling back to Pollinations GET only — chapter cleaning and chat quality will be reduced.')
}
