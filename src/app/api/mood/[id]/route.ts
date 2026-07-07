import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * PATCH /api/mood/[id] — update the note on a mood entry
 * Body: { note?: string }
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

    const data: { note?: string | null } = {}
    if (typeof body.note === 'string') {
      data.note = body.note.trim().slice(0, 500) || null
    }

    const result = await db.mood.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mood.patch]', err)
    return NextResponse.json({ error: 'Failed to update mood entry' }, { status: 500 })
  }
}

/**
 * DELETE /api/mood/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const result = await db.mood.deleteMany({ where: { id, userId } })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mood.delete]', err)
    return NextResponse.json({ error: 'Failed to delete mood entry' }, { status: 500 })
  }
}
