import { describe, it, expect } from 'vitest'
import { deriveChapters } from '@/lib/audiobook-chapters'

describe('deriveChapters', () => {
  it('detects "Chapter N" headings and splits at each', () => {
    const text = [
      'Chapter 1',
      'It was a bright cold morning.',
      'Chapter 2',
      'The second chapter began.',
      'Chapter 3',
      'Final chapter content here.',
    ].join('\n')
    const chapters = deriveChapters(text)
    expect(chapters).toHaveLength(3)
    expect(chapters[0].title).toMatch(/Chapter 1/)
    expect(chapters[0].text).toContain('bright cold morning')
    expect(chapters[1].title).toMatch(/Chapter 2/)
    expect(chapters[1].text).toContain('second chapter began')
    expect(chapters[2].title).toMatch(/Chapter 3/)
  })

  it('detects Roman-numeral chapter headings (Chapter IV, etc.)', () => {
    const text = [
      'Chapter I',
      'First content.',
      'Chapter II',
      'Second content.',
      'Chapter III',
      'Third content.',
    ].join('\n')
    const chapters = deriveChapters(text)
    expect(chapters).toHaveLength(3)
  })

  it('detects "Part N" headings', () => {
    const text = [
      'Part 1',
      'first part content.',
      'Part 2',
      'second part content.',
    ].join('\n')
    const chapters = deriveChapters(text)
    expect(chapters).toHaveLength(2)
  })

  it('falls back to fixed-size sections when no headings are found', () => {
    // Generate 12000 chars of plain text with no chapter markers.
    const text = 'word '.repeat(2400) // ~12000 chars
    const chapters = deriveChapters(text)
    expect(chapters.length).toBeGreaterThan(1)
    // Each fallback chapter should be labeled "Part N".
    expect(chapters[0].title).toMatch(/^Part \d+$/)
  })

  it('requires at least 2 heading matches to use heading-based splitting', () => {
    // A single "Chapter 1" should NOT trigger heading-based splitting.
    const text = 'Chapter 1\nsome content\nwithout further headings'
    const chapters = deriveChapters(text)
    // Falls back to fixed-size sections — should be 1 chapter (under 6000 chars).
    expect(chapters).toHaveLength(1)
    // And it should NOT take "Chapter 1" as its title — it's "Part 1".
    expect(chapters[0].title).toMatch(/^Part \d+$/)
  })

  it('assigns sequential 0-based indexes', () => {
    const text = [
      'Chapter 1',
      'a',
      'Chapter 2',
      'b',
      'Chapter 3',
      'c',
    ].join('\n')
    const chapters = deriveChapters(text)
    expect(chapters.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('estimates seconds from word count at ~155 wpm', () => {
    // 155 words → ~60 seconds; 310 words → ~120 seconds.
    const words = Array.from({ length: 155 }, (_, i) => `word${i}`).join(' ')
    const text = `Chapter 1\n${words}`
    const chapters = deriveChapters(text)
    expect(chapters[0].estimatedSeconds).toBeGreaterThanOrEqual(55)
    expect(chapters[0].estimatedSeconds).toBeLessThanOrEqual(65)
  })

  it('skips empty segments (text.trim() === "")', () => {
    // Adjacent headings with no content between them should not produce
    // an empty chapter.
    const text = 'Chapter 1\n\n\nChapter 2\nreal content'
    const chapters = deriveChapters(text)
    // Only Chapter 2 has content; the empty segment between them is dropped.
    // Actually — the slice between Chapter 1 and Chapter 2 contains just
    // whitespace, which trims to ''. So that segment is filtered out.
    const nonEmpty = chapters.filter((c) => c.text.length > 0)
    expect(nonEmpty.length).toBe(chapters.length)
  })

  it('truncates detected titles to 80 characters', () => {
    const longTitle = 'Chapter 1: ' + 'x'.repeat(200)
    const text = `${longTitle}\ncontent here\nChapter 2\nmore content`
    const chapters = deriveChapters(text)
    expect(chapters[0].title.length).toBeLessThanOrEqual(80)
  })
})
