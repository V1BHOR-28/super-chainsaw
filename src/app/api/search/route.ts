import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'
import { performWebSearch } from '@/lib/web-search'

/**
 * GET /api/search?q=<query>
 *
 * Uses the shared performWebSearch() function — same full-featured search
 * as /api/chat: query reformulation (sports matchups), Tavily → Serper →
 * ESPN cascade, degradation-warning construction, and source collection.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    const searchResult = await performWebSearch(q)

    // Map the shared result format to the existing /api/search response shape
    const results = searchResult.sources.map((s) => ({
      name: s.title,
      snippet: '',
      url: s.url,
      host_name: s.host,
    }))

    return NextResponse.json({
      query: q,
      results,
      degraded: searchResult.degraded,
    })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
