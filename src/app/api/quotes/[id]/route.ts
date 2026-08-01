import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * DELETE /api/quotes/[id] — delete a quote. Ownership-checked.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const result = await db.quote.deleteMany({ where: { id, userId } })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[quotes.delete]', err)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
