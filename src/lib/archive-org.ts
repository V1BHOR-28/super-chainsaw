/**
 * checkArchiveOrgAvailability — looks up whether a book is available on the
 * Internet Archive as a text item (OCR'd _djvu.txt). Archive.org is built
 * for reliable programmatic access, unlike Gutendex/Gutenberg which had
 * bot-blocking and uptime issues from Vercel's datacenter IPs.
 *
 * Uses the free, public Archive.org Advanced Search API (no key required).
 * Verifies the text file actually exists via HEAD request before returning
 * it — not every archive.org item has an OCR'd _djvu.txt file.
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
 * exact — archive.org titles often carry extra subtitle text the LLM's
 * suggested title won't include, and vice versa.
 */
function isRelevantMatch(requestedTitle: string, candidateTitle: string): boolean {
  const req = normalize(requestedTitle)
  const cand = normalize(candidateTitle)
  if (!req || !cand) return false
  return cand.includes(req) || req.includes(cand)
}

export async function checkArchiveOrgAvailability(
  title: string,
  author: string
): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const query = `title:(${JSON.stringify(title)}) AND creator:(${JSON.stringify(author)}) AND mediatype:texts`
    const res = await fetch(
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=10&output=json`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) {
      console.log(`[archive-org] fetch failed: ${res.status}`)
      return { available: false }
    }
    const data = await res.json()
    const docs = data?.response?.docs as Array<{ identifier: string; title: string }> | undefined
    if (!docs || docs.length === 0) {
      console.log(`[archive-org] search title="${title}" author="${author}" → 0 results, trying title-only`)
      return await searchByTitleOnly(title)
    }

    const relevant = docs.filter(d => isRelevantMatch(title, d.title))

    for (const candidate of relevant) {
      const textUrl = `https://archive.org/download/${candidate.identifier}/${candidate.identifier}_djvu.txt`
      // Verify the text file actually exists before returning it — not every
      // archive.org item has an OCR'd _djvu.txt file (some are image-only scans).
      const head = await fetch(textUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (head?.ok) {
        console.log(`[archive-org] matched "${candidate.title}" (${candidate.identifier})`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }

    console.log(`[archive-org] ${docs.length} results, ${relevant.length} relevant, none had a usable text file — trying title-only`)
    return await searchByTitleOnly(title)
  } catch (err) {
    console.error('[archive-org]', err)
    return { available: false }
  }
}

async function searchByTitleOnly(title: string): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const query = `title:(${JSON.stringify(title)}) AND mediatype:texts`
    const res = await fetch(
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&rows=10&output=json`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return { available: false }
    const data = await res.json()
    const docs = data?.response?.docs as Array<{ identifier: string; title: string }> | undefined
    if (!docs || docs.length === 0) {
      console.log(`[archive-org] title-only search="${title}" → 0 results`)
      return { available: false }
    }

    const relevant = docs.filter(d => isRelevantMatch(title, d.title))

    for (const candidate of relevant) {
      const textUrl = `https://archive.org/download/${candidate.identifier}/${candidate.identifier}_djvu.txt`
      const head = await fetch(textUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (head?.ok) {
        console.log(`[archive-org] title-only search="${title}" → matched "${candidate.title}" (${candidate.identifier})`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }
    console.log(`[archive-org] title-only search="${title}" → ${docs.length} results, ${relevant.length} relevant, none had a usable text file`)
    return { available: false }
  } catch (err) {
    console.error('[archive-org.titleOnly]', err)
    return { available: false }
  }
}
