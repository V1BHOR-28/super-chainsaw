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
