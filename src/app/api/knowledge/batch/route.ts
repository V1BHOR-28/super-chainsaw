import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 30
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding, embeddingToPgVector } from '@/lib/embeddings'
import { hasHitUploadLimit, recordUpload } from '@/lib/usage'

/**
 * POST /api/knowledge/batch
 *
 * Receives a batch of text chunks (extracted by the client-side PDF parser)
 * and stores each as a separate Knowledge row with its own embedding.
 *
 * This is the backend half of the large-file pipeline:
 *   Browser parses PDF → extracts text → chunks it → sends batches here
 *   This endpoint embeds + stores each chunk.
 *
 * Body: {
 *   documentId: string,       // groups all chunks of one book together
 *   title: string,            // book title (chunks titled "[Title] — Part N/M")
 *   source: string,           // 'pdf' | 'file' | 'text'
 *   sourceUrl?: string,
 *   chunks: string[],         // array of ~3000-char text chunks
 *   batchIndex: number,       // which batch (0-indexed)
 *   totalBatches: number,     // total number of batches
 *   totalChunks: number,      // total chunks across all batches
 *   chunkOffset: number,      // starting chunk number (for "Part N/M" labeling)
 * }
 *
 * Response: { ok: true, stored: number, embedded: number, chunkOffset: number }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Rate limit: 20 knowledge uploads/day for non-admin tiers
    const uploadLimit = await hasHitUploadLimit(userId, 'knowledge')
    if (uploadLimit.limited) {
      return NextResponse.json(
        { error: `Daily knowledge upload limit reached (${uploadLimit.limit}). Resets at ${uploadLimit.resetsAt}.` },
        { status: 429 }
      )
    }

    const body = await req.json()
    const {
      documentId,
      title,
      source,
      sourceUrl,
      chunks,
      totalChunks,
      chunkOffset,
    } = body as {
      documentId: string
      title: string
      source: string
      sourceUrl?: string
      chunks: string[]
      totalChunks: number
      chunkOffset: number
    }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return NextResponse.json({ error: 'No chunks provided' }, { status: 400 })
    }

    // === INPUT SIZE VALIDATION ===
    // Reject oversized payloads BEFORE any embedding calls or DB writes happen.
    const MAX_CHUNKS_PER_REQUEST = 50
    const MAX_CHUNK_LENGTH = 4500
    const MAX_TOTAL_SIZE = 150_000

    if (chunks.length > MAX_CHUNKS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many chunks: ${chunks.length} (maximum ${MAX_CHUNKS_PER_REQUEST} per request)` },
        { status: 400 }
      )
    }

    for (let i = 0; i < chunks.length; i++) {
      if (typeof chunks[i] !== 'string' || chunks[i].length > MAX_CHUNK_LENGTH) {
        return NextResponse.json(
          { error: `Chunk ${i} exceeds maximum size of ${MAX_CHUNK_LENGTH} characters` },
          { status: 400 }
        )
      }
    }

    const totalSize = chunks.reduce((sum, c) => sum + c.length, 0)
    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        { error: `Total chunk size ${totalSize} exceeds maximum of ${MAX_TOTAL_SIZE} characters per request` },
        { status: 400 }
      )
    }

    // Generate embeddings for all chunks in this batch in parallel.
    // Best-effort: if embedding fails (no API key, rate limit), the chunk
    // is still stored — it just won't be semantically searchable (keyword
    // ILIKE search still works as a fallback).
    const embeddings: (number[] | null)[] = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          return await generateEmbedding(chunk.slice(0, 8000))
        } catch {
          return null
        }
      })
    )

    const embeddedCount = embeddings.filter((e) => e !== null).length

    // Store each chunk as a separate Knowledge row.
    // Title format: "[Book Title] — Part N/M" so ARIA knows which section
    // she's reading when she retrieves it.
    let storedCount = 0
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const globalChunkIndex = chunkOffset + i
      const chunkTitle =
        totalChunks > 1
          ? `${title} — Part ${globalChunkIndex + 1}/${totalChunks}`
          : title
      const id = `${Date.now()}-${globalChunkIndex}-${Math.random().toString(36).slice(2, 8)}`
      const embedding = embeddings[i]

      try {
        if (embedding) {
          const vectorStr = embeddingToPgVector(embedding)
          await db.$executeRaw`
            INSERT INTO "Knowledge" (id, "userId", title, content, source, "sourceUrl", "documentId", embedding, "createdAt")
            VALUES (${id}, ${userId}, ${chunkTitle}, ${chunk}, ${source}, ${sourceUrl ?? null}, ${documentId}, ${vectorStr}::vector, NOW())
          `
        } else {
          await db.knowledge.create({
            data: { id, userId, title: chunkTitle, content: chunk, source, sourceUrl, documentId },
          })
        }
        storedCount++
      } catch (e) {
        console.error(`[knowledge.batch] Failed to store chunk ${globalChunkIndex + 1}:`, e instanceof Error ? e.message : String(e))
        // Continue — partial storage is better than total failure
      }
    }

    // Record the upload for rate limiting
    await recordUpload(userId, 'knowledge').catch(() => {})

    return NextResponse.json({
      ok: true,
      stored: storedCount,
      embedded: embeddedCount,
      chunkOffset,
    })
  } catch (err) {
    console.error('[knowledge.batch]', err)
    const message = err instanceof Error ? err.message : 'Batch upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
