import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/memory/decision
 * Body: { candidateText: string, category: string, accepted: boolean }
 *
 * Logs a memory decision so ARIA learns the user's saving pattern.
 * Called when the user clicks Save or Skip on a memory ask card.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const candidateText = (body.candidateText as string)?.trim()
    const accepted = !!body.accepted
    const category = (body.category as string)?.slice(0, 40) || 'general'

    if (!candidateText) {
      return NextResponse.json({ error: 'candidateText required' }, { status: 400 })
    }

    const decision = await db.memoryDecision.create({
      data: {
        userId,
        candidateText: candidateText.slice(0, 300),
        category,
        accepted,
      },
    })

    return NextResponse.json({ decision })
  } catch (err) {
    console.error('[memory.decision]', err)
    return NextResponse.json({ error: 'Failed to log decision' }, { status: 500 })
  }
}
