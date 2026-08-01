import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding, MAX_RELEVANCE_DISTANCE } from '@/lib/embeddings'
import { hasHitUploadLimit, recordUpload } from '@/lib/usage'

/**
 * GET /api/memory — list memories (cursor-based pagination, 50 per page).
 * Pinned memories always come first (orderBy), then by updatedAt desc.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const cursor = searchParams.get('cursor') || undefined
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100)

    const memories = await db.memory.findMany({
      where: { userId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit + 1, // fetch one extra to know if there's a next page
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const hasMore = memories.length > limit
    const page = hasMore ? memories.slice(0, limit) : memories
    const nextCursor = hasMore ? page[page.length - 1].id : null

    return NextResponse.json({ memories: page, nextCursor })
  } catch (err) {
    console.error('[memory.list]', err)
    return NextResponse.json({ error: 'Failed to load memories' }, { status: 500 })
  }
}

/**
 * POST /api/memory — create a memory
 * Body: { content: string, category?: string, pinned?: boolean, source?: 'auto'|'manual' }
 *
 * Generates the embedding FIRST so it can be used for dedup, not just storage.
 * Deduplication: literal word-overlap (>0.7) OR semantic cosine distance (<0.1).
 * Returns 409 { error: 'duplicate', existing } when a dup is found.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    // Rate limit: 100 memory writes/day for non-admin tiers
    const uploadLimit = await hasHitUploadLimit(userId, 'memory')
    if (uploadLimit.limited) {
      return NextResponse.json(
        { error: `Daily memory write limit reached (${uploadLimit.limit}). Resets at ${uploadLimit.resetsAt}.` },
        { status: 429 }
      )
    }

    const body = await req.json().catch(() => ({}))
    const content = (body.content as string)?.trim()
    if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

    // Generate embedding FIRST so it can be used for dedup, not just storage.
    const embedding = await generateEmbedding(content)

    // Literal word-overlap check (cheap, catches near-identical phrasing)
    // Limited to 200 most recent — only needs to catch recently-created
    // near-duplicates, not compare against a user's entire multi-year history.
    // The semantic dedup check below (LIMIT 1 via pgvector) is the primary
    // catch-all for older duplicates expressed in different words.
    const existing = await db.memory.findMany({
      where: { userId },
      select: { id: true, content: true, category: true },
      take: 200,
      orderBy: { updatedAt: 'desc' },
    })
    let dup = existing.find((m) => wordOverlap(m.content, content) > 0.7)

    // Semantic check (catches same fact, different words) — only if embedding succeeded
    if (!dup && embedding) {
      const vectorStr = `[${embedding.join(',')}]`
      const semanticDup = await db.$queryRaw<Array<{ id: string; content: string; category: string; distance: number }>>`
        SELECT id, content, category, embedding <=> ${vectorStr}::vector AS distance
        FROM "Memory"
        WHERE "userId" = ${userId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT 1
      `
      // Cosine distance < 0.1 ≈ near-identical meaning.
      if (semanticDup[0] && semanticDup[0].distance < 0.1) {
        dup = { id: semanticDup[0].id, content: semanticDup[0].content, category: semanticDup[0].category }
      }
    }

    if (dup) {
      return NextResponse.json({ error: 'duplicate', existing: dup }, { status: 409 })
    }

    const memory = await db.memory.create({
      data: {
        userId,
        content: content.slice(0, 1000),
        category: (body.category as string)?.slice(0, 40) || 'general',
        pinned: !!body.pinned,
        source: (body.source === 'auto' ? 'auto' : 'manual'),
      },
    })

    if (embedding) {
      await db.$executeRaw`
        UPDATE "Memory"
        SET embedding = ${embeddingToPgVector(embedding)}::vector
        WHERE id = ${memory.id}
      `
    }

    // Record the write for rate limiting
    await recordUpload(userId, 'memory').catch(() => {})

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
  // Pinned memories are NOT filtered by distance — they're explicitly user-curated
  // and always included regardless of relevance to the current query.
  const vectorStr = `[${embedding.join(',')}]`
  const semanticResults = await db.$queryRaw<Array<{ content: string; category: string; pinned: boolean }>>`
    SELECT content, category, pinned
    FROM "Memory"
    WHERE "userId" = ${userId}
      AND pinned = false
      AND embedding IS NOT NULL
      AND embedding <=> ${vectorStr}::vector < ${MAX_RELEVANCE_DISTANCE}
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
