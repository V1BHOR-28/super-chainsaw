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
 * match to the requested title. Uses whole-word containment (not raw
 * substring) with a length-ratio guard to prevent short generic titles
 * (e.g. "plague") from false-positive matching long unrelated subtitles
 * that happen to contain the word somewhere.
 */
function isRelevantMatch(requestedTitle: string, candidateTitle: string): boolean {
  const req = normalize(requestedTitle)
  const cand = normalize(candidateTitle)
  if (!req || !cand) return false

  // Reject if either side is a tiny fraction of the other's length — a 6-character
  // title should not "relevantly match" a 200-character antique subtitle just
  // because the word appears somewhere inside it.
  const lengthRatio = Math.min(req.length, cand.length) / Math.max(req.length, cand.length)
  if (lengthRatio < 0.5) return false

  // Whole-word containment, not raw substring — "plague" must appear as its own
  // word, not as part of a match that happens to include the token anywhere.
  const reqWords = req.split(' ')
  const candWords = cand.split(' ')
  const reqInCand = reqWords.every(w => candWords.includes(w))
  const candInReq = candWords.every(w => reqWords.includes(w))
  return reqInCand || candInReq
}

/**
 * authorMatches — loose check that the candidate's creator field has some
 * relationship to the requested author. Uses the last name (last word of
 * the normalized author string) as the discriminator, since first names
 * and initials vary widely across catalog conventions.
 */
function authorMatches(requestedAuthor: string, candidateCreator: string | string[] | undefined): boolean {
  if (!candidateCreator) return false
  const creatorStr = Array.isArray(candidateCreator) ? candidateCreator.join(' ') : candidateCreator
  const reqNorm = normalize(requestedAuthor)
  const candNorm = normalize(creatorStr)
  if (!reqNorm || !candNorm) return false
  // Last name = last word of the normalized author string
  const lastName = reqNorm.split(' ').pop()
  if (!lastName || lastName.length < 3) return false
  return candNorm.split(' ').includes(lastName)
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
    const docs = data?.response?.docs as Array<{ identifier: string; title: string; creator?: string | string[] }> | undefined
    if (!docs || docs.length === 0) {
      console.log(`[archive-org] search title="${title}" author="${author}" → 0 results, trying title-only`)
      return await searchByTitleOnly(title, author)
    }

    const relevant = docs.filter(d => isRelevantMatch(title, d.title))

    for (const candidate of relevant) {
      const textUrl = `https://archive.org/download/${candidate.identifier}/${candidate.identifier}_djvu.txt`
      const head = await fetch(textUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (head?.ok) {
        console.log(`[archive-org] matched "${candidate.title}" (${candidate.identifier})`)
        return { available: true, downloadUrl: textUrl, matchedTitle: candidate.title }
      }
    }

    console.log(`[archive-org] ${docs.length} results, ${relevant.length} relevant, none had a usable text file — trying title-only`)
    return await searchByTitleOnly(title, author)
  } catch (err) {
    console.error('[archive-org]', err)
    return { available: false }
  }
}

async function searchByTitleOnly(title: string, author: string): Promise<{ available: boolean; downloadUrl?: string; matchedTitle?: string }> {
  try {
    const query = `title:(${JSON.stringify(title)}) AND mediatype:texts`
    const res = await fetch(
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=10&output=json`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return { available: false }
    const data = await res.json()
    const docs = data?.response?.docs as Array<{ identifier: string; title: string; creator?: string | string[] }> | undefined
    if (!docs || docs.length === 0) {
      console.log(`[archive-org] title-only search="${title}" → 0 results`)
      return { available: false }
    }

    const relevant = docs.filter(d => isRelevantMatch(title, d.title))

    for (const candidate of relevant) {
      // Author check: require the last name to appear in the creator field.
      // If creator is missing entirely, don't hard-block but log it.
      if (candidate.creator && !authorMatches(author, candidate.creator)) {
        console.log(`[archive-org] title-only: rejected "${candidate.title}" — author mismatch (requested "${author}", creator "${candidate.creator}")`)
        continue
      }
      if (!candidate.creator) {
        console.log(`[archive-org] title-only: accepting "${candidate.title}" with no creator field (author-unverified)`)
      }

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
