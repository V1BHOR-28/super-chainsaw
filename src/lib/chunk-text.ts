/**
 * Shared text chunking logic — used by both the client (browser PDF parser)
 * and the server (knowledge upload route).
 *
 * Splits text into ~3000-char chunks at paragraph boundaries, with 200-char
 * overlap for context continuity. Each chunk is stored as a separate Knowledge
 * row with its own embedding, so semantic search finds the right section from
 * anywhere in a 3000-page book.
 */

const TARGET_CHUNK_SIZE = 3000
const OVERLAP = 200

export function chunkText(text: string, targetSize = TARGET_CHUNK_SIZE, overlap = OVERLAP): string[] {
  // Split on double newlines (paragraph boundaries)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length > targetSize && current.length > 0) {
      chunks.push(current.trim())
      // Start next chunk with overlap (last N chars of previous)
      current = current.slice(-overlap) + '\n\n' + para
    } else {
      current = current ? current + '\n\n' + para : para
    }
  }
  if (current.trim()) chunks.push(current.trim())

  // If a single paragraph is huge (no \n\n breaks), split by sentence
  const finalChunks: string[] = []
  for (const chunk of chunks) {
    if (chunk.length <= targetSize * 1.5) {
      finalChunks.push(chunk)
    } else {
      const sentences = chunk.match(/[^.!?]+[.!?]+/g) || [chunk]
      let s = ''
      for (const sent of sentences) {
        if (s.length + sent.length > targetSize && s.length > 0) {
          finalChunks.push(s.trim())
          s = sent
        } else {
          s += sent
        }
      }
      if (s.trim()) finalChunks.push(s.trim())
    }
  }

  return finalChunks.length > 0 ? finalChunks : [text.slice(0, targetSize)]
}

const STOPWORDS = new Set([
  'what', 'how', 'when', 'where', 'which', 'think', 'about', 'does', 'will',
  'would', 'could', 'should', 'there', 'their', 'the', 'and', 'for', 'are',
  'was', 'were', 'has', 'have', 'his', 'her', 'its', 'from', 'this', 'that',
  'with', 'but', 'not', 'you', 'all', 'can', 'had', 'one', 'our', 'out', 'day',
  'get', 'him', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'let',
  'say', 'she', 'too', 'use', 'the', 'over', 'last', 'past', 'been', 'feeling',
  'year', 'years', 'old', 'male', 'female', 'patient', 'history', 'present',
  'illness', 'chief', 'complaint', 'vital', 'signs', 'general', 'exam',
  'physical', 'notes', 'requires', 'noted', 'also', 'two', 'three', 'mild',
  'moderate', 'severe', 'right', 'left', 'bilateral', 'without', 'upon',
  'reported', 'denies', 'month', 'months', 'week', 'weeks', 'following',
])

/**
 * Extract distinctive keywords from a text string, filtering out common English
 * stop words + medical filler. Shared between the keyword-fallback search and
 * the knowledge-context truncation logic so they use the same definition of
 * "what words matter in this query."
 *
 * Returns up to 8 lowercased keywords, each longer than 2 characters.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8)
}
