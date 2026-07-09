import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/search?q=<query>
 * Uses DuckDuckGo HTML scraping — returns real search results.
 * Free, no key, works on Vercel.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    })

    if (!response.ok) {
      return NextResponse.json({ error: 'Web search failed' }, { status: 502 })
    }

    const html = await response.text()

    // Parse results from DuckDuckGo HTML
    const titleMatches = [...html.matchAll(/class="result__a"[^>]*>([^<]*)/g)]
    const urlMatches = [...html.matchAll(/class="result__url"[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^&"]*)/g)]
    const snippetMatches = [...html.matchAll(/class="result__snippet">([^<]*)/g)]

    const results: Array<{ url: string; name: string; snippet: string; host_name: string }> = []
    const count = Math.min(titleMatches.length, 8)

    for (let i = 0; i < count; i++) {
      const title = titleMatches[i]?.[1]?.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim() || ''
      const urlEncoded = urlMatches[i]?.[1] || ''
      const url = decodeURIComponent(urlEncoded)
      const snippet = snippetMatches[i]?.[1]?.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim() || ''

      if (title && url) {
        let hostName = ''
        try {
          hostName = new URL(url).hostname
        } catch {
          hostName = ''
        }
        results.push({ url, name: title, snippet, host_name: hostName })
      }
    }

    return NextResponse.json({ query: q, results })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
