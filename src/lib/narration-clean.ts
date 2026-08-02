/**
 * stripOcrArtifacts — removes Unicode replacement characters and non-printable
 * control characters from OCR scans. Exported separately so it can be run as
 * a lightweight pre-pass before LLM cleaning (so the LLM never sees this garbage).
 */
export function stripOcrArtifacts(text: string): string {
  return text
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * cleanForNarration — strips the things that make TTS narration sound broken:
 * mid-sentence line-wrap breaks, page numbers, footnote markers, bare URLs,
 * and repeated header/footer lines. Does NOT attempt full ACX-style mastering
 * (room tone, precise loudness/bitrate targets) — those are retail-distribution
 * requirements, not needed for in-app personal listening.
 */
export function cleanForNarration(raw: string): string {
  let text = raw

  // Strip Unicode replacement characters (U+FFFD) and other non-printable control
  // characters left over from OCR scanning artifacts — these render as boxes and
  // would otherwise pass straight through to both narration and TTS.
  text = text.replace(/\uFFFD/g, '')
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

  // Join lines that were broken mid-sentence by the PDF's page width —
  // a line that doesn't end in sentence-ending punctuation, followed by
  // a lowercase letter on the next line, is almost certainly a wrapped line.
  text = text.replace(/([a-z,;])\n([a-z])/g, '$1 $2')

  // Strip standalone page-number lines (a line that's just digits, alone).
  text = text.replace(/^\s*\d{1,4}\s*$/gm, '')

  // Strip bare URLs — TTS reading out a raw URL character-by-character is
  // useless and jarring; better to drop them than narrate "h-t-t-p-s colon...".
  text = text.replace(/https?:\/\/\S+/g, '')

  // Strip footnote markers like [1], [12], (1) when they appear as a standalone
  // reference (not general use of brackets/parens elsewhere in prose).
  text = text.replace(/\[\d{1,3}\]/g, '')

  // Collapse 3+ blank lines down to 2 (paragraph break), and trim.
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}
