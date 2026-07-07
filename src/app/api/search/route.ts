import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/aria'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/search?q=<query>&num=<n>
 * Requires authentication.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    const num = Math.min(parseInt(searchParams.get('num') || '6', 10) || 6, 20)

    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    const zai = await getZAI()
    const results = await zai.functions.invoke('web_search', { query: q, num })

    return NextResponse.json({
      query: q,
      results: (results as Array<Record<string, unknown>>).map((r) => ({
        url: r.url,
        name: r.name,
        snippet: r.snippet,
        host_name: r.host_name,
        date: r.date,
        favicon: r.favicon,
      })),
    })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
