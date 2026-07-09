import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/search?q=<query>
 * Uses Wikipedia API — free, no key, works on Vercel.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    // Wikipedia search
    const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5`
    const wikiResponse = await fetch(wikiSearchUrl, {
      headers: { 'User-Agent': 'ARIA/1.0 (https://ariav2-seven.vercel.app)' },
      signal: AbortSignal.timeout(8000),
    })

    if (!wikiResponse.ok) {
      return NextResponse.json({ error: 'Web search failed' }, { status: 502 })
    }

    const wikiData = await wikiResponse.json()
    const wikiResults = wikiData?.query?.search || []

    // Fetch summaries in parallel
    const summaryPromises = wikiResults.slice(0, 5).map(async (result: { title: string }) => {
      const title = result.title
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
      try {
        const summaryResponse = await fetch(summaryUrl, {
          headers: { 'User-Agent': 'ARIA/1.0 (https://ariav2-seven.vercel.app)' },
          signal: AbortSignal.timeout(5000),
        })
        if (summaryResponse.ok) {
          const summaryData = await summaryResponse.json()
          return {
            url: summaryData.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
            name: title,
            snippet: summaryData.extract || '',
            host_name: 'en.wikipedia.org',
          }
        }
      } catch {
        // skip
      }
      return null
    })

    const summaries = await Promise.all(summaryPromises)
    const results = summaries.filter((s): s is { url: string; name: string; snippet: string; host_name: string } => s !== null)

    return NextResponse.json({ query: q, results })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
