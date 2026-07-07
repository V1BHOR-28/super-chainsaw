import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/conversations — list all conversations for the default user
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const conversations = await db.conversation.findMany({
      where: { userId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      include: {
        _count: { select: { messages: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, createdAt: true },
        },
      },
    })

    return NextResponse.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        pinned: c.pinned,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        messageCount: c._count.messages,
        preview: c.messages[0]?.content?.slice(0, 120) ?? '',
      })),
    })
  } catch (err) {
    console.error('[conversations.list]', err)
    return NextResponse.json({ error: 'Failed to load conversations' }, { status: 500 })
  }
}

/**
 * POST /api/conversations — create a new conversation
 * Body: { title?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const title = (body.title as string)?.trim() || 'New Conversation'

    const conversation = await db.conversation.create({
      data: { title, userId },
    })

    return NextResponse.json({ conversation })
  } catch (err) {
    console.error('[conversations.create]', err)
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }
}
