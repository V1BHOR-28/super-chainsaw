/**
 * performWebSearch — shared web-search implementation.
 *
 * Extracted from chat/route.ts so both /api/chat and /api/search use the
 * same full-featured search: query reformulation (sports matchups), Tavily →
 * Serper → ESPN cascade, degradation-warning construction, and source
 * collection for the UI bar.
 *
 * Pure extraction — no behavior changes. Preserves all timeouts, result
 * counts, and degradation-warning wording.
 */

export type WebSearchSource = { title: string; url: string; host: string }

export type WebSearchResult = {
  resultsText: string
  sources: WebSearchSource[]
  degraded: boolean
}

export async function performWebSearch(
  query: string
): Promise<WebSearchResult> {
  const results: string[] = []
  const webSources: WebSearchSource[] = []
  let webProviderHit = false // true once Tavily OR Serper returns usable results

  const lowerContent = query.toLowerCase()
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const yearStr = String(now.getFullYear())

  // === SEARCH QUERY REFORMULATION ===
  const queries = new Set<string>([query])
  const matchup = query.match(
    /\b([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)\s+(?:vs?\.?|versus|v\.?)\s+([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)/i
  )
  if (matchup) {
    const teamA = matchup[1].trim()
    const teamB = matchup[2].trim()
    queries.add(`${teamA} vs ${teamB} result score winner ${yearStr}`)
    queries.add(`${teamA} ${teamB} match ${yearStr}`)
  }

  // Detect current-events / sports queries
  const sportsKeywords = ['match', 'matches', 'score', 'scores', 'game', 'games', 'fixture',
    'world cup', 'fifa', 'premier league', 'la liga', 'serie a', 'bundesliga',
    'champions league', 'nba', 'nfl', 'nhl', 'cricket', 'ipl', 'tennis',
    'football', 'soccer', 'basketball', 'happening today', 'playing today',
    'result today', 'kickoff', 'standings', 'tournament', 'vs', 'versus']
  const newsKeywords = ['news today', 'latest news', 'current events', 'what happened today',
    'today news', 'breaking', 'just happened', 'recent update', 'recently', 'last night']
  const isCurrentEvent =
    sportsKeywords.some((kw) => lowerContent.includes(kw)) ||
    newsKeywords.some((kw) => lowerContent.includes(kw))

  // === TAVILY SEARCH (primary) — run all reformulated queries in parallel ===
  const tavilyPromises = Array.from(queries)
    .slice(0, 3)
    .map(async (q) => {
      try {
        const body: Record<string, unknown> = {
          api_key: process.env.TAVILY_API_KEY,
          query: q,
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
          search_depth: 'basic',
        }
        if (isCurrentEvent) {
          body.topic = 'news'
          body.days = 14
        }
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    })

  const tavilyDatas = (await Promise.all(tavilyPromises)).filter(
    (d): d is Record<string, unknown> => d !== null
  )

  for (const tavilyData of tavilyDatas) {
    if (tavilyData.answer) {
      results.push(`Direct Answer: ${tavilyData.answer}`)
      webProviderHit = true
    }
    const res = tavilyData.results
    if (Array.isArray(res)) {
      for (const r of res.slice(0, 3)) {
        const item = r as { title?: string; content?: string; url?: string; published_date?: string }
        if (item.title && item.content) {
          const datePart = item.published_date
            ? ` [published ${String(item.published_date).slice(0, 10)}]`
            : ''
          results.push(`${item.title}${datePart}\n   ${item.content.slice(0, 200)}\n   URL: ${item.url || ''}`)
          webProviderHit = true
          if (item.url && webSources.length < 6) {
            try {
              webSources.push({
                title: item.title.slice(0, 60),
                url: item.url,
                host: new URL(item.url).hostname.replace(/^www\./, ''),
              })
            } catch {}
          }
        }
      }
    }
  }

  // === SERPER FALLBACK (only if Tavily returned nothing) ===
  if (results.length === 0) {
    try {
      const serperResponse = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: 6, tbs: isCurrentEvent ? 'qdr:w' : undefined }),
        signal: AbortSignal.timeout(8000),
      })

      if (serperResponse.ok) {
        const serperData = await serperResponse.json()

        if (serperData.knowledgeGraph?.description) {
          results.push(`${serperData.knowledgeGraph.title || 'Knowledge Graph'}: ${serperData.knowledgeGraph.description.slice(0, 300)}`)
          webProviderHit = true
        }

        if (serperData.organic && Array.isArray(serperData.organic)) {
          for (const r of serperData.organic.slice(0, 5)) {
            if (r.title) {
              results.push(`${r.title}\n   ${r.snippet || ''}\n   URL: ${r.link || ''}`)
              webProviderHit = true
              if (r.link && webSources.length < 6) {
                try {
                  webSources.push({
                    title: r.title.slice(0, 60),
                    url: r.link,
                    host: new URL(r.link).hostname.replace(/^www\./, ''),
                  })
                } catch {}
              }
            }
          }
        }
      }
    } catch (e2) {
      console.error('[web-search] Serper also failed:', e2)
    }
  }

  // === ESPN live + recent scores (for sports queries) ===
  if (isCurrentEvent && sportsKeywords.some((kw) => lowerContent.includes(kw))) {
    const espnDateRange = (() => {
      const fmt = (d: Date) =>
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 3)
      return `${fmt(start)}-${fmt(end)}`
    })()

    const espnLeagues: Array<{ name: string; url: string }> = []
    if (lowerContent.includes('fifa') || lowerContent.includes('world cup')) {
      espnLeagues.push({ name: 'FIFA World Cup', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('nba') || lowerContent.includes('basketball')) {
      espnLeagues.push({ name: 'NBA', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('nfl')) {
      espnLeagues.push({ name: 'NFL', url: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('premier league') || lowerContent.includes('epl')) {
      espnLeagues.push({ name: 'Premier League', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('la liga')) {
      espnLeagues.push({ name: 'La Liga', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('serie a')) {
      espnLeagues.push({ name: 'Serie A', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('bundesliga')) {
      espnLeagues.push({ name: 'Bundesliga', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard?dates=${espnDateRange}` })
    }
    if (lowerContent.includes('champions league')) {
      espnLeagues.push({ name: 'Champions League', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=${espnDateRange}` })
    }
    if (
      espnLeagues.length === 0 &&
      (lowerContent.includes('soccer') ||
        lowerContent.includes('football') ||
        lowerContent.includes('match') ||
        !!matchup)
    ) {
      espnLeagues.push({ name: 'International Friendlies', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.friendly/scoreboard?dates=${espnDateRange}` })
      espnLeagues.push({ name: 'FIFA World Cup', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${espnDateRange}` })
    }

    const espnPromises = espnLeagues.map(async (league) => {
      try {
        const response = await fetch(league.url, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) return null
        const data = await response.json()
        const events = data.events || []
        if (!Array.isArray(events) || events.length === 0) return null
        const matchLines = events
          .slice(0, 8)
          .map(
            (e: {
              name?: string
              date?: string
              status?: { type?: { description?: string; completed?: boolean } }
              competitions?: Array<{
                competitors?: Array<{ team?: { displayName?: string }; score?: string; homeAway?: string }>
              }>
            }) => {
              const status = e.status?.type?.description || 'Scheduled'
              const comps = e.competitions?.[0]?.competitors || []
              const sorted = [...comps].sort((a, b) =>
                (a.homeAway === 'home' ? 0 : 1) - (b.homeAway === 'home' ? 0 : 1)
              )
              const a = sorted[0]
              const b = sorted[1]
              const aName = a?.team?.displayName || ''
              const bName = b?.team?.displayName || ''
              const aScore = a?.score ?? '0'
              const bScore = b?.score ?? '0'
              return `  ${aName} ${aScore} - ${bScore} ${bName} (${status})`
            }
          )
        if (matchLines.length === 0) return null
        return `${league.name} (ESPN, last 3 days):\n${matchLines.join('\n')}`
      } catch {
        return null
      }
    })

    const espnResults = await Promise.all(espnPromises)
    for (const result of espnResults) {
      if (result) results.push(result)
    }
  }

  const degraded = !webProviderHit && results.length > 0

  if (results.length > 0) {
    const degradationWarning = degraded
      ? `\n\n⚠ DEGRADED SEARCH NOTICE: Both primary web search providers (Tavily + Serper) are unconfigured or failed. Only ESPN live-score data was retrieved — this is incomplete and may miss non-scheduled or recently-finished matches. You MUST tell the user your web search was limited to live scores only and you could not fully verify current information. Do NOT present this as a comprehensive web search.\n`
      : ''
    if (degraded) {
      console.warn('[web-search] DEGRADED: Tavily + Serper both failed/unconfigured. Check TAVILY_API_KEY and SERPER_API_KEY in .env. Only ESPN data available.')
    }
    return {
      resultsText: `[Internal note: the following is what a web search just returned for "${query}" — today is ${dateStr}.${degradationWarning}]\n${results.join('\n\n')}\n\nUse this information naturally in your reply. Never repeat this note or a heading like it.`,
      sources: webSources,
      degraded,
    }
  } else {
    console.warn('[web-search] No results from ANY provider (Tavily/Serper/ESPN all empty or failed). Check API keys in .env.')
    return {
      resultsText: `Web search returned no results for "${query}" (today is ${dateStr}). The search providers appear to be unconfigured. Answer from your own knowledge, but explicitly tell the user you could not verify current information online and that web search may be unavailable.`,
      sources: [],
      degraded: false,
    }
  }
}
