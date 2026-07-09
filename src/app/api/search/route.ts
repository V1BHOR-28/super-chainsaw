import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/search?q=<query>
 * Uses Tavily (primary) → Serper (fallback) for real web search.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    // Try Tavily first
    try {
      const tavilyResponse = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: q,
          max_results: 5,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(10000),
      })

      if (tavilyResponse.ok) {
        const data = await tavilyResponse.json()
        const results = (data.results || []).map((r: { title: string; content: string; url: string }) => ({
          name: r.title,
          snippet: r.content?.slice(0, 200) || '',
          url: r.url,
          host_name: (() => { try { return new URL(r.url).hostname } catch { return '' } })(),
        }))
        return NextResponse.json({ query: q, results })
      }
    } catch {
      // Fall through to Serper
    }

    // Fallback: Serper
    const serperResponse = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q, num: 5 }),
      signal: AbortSignal.timeout(8000),
    })

    if (!serperResponse.ok) {
      return NextResponse.json({ error: 'Web search failed' }, { status: 502 })
    }

    const serperData = await serperResponse.json()
    const results = (serperData.organic || []).map((r: { title: string; snippet: string; link: string }) => ({
      name: r.title,
      snippet: r.snippet || '',
      url: r.link,
      host_name: (() => { try { return new URL(r.link).hostname } catch { return '' } })(),
    }))

    return NextResponse.json({ query: q, results })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
