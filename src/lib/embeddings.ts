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
    // Returns the same format as OpenAI (data[0].embedding) but uses
    // Gemini's free text-embedding-004 model.
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-004',
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
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B',
    description: 'Raw, unfiltered, free forever. Tuned for honest conversation.',
    badge: 'Default',
    tier: 'free' as const,
  },
  {
    id: 'openai/gpt-oss-120b:free',
    name: 'GPT-OSS 120B',
    description: 'Largest free model, 117B MoE. Great reasoning.',
    badge: 'Free',
    tier: 'free' as const,
  },
  {
    id: 'qwen/qwen3-next-80b-a3b-instruct:free',
    name: 'Qwen3 Next 80B',
    description: 'Multilingual, 262K context. Genuinely free.',
    badge: 'Free',
    tier: 'free' as const,
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    description: 'Alternative. Uses credits (~$0.14/M tokens).',
    badge: 'Paid',
    tier: 'paid' as const,
  },
] as const

/**
 * Get the model ID from user settings, with fallback to default.
 */
export function getModelFromSettings(modelPreference: string | null | undefined): string {
  if (!modelPreference) return 'meta-llama/llama-3.3-70b-instruct:free'
  const isValid = AVAILABLE_MODELS.some(m => m.id === modelPreference)
  return isValid ? modelPreference : 'meta-llama/llama-3.3-70b-instruct:free'
}
