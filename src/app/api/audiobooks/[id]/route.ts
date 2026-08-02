import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * DELETE /api/audiobooks/[id] — delete an audiobook (ownership-checked).
 * Does NOT delete the underlying Knowledge rows — those are the source text
 * and may still be useful for chat RAG. Only the Audiobook metadata is removed.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const result = await db.audiobook.deleteMany({ where: { id, userId } })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[audiobooks.delete]', err)
    return NextResponse.json({ error: 'Failed to delete audiobook' }, { status: 500 })
  }
}

/**
 * PATCH /api/audiobooks/[id] — save playback progress.
 * Called periodically by the player so progress survives across devices/sessions.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const data: { progressChapter?: number; progressCharOffset?: number } = {}

    if (typeof body.progressChapter === 'number' && body.progressChapter >= 0) {
      data.progressChapter = Math.floor(body.progressChapter)
    }
    if (typeof body.progressCharOffset === 'number' && body.progressCharOffset >= 0) {
      data.progressCharOffset = Math.floor(body.progressCharOffset)
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const result = await db.audiobook.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[audiobooks.patch]', err)
    return NextResponse.json({ error: 'Failed to update progress' }, { status: 500 })
  }
}
