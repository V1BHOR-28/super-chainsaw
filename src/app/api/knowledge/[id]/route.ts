import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * DELETE /api/knowledge/[id] — delete a knowledge entry (or all chunks of a book).
 *
 * The `id` parameter can be either:
 *   1. A specific Knowledge row ID (e.g. "1234567890-3-abc123") — deletes that one row
 *   2. A base book title (e.g. "How to Win Friends") — deletes ALL chunks of that book.
 *      This is needed because books are stored as multiple chunk rows with titles like
 *      "Book Title — Part 1/100", "Book Title — Part 2/100", etc.
 *
 * We detect which case by checking if the ID matches a row ID directly. If not,
 * we treat it as a base title and delete all rows whose title starts with it.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // First try: delete by exact ID (single row)
    let result = await db.knowledge.deleteMany({ where: { id, userId } })

    if (result.count === 0) {
      // Not a row ID — treat `id` as a base book title.
      // Delete ALL chunks whose title starts with the base title.
      // This catches both "Book Title — Part 1/100" and "Book Title" (single chunk).
      // Use startsWith to match the base title prefix.
      result = await db.knowledge.deleteMany({
        where: {
          userId,
          OR: [
            { title: { equals: id } }, // exact title match (single-chunk books)
            { title: { startsWith: `${id} — Part` } }, // chunked books: "Book Title — Part N/M"
          ],
        },
      })
    }

    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true, deleted: result.count })
  } catch (err) {
    console.error('[knowledge.delete]', err)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
