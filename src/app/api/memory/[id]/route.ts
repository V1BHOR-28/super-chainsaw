import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * PATCH /api/memory/[id] — update content/category/pinned
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))

    const data: { content?: string; category?: string; pinned?: boolean } = {}
    if (typeof body.content === 'string') data.content = body.content.slice(0, 1000)
    if (typeof body.category === 'string') data.category = body.category.slice(0, 40)
    if (typeof body.pinned === 'boolean') data.pinned = body.pinned

    const result = await db.memory.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[memory.patch]', err)
    return NextResponse.json({ error: 'Failed to update memory' }, { status: 500 })
  }
}

/**
 * DELETE /api/memory/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const result = await db.memory.deleteMany({ where: { id, userId } })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[memory.delete]', err)
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 })
  }
}
