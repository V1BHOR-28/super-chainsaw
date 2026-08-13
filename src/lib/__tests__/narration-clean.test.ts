import { describe, it, expect } from 'vitest'
import { stripOcrArtifacts, cleanForNarration } from '@/lib/narration-clean'

describe('stripOcrArtifacts', () => {
  it('removes Unicode replacement character (U+FFFD)', () => {
    expect(stripOcrArtifacts('Hello\uFFFD World')).toBe('Hello World')
  })

  it('removes non-printable control characters', () => {
    // \u0000-\u0008, \u000B, \u000C, \u000E-\u001F should be stripped.
    // \u0009 (tab), \u000A (\n), \u000D (\r) are intentionally preserved.
    expect(stripOcrArtifacts('a\u0000b\u0001c\u0008d')).toBe('abcd')
    expect(stripOcrArtifacts('a\u000Bb')).toBe('ab')
    expect(stripOcrArtifacts('a\u001Fb')).toBe('ab')
  })

  it('preserves tab, newline, and carriage return', () => {
    expect(stripOcrArtifacts('line1\nline2\ttabbed\r\nwindows')).toBe('line1\nline2\ttabbed\r\nwindows')
  })

  it('preserves normal text unchanged', () => {
    expect(stripOcrArtifacts('Hello, World! 123')).toBe('Hello, World! 123')
  })
})

describe('cleanForNarration', () => {
  it('decodes common HTML entities', () => {
    // &nbsp;→space, &amp;→&, &lt;→<, &gt;→>, &quot;→"
    expect(cleanForNarration('a&nbsp;b&amp;c&lt;d&gt;e&quot;f')).toBe('a b&c<d>e"f')
  })

  it('strips numeric HTML entities (&#123;) — does NOT decode them', () => {
    // The function deliberately STRIPS numeric entities rather than decoding
    // them. Decoding would require parsing the decimal codepoint, which is
    // riskier than just removing them — TTS doesn't need them, and the source
    // EPUBs we see have already been through cheerio's entity decoder.
    expect(cleanForNarration('&#65;&#66;&#67;')).toBe('')
    expect(cleanForNarration('before&#1234;after')).toBe('beforeafter')
  })

  it('normalizes smart single quotes to ASCII apostrophe', () => {
    expect(cleanForNarration('It\u2019s ARIA\u2019s day')).toBe("It's ARIA's day")
  })

  it('normalizes smart double quotes to ASCII double quote', () => {
    expect(cleanForNarration('\u201CHello\u201D she said')).toBe('"Hello" she said')
  })

  it('normalizes en and em dashes to ASCII hyphen', () => {
    expect(cleanForNarration('pages 10\u201320 \u2014 chapter one')).toBe('pages 10-20 - chapter one')
  })

  it('normalizes ellipsis to three dots', () => {
    expect(cleanForNarration('Wait\u2026 what?')).toBe('Wait... what?')
  })

  it('normalizes angle quotes to ASCII double quote', () => {
    expect(cleanForNarration('\u00ABquoted\u00BB')).toBe('"quoted"')
  })

  it('strips bare URLs (TTS reading "h-t-t-p-s" is jarring)', () => {
    const result = cleanForNarration('Check https://example.com/path?x=1 for details')
    expect(result).not.toContain('https://example.com')
    expect(result).toContain('Check')
    expect(result).toContain('for details')
  })

  it('collapses 3+ newlines down to 2', () => {
    expect(cleanForNarration('para1\n\n\n\n\npara2')).toBe('para1\n\npara2')
  })

  it('collapses 2+ tabs/spaces down to 1', () => {
    expect(cleanForNarration('a    b\t\tc')).toBe('a b c')
  })

  it('trims leading and trailing whitespace', () => {
    expect(cleanForNarration('  \n\n  hello  \n\n  ')).toBe('hello')
  })

  it('is idempotent — running it twice produces the same output as running it once', () => {
    // Property test: a clean function should be stable on its own output.
    // If it isn't, you get drift across multiple cleanup passes (e.g. when
    // the server cleans and the client cleans again before display).
    const messy = 'It\u2019s  a   test\u2026\n\n\nwith &nbsp; entities  https://x.io/y'
    const once = cleanForNarration(messy)
    const twice = cleanForNarration(once)
    expect(twice).toBe(once)
  })
})
