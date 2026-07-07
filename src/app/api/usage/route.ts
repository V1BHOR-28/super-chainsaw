import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getTodayUsage } from '@/lib/usage'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/usage — returns today's token usage, the daily limit, and when it resets.
 * Requires authentication.
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const usage = await getTodayUsage()
    return NextResponse.json({ usage })
  } catch (err) {
    console.error('[usage.get]', err)
    return NextResponse.json({ error: 'Failed to load usage' }, { status: 500 })
  }
}
