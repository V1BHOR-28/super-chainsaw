import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * DELETE /api/knowledge/[id] — delete a knowledge entry (or all chunks of a document).
 *
 * The `id` parameter can be either:
 *   1. A specific Knowledge row ID (e.g. "1234567890-3-abc123") — deletes that one row.
 *      Used for single-chunk items and summaries.
 *   2. A documentId (e.g. "doc-1700000000-abc123") — deletes EVERY chunk of that
 *      specific upload, never a different upload that happens to share the same title.
 *      This is the safe path: two books with the same title no longer cross-delete.
 *
 * We try exact row ID first; if nothing matches, we treat `id` as a documentId.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Try exact row ID first (single-chunk items, summaries)
    let result = await db.knowledge.deleteMany({ where: { id, userId } })

    // Otherwise treat `id` as a documentId — deletes every chunk of that specific
    // upload, never a different upload that happens to share the same title.
    if (result.count === 0) {
      result = await db.knowledge.deleteMany({ where: { userId, documentId: id } })
    }

    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true, deleted: result.count })
  } catch (err) {
    console.error('[knowledge.delete]', err)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
