/**
 * stripOcrArtifacts — removes Unicode replacement characters and non-printable
 * control characters. EPUBs are generally cleaner than PDFs (no OCR), but
 * encoding artifacts can still appear from poorly-converted files.
 */
export function stripOcrArtifacts(text: string): string {
  return text
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * cleanForNarration — lightweight text normalization for TTS.
 *
 * EPUBs don't have the page-number/OCR/header problems PDFs do — the HTML
 * is already structured by chapter. This function handles the remaining
 * issues that affect narration quality:
 * - Character encoding artifacts (from poorly-converted EPUBs)
 * - Weird Unicode quotation marks/dashes that TTS engines mishandle
 * - Excessive whitespace from HTML-to-text conversion
 * - Stray HTML entities that weren't fully decoded
 *
 * Does NOT do LLM-level cleanup (that's handled by the Flask audiobook-maker service).
 */
export function cleanForNarration(raw: string): string {
  let text = raw

  // Strip non-printable control characters
  text = stripOcrArtifacts(text)

  // Decode common HTML entities that cheerio might have missed
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#\d+;/g, '') // strip numeric entities

  // Normalize Unicode quotation marks and dashes to ASCII (TTS engines
  // handle these more reliably)
  text = text.replace(/[\u2018\u2019\u201A\u201B]/g, "'") // smart single quotes
  text = text.replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart double quotes
  text = text.replace(/[\u2013\u2014]/g, '-') // en/em dashes
  text = text.replace(/\u2026/g, '...') // ellipsis
  text = text.replace(/[\u00AB\u00BB]/g, '"') // angle quotes

  // Strip bare URLs — TTS reading "h-t-t-p-s colon" is jarring
  text = text.replace(/https?:\/\/\S+/g, '')

  // Collapse excessive whitespace from HTML-to-text conversion
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.trim()

  return text
}
