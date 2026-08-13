import { describe, it, expect } from 'vitest'
import { chunkText, extractKeywords } from '@/lib/chunk-text'

describe('chunkText', () => {
  it('returns at least one chunk for empty input (does not return [])', () => {
    // The contract is: never return an empty array — callers rely on at least
    // one chunk to embed. Empty input → one chunk of empty/sliced text.
    const result = chunkText('')
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('splits text on paragraph boundaries (\\n\\n)', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.'
    const result = chunkText(text)
    // Small paragraphs fit in a single chunk; we expect them merged.
    expect(result.length).toBe(1)
    expect(result[0]).toContain('Para one.')
    expect(result[0]).toContain('Para two.')
    expect(result[0]).toContain('Para three.')
  })

  it('splits when a paragraph would exceed targetSize', () => {
    // Generate ~5000 chars across 5 paragraphs of 1000 chars each.
    const para = 'x'.repeat(1000)
    const text = [para, para, para, para, para].join('\n\n')
    const result = chunkText(text, 3000, 200)
    // At ~1000 chars per paragraph and a 3000-char target, we expect 2 chunks
    // (3 paras in first, 2 in second, roughly).
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('preserves overlap between adjacent chunks', () => {
    // Build text where chunk 1 ends with a known suffix that should appear
    // at the start of chunk 2 (within the overlap window).
    const paraA = 'A'.repeat(2900) // fits in chunk 1, leaves room
    const paraB = 'B'.repeat(2900) // forces a new chunk
    const text = `${paraA}\n\n${paraB}`
    const result = chunkText(text, 3000, 200)
    expect(result.length).toBe(2)
    // The overlap is the last 200 chars of the previous current buffer —
    // that means chunk 2 should start with 'A's (the overlap), then 'B's.
    expect(result[1].startsWith('A')).toBe(true)
    // And it should contain the new content.
    expect(result[1]).toContain('B')
  })

  it('falls back to sentence splitting for huge single paragraphs', () => {
    // A single paragraph with no \n\n break that exceeds 1.5× targetSize.
    const sentence = 'This is a sentence. '
    const huge = sentence.repeat(300) // ~6000 chars, no \n\n
    const result = chunkText(huge, 3000, 200)
    expect(result.length).toBeGreaterThan(1)
    // Every chunk should respect the soft target (with some tolerance).
    for (const chunk of result) {
      expect(chunk.length).toBeLessThan(4500)
    }
  })

  it('returns the full string as one chunk when input has no breaks and no sentence punctuation', () => {
    // KNOWN LIMITATION (documented, not fixed yet):
    // A 10000-char string of 'x' has no \n\n (so no paragraph split) and no
    // [.!?] (so no sentence split). The sentence-split fallback yields a single
    // "sentence" equal to the whole input, which then becomes one giant chunk
    // — the `text.slice(0, targetSize)` final-return only fires when
    // `finalChunks.length === 0`, which can't happen for non-empty input.
    //
    // This means a degenerate input (long, no whitespace, no punctuation)
    // produces a single chunk larger than targetSize. Acceptable for now
    // because real EPUB text always has both — but flagging it here so the
    // limitation is visible to anyone who runs the tests.
    const text = 'x'.repeat(10000)
    const result = chunkText(text, 3000, 200)
    expect(result.length).toBe(1)
    expect(result[0].length).toBe(10000)
  })
})

describe('extractKeywords', () => {
  it('returns lowercase keywords', () => {
    const result = extractKeywords('Hello WORLD Foo BAR')
    expect(result).toEqual(expect.arrayContaining(['hello', 'world', 'foo', 'bar']))
  })

  it('filters out stopwords', () => {
    // "the", "what", "are" are all in the stopword set.
    const result = extractKeywords('What is the weather today')
    expect(result).not.toContain('what')
    expect(result).not.toContain('the')
    // "weather" and "today" should survive (longer than 2 chars, not stopwords).
    expect(result).toContain('weather')
    expect(result).toContain('today')
  })

  it('filters out words shorter than 3 characters', () => {
    const result = extractKeywords('a hi be go running')
    expect(result).not.toContain('a')
    expect(result).not.toContain('hi')
    expect(result).not.toContain('be')
    expect(result).not.toContain('go')
    expect(result).toContain('running')
  })

  it('strips non-alphanumeric characters before splitting', () => {
    const result = extractKeywords('Hello, world! Foo-bar baz.')
    expect(result).toEqual(expect.arrayContaining(['hello', 'world', 'foo', 'bar', 'baz']))
  })

  it('caps the result at 8 keywords', () => {
    const result = extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo')
    expect(result.length).toBeLessThanOrEqual(8)
  })

  it('returns [] for empty or stopword-only input', () => {
    expect(extractKeywords('')).toEqual([])
    expect(extractKeywords('the and was')).toEqual([])
  })
})
