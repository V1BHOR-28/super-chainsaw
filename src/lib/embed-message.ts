import { db } from '@/lib/db'
import { generateEmbedding } from '@/lib/embeddings'

/**
 * embedMessageAsync — best-effort, fire-and-forget. Embeds a message's
 * content after it's been persisted, so semantic search has something to
 * match against. Never throws — a failed embed should not affect the chat.
 */
export async function embedMessageAsync(messageId: string, content: string): Promise<void> {
  try {
    // Skip embedding trivially short messages — not worth the API call or the
    // noise in search results.
    if (content.trim().length < 20) return
    const embedding = await generateEmbedding(content.slice(0, 3000))
    if (!embedding) return
    const vectorStr = `[${embedding.join(',')}]`
    await db.$executeRaw`UPDATE "Message" SET embedding = ${vectorStr}::vector WHERE id = ${messageId}`
  } catch (err) {
    console.error('[embed-message]', err)
  }
}
