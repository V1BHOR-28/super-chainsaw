export interface DerivedChapter {
  index: number
  title: string
  text: string
  estimatedSeconds: number // for duration display — see wordsPerMinute below
}

const WORDS_PER_MINUTE = 155 // rough average TTS reading pace, used only for duration estimates/progress bar math

export function deriveChapters(fullText: string): DerivedChapter[] {
  // Try to detect real chapter headings first (common patterns from public-domain
  // texts and typical book formatting).
  const headingRegex = /^(chapter\s+\d+|chapter\s+[ivxlcdm]+\b|part\s+\d+)/gim
  const matches = [...fullText.matchAll(headingRegex)]

  let segments: { title: string; text: string }[]
  if (matches.length >= 2) {
    segments = matches.map((m, i) => {
      const start = m.index!
      const end = i + 1 < matches.length ? matches[i + 1].index! : fullText.length
      const chunk = fullText.slice(start, end).trim()
      const titleLine = chunk.split('\n')[0].trim().slice(0, 80)
      return { title: titleLine, text: chunk }
    })
  } else {
    // No detectable chapter headings — fall back to fixed-size sections.
    const SECTION_SIZE = 6000
    segments = []
    for (let i = 0; i < fullText.length; i += SECTION_SIZE) {
      segments.push({
        title: `Part ${segments.length + 1}`,
        text: fullText.slice(i, i + SECTION_SIZE).trim(),
      })
    }
  }

  return segments
    .filter(s => s.text.length > 0)
    .map((s, index) => ({
      index,
      title: s.title,
      text: s.text,
      estimatedSeconds: Math.round((s.text.split(/\s+/).length / WORDS_PER_MINUTE) * 60),
    }))
}
