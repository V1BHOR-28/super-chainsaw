/**
 * checkGutenbergAvailability — looks up whether a book is available on
 * Project Gutenberg (which only hosts public-domain texts — if it's there,
 * it's legally free to use; if it's not, treat it as copyrighted/unavailable
 * and don't attempt to source full text from anywhere else).
 *
 * Uses the free, public Gutendex API (no key required) rather than scraping
 * Gutenberg's site directly.
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
    if (!results || results.length === 0) return { available: false }

    // Take the first result as the best match — Gutendex's search is already
    // relevance-ranked. Prefer a plain-text format for easy ingestion.
    const best = results[0]
    const textUrl =
      best.formats['text/plain; charset=utf-8'] ||
      best.formats['text/plain'] ||
      Object.entries(best.formats).find(([k]) => k.startsWith('text/plain'))?.[1]

    if (!textUrl) return { available: false }

    return { available: true, downloadUrl: textUrl, matchedTitle: best.title }
  } catch (err) {
    console.error('[gutenberg]', err)
    return { available: false }
  }
}
