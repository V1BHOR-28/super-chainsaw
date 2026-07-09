import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/search?q=<query>&num=<n>
 * Uses DuckDuckGo Instant Answer API — free, no key, works on Vercel.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 })

    // DuckDuckGo Instant Answer API
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
    const response = await fetch(searchUrl)

    if (!response.ok) {
      return NextResponse.json({ error: 'Web search failed' }, { status: 502 })
    }

    const data = await response.json()
    const results: Array<{ url: string; name: string; snippet: string; host_name: string; date?: string }> = []

    // Main answer
    if (data.AbstractText) {
      results.push({
        url: data.AbstractURL || '',
        name: data.Heading || 'Instant Answer',
        snippet: data.AbstractText,
        host_name: data.AbstractSource || 'DuckDuckGo',
      })
    }

    // Related topics
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 8)) {
        if (topic.Text && topic.FirstURL) {
          const url = new URL(topic.FirstURL)
          results.push({
            url: topic.FirstURL,
            name: topic.Text.split(' - ')[0] || topic.Text.slice(0, 80),
            snippet: topic.Text,
            host_name: url.hostname,
          })
        } else if (topic.Topics && Array.isArray(topic.Topics)) {
          for (const subTopic of topic.Topics.slice(0, 3)) {
            if (subTopic.Text && subTopic.FirstURL) {
              const url = new URL(subTopic.FirstURL)
              results.push({
                url: subTopic.FirstURL,
                name: subTopic.Text.split(' - ')[0] || subTopic.Text.slice(0, 80),
                snippet: subTopic.Text,
                host_name: url.hostname,
              })
            }
          }
        }
      }
    }

    return NextResponse.json({ query: q, results })
  } catch (err) {
    console.error('[search]', err)
    return NextResponse.json({ error: 'Web search failed' }, { status: 500 })
  }
}
