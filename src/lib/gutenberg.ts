/**
 * checkGutenbergAvailability — looks up whether a book is available on
 * Project Gutenberg (which only hosts public-domain texts — if it's there,
 * it's legally free to use; if it's not, treat it as copyrighted/unavailable
 * and don't attempt to source full text from anywhere else).
 *
 * Uses the free, public Gutendex API (no key required).
 * Hardened: scans all results (not just the first) for a usable plain-text
 * format, and falls back to a title-only search if the combined title+author
 * query returns no usable match (common when author name format differs,
 * e.g. "Dostoevsky" vs Gutendex's "Dostoyevsky, Fyodor").
 */
export async function checkGutenbergAvailability(
  title: string,
  author: string
): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const query = encodeURIComponent(`${title} ${author}`)
    const res = await fetch(`https://gutendex.com/books?search=${query}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { available: false }
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

    // Scan all results (not just the first) for one with a usable plain-text format.
    for (const candidate of results) {
      const textUrl =
        candidate.formats['text/plain; charset=utf-8'] ||
        candidate.formats['text/plain'] ||
        Object.entries(candidate.formats).find(([k]) => k.startsWith('text/plain'))?.[1]
      if (textUrl) {
        console.log(`[gutenberg] search="${title} ${author}" → ${results.length} results, match="${candidate.title}"`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }

    // Results existed but none had plain text — try title-only as a last resort
    console.log(`[gutenberg] search="${title} ${author}" → ${results.length} results, no plain-text format, trying title-only`)
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
    for (const candidate of results) {
      const textUrl =
        candidate.formats['text/plain; charset=utf-8'] ||
        candidate.formats['text/plain'] ||
        Object.entries(candidate.formats).find(([k]) => k.startsWith('text/plain'))?.[1]
      if (textUrl) {
        console.log(`[gutenberg] title-only search="${title}" → ${results.length} results, match="${candidate.title}"`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }
    console.log(`[gutenberg] title-only search="${title}" → ${results.length} results, no plain-text format`)
    return { available: false }
  } catch (err) {
    console.error('[gutenberg.titleOnly]', err)
    return { available: false }
  }
}
