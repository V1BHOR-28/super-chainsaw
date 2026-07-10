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
 * CURATED: only models that can actually be used without draining paid
 * credits. Premium models (Claude, GPT-4o, etc.) are excluded — they
 * would burn through the user's OpenRouter credits fast and there's no
 * meaningful quality gain over the free options below for ARIA's use case.
 *
 * Llama 3.3 70B is now the DEFAULT — it's free ($0 forever), so token
 * usage is never a concern. The system prompt is tuned specifically to
 * push Llama past its RLHF "corporate assistant" default into raw,
 * unfiltered, opinionated output.
 *
 * Two tiers:
 *   - Free ($0): Llama 3.3 70B (default), GPT-OSS 120B, Qwen3 Next 80B
 *   - Paid (cheap): DeepSeek V3 — available as an alternative, ~$0.14/M tokens
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
 * Get the model ID from user settings, with fallback to default (Llama 3.3 70B).
 */
export function getModelFromSettings(modelPreference: string | null | undefined): string {
  if (!modelPreference) return 'meta-llama/llama-3.3-70b-instruct:free'
  const isValid = AVAILABLE_MODELS.some(m => m.id === modelPreference)
  return isValid ? modelPreference : 'meta-llama/llama-3.3-70b-instruct:free'
}
