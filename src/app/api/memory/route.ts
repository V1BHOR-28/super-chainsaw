import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding } from '@/lib/embeddings'

/**
 * GET /api/memory — list all memories
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const memories = await db.memory.findMany({
      where: { userId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    })
    return NextResponse.json({ memories })
  } catch (err) {
    console.error('[memory.list]', err)
    return NextResponse.json({ error: 'Failed to load memories' }, { status: 500 })
  }
}

/**
 * POST /api/memory — create a memory
 * Body: { content: string, category?: string, pinned?: boolean }
 *
 * Now generates an embedding for semantic search.
 * Deduplication: if a memory with >70% word overlap exists, returns 409.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const content = (body.content as string)?.trim()
    if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

    // Dedup check against existing memories
    const existing = await db.memory.findMany({
      where: { userId },
      select: { id: true, content: true, category: true },
    })
    const dup = existing.find((m) => wordOverlap(m.content, content) > 0.7)
    if (dup) {
      return NextResponse.json(
        { error: 'duplicate', existing: dup },
        { status: 409 }
      )
    }

    // Generate embedding for semantic search
    const embedding = await generateEmbedding(content)

    // Save memory with embedding (using raw SQL for pgvector)
    const memory = await db.memory.create({
      data: {
        userId,
        content: content.slice(0, 1000),
        category: (body.category as string)?.slice(0, 40) || 'general',
        pinned: !!body.pinned,
      },
    })

    // If we got an embedding, store it via raw SQL
    if (embedding) {
      await db.$executeRaw`
        UPDATE "Memory"
        SET embedding = ${embeddingToPgVector(embedding)}::vector
        WHERE id = ${memory.id}
      `
    }

    return NextResponse.json({ memory })
  } catch (err) {
    console.error('[memory.create]', err)
    return NextResponse.json({ error: 'Failed to create memory' }, { status: 500 })
  }
}

/**
 * Semantic search: find memories most relevant to a query.
 * Uses pgvector cosine distance (<=>) to find nearest neighbors.
 */
export async function semanticMemorySearch(userId: string, query: string, limit: number = 10): Promise<Array<{ content: string; category: string; pinned: boolean }>> {
  const embedding = await generateEmbedding(query)
  if (!embedding) {
    // Fallback: return most recent + pinned
    const fallback = await db.memory.findMany({
      where: { userId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
      select: { content: true, category: true, pinned: true },
    })
    return fallback
  }

  // Always include pinned memories
  const pinned = await db.memory.findMany({
    where: { userId, pinned: true },
    select: { content: true, category: true, pinned: true },
  })

  // Semantic search for non-pinned memories
  const vectorStr = `[${embedding.join(',')}]`
  const semanticResults = await db.$queryRaw<Array<{ content: string; category: string; pinned: boolean }>>`
    SELECT content, category, pinned
    FROM "Memory"
    WHERE "userId" = ${userId}
      AND pinned = false
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `

  // Merge: pinned first, then semantic results
  return [...pinned, ...semanticResults]
}

/** Returns the word-overlap ratio between two strings (0-1). */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let shared = 0
  for (const w of wordsA) if (wordsB.has(w)) shared++
  return (2 * shared) / (wordsA.size + wordsB.size)
}

function embeddingToPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}
