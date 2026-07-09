/**
 * Embedding generation + semantic search using OpenAI embeddings API.
 * Uses text-embedding-3-small (1536 dimensions, $0.02 per 1M tokens — basically free).
 *
 * Embeddings are stored in Neon Postgres via pgvector.
 * Semantic search finds the most relevant memories/conversations by meaning,
 * not just by recency.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

/**
 * Generate an embedding vector for a piece of text.
 * Returns a number[] of length 1536 (or null if API key not configured).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) {
    return null
  }

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000), // API limit
      }),
    })

    if (!response.ok) {
      console.error('[embedding] API error:', response.status, await response.text())
      return null
    }

    const data = await response.json()
    return data.data?.[0]?.embedding ?? null
  } catch (err) {
    console.error('[embedding]', err)
    return null
  }
}

/**
 * Convert a number[] embedding to a PostgreSQL vector string for pgvector.
 * e.g., [0.1, 0.2, 0.3] → "[0.1,0.2,0.3]"
 */
export function embeddingToPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Available AI models on OpenRouter that users can choose from.
 * Each model has a different personality/cost/speed tradeoff.
 */
export const AVAILABLE_MODELS = [
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    description: 'Fast, capable, great value. ARIA\'s default.',
    badge: 'Default',
  },
  {
    id: 'qwen/qwen-2.5-72b-instruct',
    name: 'Qwen 2.5 72B',
    description: 'Excellent reasoning, multilingual.',
    badge: 'Capable',
  },
  {
    id: 'amazon/nova-lite-v1',
    name: 'Amazon Nova Lite',
    description: 'Fast, cost-effective, reliable.',
    badge: 'Fast',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B',
    description: 'Open-source, community-driven.',
    badge: 'Open Source',
  },
] as const

/**
 * Get the model ID from user settings, with fallback to default.
 */
export function getModelFromSettings(modelPreference: string | null | undefined): string {
  if (!modelPreference) return 'deepseek/deepseek-chat'
  const isValid = AVAILABLE_MODELS.some(m => m.id === modelPreference)
  return isValid ? modelPreference : 'deepseek/deepseek-chat'
}
