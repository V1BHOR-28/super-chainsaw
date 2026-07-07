import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

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
 * Deduplication: if a memory with >70% word overlap already exists, returns
 * 409 Conflict with the existing memory so the client can offer merge/replace.
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

    const memory = await db.memory.create({
      data: {
        userId,
        content: content.slice(0, 1000),
        category: (body.category as string)?.slice(0, 40) || 'general',
        pinned: !!body.pinned,
      },
    })
    return NextResponse.json({ memory })
  } catch (err) {
    console.error('[memory.create]', err)
    return NextResponse.json({ error: 'Failed to create memory' }, { status: 500 })
  }
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
