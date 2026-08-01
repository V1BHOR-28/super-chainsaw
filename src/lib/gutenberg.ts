/**
 * checkGutenbergAvailability — looks up whether a book is available on
 * Project Gutenberg (which only hosts public-domain texts — if it's there,
 * it's legally free to use; if it's not, treat it as copyrighted/unavailable
 * and don't attempt to source full text from anywhere else).
 *
 * Uses the free, public Gutendex API (no key required).
 * Hardened: scans all results (not just the first) for a usable plain-text
 * format, filters by title relevance before accepting a candidate (prevents
 * silently matching an unrelated but popular book like Moby Dick to a
 * Pride and Prejudice query), and falls back to a title-only search if the
 * combined title+author query returns no usable match.
 */

/**
 * normalize — lowercase, strip punctuation/articles, collapse whitespace.
 * Used to compare titles/authors loosely without exact-string brittleness.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * isRelevantMatch — true if the candidate's title is a reasonably close
 * match to the requested title (handles subtitles like "Pride and
 * Prejudice: A Novel" or "Moby Dick; Or, The Whale" matching "Moby Dick").
 * This is deliberately loose (substring, either direction) rather than
 * exact — Gutendex titles often carry extra subtitle text the LLM's
 * suggested title won't include, and vice versa.
 */
function isRelevantMatch(requestedTitle: string, candidateTitle: string): boolean {
  const req = normalize(requestedTitle)
  const cand = normalize(candidateTitle)
  if (!req || !cand) return false
  return cand.includes(req) || req.includes(cand)
}

export async function checkGutenbergAvailability(
  title: string,
  author: string
): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const query = encodeURIComponent(`${title} ${author}`)
    const res = await fetch(`https://gutendex.com/books?search=${query}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.log(`[gutenberg] fetch failed: ${res.status}`)
      return { available: false }
    }
    const data = await res.json()
    const results = data.results as Array<{
      title: string
      authors: Array<{ name: string }>
      formats: Record<string, string>
    }>
    if (!results || results.length === 0) {
      console.log(`[gutenberg] search="${title} ${author}" → 0 results, trying title-only`)
      return await searchByTitleOnly(title)
    }

    // Only consider candidates whose title actually resembles what was asked for —
    // this is the critical fix. Without this filter, an unrelated but popular book
    // with a text/plain format (e.g. Moby Dick) can get matched to any query.
    const relevantCandidates = results.filter(c => isRelevantMatch(title, c.title))

    for (const candidate of relevantCandidates) {
      const textUrl =
        candidate.formats['text/plain; charset=utf-8'] ||
        candidate.formats['text/plain'] ||
        Object.entries(candidate.formats).find(([k]) => k.startsWith('text/plain'))?.[1]
      if (textUrl) {
        console.log(`[gutenberg] search="${title} ${author}" → matched "${candidate.title}"`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }

    console.log(`[gutenberg] search="${title} ${author}" → ${results.length} results, ${relevantCandidates.length} relevant, none had text/plain — trying title-only`)
    return await searchByTitleOnly(title)
  } catch (err) {
    console.error('[gutenberg]', err)
    return { available: false }
  }
}

async function searchByTitleOnly(title: string): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const res = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(title)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { available: false }
    const data = await res.json()
    const results = data.results as Array<{ title: string; formats: Record<string, string> }>
    if (!results || results.length === 0) {
      console.log(`[gutenberg] title-only search="${title}" → 0 results`)
      return { available: false }
    }

    const relevantCandidates = results.filter(c => isRelevantMatch(title, c.title))

    for (const candidate of relevantCandidates) {
      const textUrl =
        candidate.formats['text/plain; charset=utf-8'] ||
        candidate.formats['text/plain'] ||
        Object.entries(candidate.formats).find(([k]) => k.startsWith('text/plain'))?.[1]
      if (textUrl) {
        console.log(`[gutenberg] title-only search="${title}" → matched "${candidate.title}"`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }
    console.log(`[gutenberg] title-only search="${title}" → ${results.length} results, ${relevantCandidates.length} relevant, none had text/plain`)
    return { available: false }
  } catch (err) {
    console.error('[gutenberg.titleOnly]', err)
    return { available: false }
  }
}
