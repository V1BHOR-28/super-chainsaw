import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/conversations/[id] — fetch one conversation with all messages
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const conversation = await db.conversation.findFirst({
      where: { id, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })

    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ conversation })
  } catch (err) {
    console.error('[conversations.get]', err)
    return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
  }
}

/**
 * PATCH /api/conversations/[id] — update title or pinned state
 * Body: { title?: string, pinned?: boolean }
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

    const data: { title?: string; pinned?: boolean } = {}
    if (typeof body.title === 'string') data.title = body.title.slice(0, 120)
    if (typeof body.pinned === 'boolean') data.pinned = body.pinned

    const conversation = await db.conversation.updateMany({
      where: { id, userId },
      data,
    })

    if (conversation.count === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[conversations.patch]', err)
    return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 })
  }
}

/**
 * DELETE /api/conversations/[id] — delete conversation + all messages (cascade)
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const result = await db.conversation.deleteMany({
      where: { id, userId },
    })

    if (result.count === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[conversations.delete]', err)
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 })
  }
}
