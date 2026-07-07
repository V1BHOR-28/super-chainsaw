import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * PATCH /api/reminders/[id] — toggle complete, edit title/dueAt
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

    const data: { title?: string; dueAt?: Date | null; completed?: boolean; completedAt?: Date | null } = {}
    if (typeof body.title === 'string') data.title = body.title.slice(0, 200)
    if (body.dueAt !== undefined) {
      data.dueAt = body.dueAt ? new Date(body.dueAt) : null
    }
    if (typeof body.completed === 'boolean') {
      data.completed = body.completed
      data.completedAt = body.completed ? new Date() : null
    }

    const result = await db.reminder.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[reminders.patch]', err)
    return NextResponse.json({ error: 'Failed to update reminder' }, { status: 500 })
  }
}

/**
 * DELETE /api/reminders/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const result = await db.reminder.deleteMany({ where: { id, userId } })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[reminders.delete]', err)
    return NextResponse.json({ error: 'Failed to delete reminder' }, { status: 500 })
  }
}
