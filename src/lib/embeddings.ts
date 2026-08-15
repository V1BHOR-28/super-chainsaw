/**
 * Embedding generation using Gemini's free text-embedding-004 model.
 *
 * Gemini's embedding API is FREE (no credits needed) and works from Vercel's
 * infrastructure. It produces 768-dimension vectors.
 *
 * Previously used OpenAI text-embedding-3-small (1536 dims) but that fails
 * due to: (1) region restriction, (2) user has 0 credits.
 *
 * The pgvector column was changed from vector(1536) to vector(768) to match.
 * Since embeddings never worked before (always returned null), there are no
 * existing embeddings to migrate — the dimension change is safe.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const EMBEDDING_DIMENSIONS = 768

/**
 * Maximum cosine distance (via pgvector `<=>`) for a semantic search result to
 * be considered a genuine match. Lower = more similar. Results above this
 * threshold are filtered out so the model doesn't receive loosely-related
 * chunks as if they were relevant context. Tunable — start at 0.5 and adjust
 * based on real query quality.
 */
export const MAX_RELEVANCE_DISTANCE = 0.5

/**
 * Generate an embedding vector for a piece of text using Gemini.
 * Returns a number[] of length 768 (or null if API key not configured).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) {
    console.warn('[embedding] No GEMINI_API_KEY — embeddings disabled')
    return null
  }

  try {
    // Use Gemini's OpenAI-compatible embeddings endpoint.
    // Model: gemini-embedding-001 (confirmed available via ListModels API).
    // text-embedding-004 does NOT exist — that was the wrong model name.
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gemini-embedding-001',
        input: text.slice(0, 8000),
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      const errBody = await response.text()
      console.error('[embedding] Gemini API error:', response.status, errBody.slice(0, 200))
      return null
    }

    const data = await response.json()
    const embedding = data.data?.[0]?.embedding ?? null

    if (embedding && embedding.length !== EMBEDDING_DIMENSIONS) {
      console.warn(`[embedding] Unexpected dimensions: ${embedding.length} (expected ${EMBEDDING_DIMENSIONS})`)
    }

    return embedding
  } catch (err) {
    console.error('[embedding]', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Convert a number[] embedding to a PostgreSQL vector string for pgvector.
 */
export function embeddingToPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Available AI models on OpenRouter.
 */
export const AVAILABLE_MODELS = [
  {
    id: 'openai/gpt-oss-120b:free',
    name: 'GPT-OSS 120B',
    description: 'Largest free model, 117B MoE. Great reasoning.',
    badge: 'Default',
    tier: 'free' as const,
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    description: 'Strong reasoning and coding. Uses paid credits (~$0.14/M tokens).',
    badge: 'Paid',
    tier: 'paid' as const,
  },
  {
    id: 'sarvam-105b',
    name: 'Sarvam 105B',
    description: '128K context, strong tool-use. Uses paid credits (~₹29/M in, ~₹73/M out).',
    badge: 'Paid',
    tier: 'paid' as const,
  },
] as const

/**
 * Get the model ID from user settings, with fallback to default.
 *
 * The last-resort fallback model (used internally on 429 / decommission in
 * src/app/api/chat/route.ts) is intentionally NOT in AVAILABLE_MODELS — it
 * is never user-selectable, only used as a hardcoded safety net.
 */
export function getModelFromSettings(modelPreference: string | null | undefined): string {
  if (!modelPreference) return 'openai/gpt-oss-120b:free'
  const isValid = AVAILABLE_MODELS.some(m => m.id === modelPreference)
  return isValid ? modelPreference : 'openai/gpt-oss-120b:free'
}
