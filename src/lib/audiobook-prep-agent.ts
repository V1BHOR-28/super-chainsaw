/**
 * audiobook-prep-agent.ts — LLM-assisted chapter detection + text cleaning.
 *
 * Two-pass design, now split into independently-callable functions so the
 * worker endpoint can resume from a stored progress point:
 *
 * Pass A — detectChapterBoundaries(fullText): returns chapter boundaries
 *   (index, title, startOffset, endOffset). Stored in Audiobook.chapterBoundaries
 *   so it never needs to re-run on a resume.
 *
 * Pass B — cleanChapterBatch(fullText, boundaries, startIndex, batchSize):
 *   runs LLM cleaning for only `batchSize` chapters starting at `startIndex`,
 *   not the whole book. Keeps the existing per-chapter LLM cleaning logic
 *   and its regex-fallback-on-failure behavior exactly as before.
 *
 * Uses generateWithFallback with model 'llama-3.3-70b-versatile' (larger, more
 * precise for quality-sensitive tasks) — matching the model choice used for
 * memory detection elsewhere in the codebase.
 */

import { generateWithFallback, callGeminiForExtraction } from '@/lib/llm-fallback'
import { deriveChapters } from '@/lib/audiobook-chapters'
import { cleanForNarration, stripOcrArtifacts } from '@/lib/narration-clean'

export interface PreparedChapter {
  index: number
  title: string
  cleanedText: string
}

/** A chapter boundary — the result of pass A. Stored in Audiobook.chapterBoundaries
 *  as JSON so it survives across batched worker invocations. */
export interface ChapterBoundary {
  index: number
  title: string
  startOffset: number
  endOffset: number
}

/** Structural sample for Pass A — first ~500 chars of every ~3000-char block.
 *  Gives the model enough of each section's opening to recognize a heading
 *  pattern without needing the entire book in context. */
function buildStructuralSample(fullText: string): string {
  const BLOCK_SIZE = 3000
  const SAMPLE_LEN = 500
  const blocks: string[] = []
  for (let i = 0; i < fullText.length; i += BLOCK_SIZE) {
    const blockStart = i
    const sample = fullText.slice(blockStart, blockStart + SAMPLE_LEN)
    blocks.push(`[offset ~${blockStart}]\n${sample}`)
  }
  // Cap the total sample to avoid exceeding context limits for very long books
  // (60 blocks × ~550 chars ≈ 33K chars, well within limits)
  return blocks.slice(0, 60).join('\n---\n')
}

/** Snap an LLM-guessed character offset to the nearest real paragraph break
 *  in fullText, so chapters don't start mid-word. The LLM's offset is a rough
 *  guess based on a compressed structural sample, not an exact position.
 *  Falls back to nearest whitespace if no paragraph break is found nearby. */
function snapToParagraphBoundary(fullText: string, approxOffset: number): number {
  const searchWindow = 400 // look up to 400 chars before/after the guess
  const start = Math.max(0, approxOffset - searchWindow)
  const end = Math.min(fullText.length, approxOffset + searchWindow)
  const windowText = fullText.slice(start, end)

  // Find the nearest paragraph break (double newline) to the guessed offset
  let bestOffset = approxOffset
  let bestDistance = Infinity
  const paragraphBreakRegex = /\n\s*\n/g
  let match: RegExpExecArray | null
  while ((match = paragraphBreakRegex.exec(windowText)) !== null) {
    const candidateOffset = start + match.index + match[0].length
    const distance = Math.abs(candidateOffset - approxOffset)
    if (distance < bestDistance) {
      bestDistance = distance
      bestOffset = candidateOffset
    }
  }
  // If no paragraph break found nearby, fall back to nearest whitespace at least,
  // so we never cut mid-word even if we can't find a full paragraph boundary.
  if (bestDistance === Infinity) {
    const nearestSpaceBefore = fullText.lastIndexOf(' ', approxOffset)
    bestOffset = nearestSpaceBefore >= start ? nearestSpaceBefore + 1 : approxOffset
  }
  return bestOffset
}

/**
 * Pass A — detect chapter boundaries via LLM (or fall back to regex).
 * Returns a list of ChapterBoundary objects with index, title, startOffset, endOffset.
 *
 * This is the ONLY function that runs pass A. Once its result is stored in
 * Audiobook.chapterBoundaries, it never needs to re-run on a resume.
 */
export async function detectChapterBoundaries(fullText: string): Promise<ChapterBoundary[]> {
  const sample = buildStructuralSample(fullText)

  const prompt = `You are a book structure analyzer. Below is a structural sample of a book — the first ~500 characters of every ~3000-character block, with character offsets marked.

Your task: identify where each chapter/section begins. Look for chapter headings of ANY convention: "Chapter 1", "CHAPTER ONE", "Part II", roman numerals ("I.", "II."), numbered sections ("1.", "2."), named chapters ("THE LETTER"), or any other heading pattern.

Return a JSON array of objects with two fields:
- "offset": approximate character offset where the chapter starts (integer)
- "title": the chapter title (string, max 80 chars)

If you can't detect any clear chapter boundaries, return an empty array [].

Structural sample:
${sample}

Return ONLY the JSON array, no other text.`

  // Try Gemini first (native JSON mode), then generateWithFallback
  let jsonText: string | null = null

  try {
    jsonText = await callGeminiForExtraction(prompt)
  } catch {
    jsonText = null
  }

  if (!jsonText) {
    // Fallback to generateWithFallback (Groq/Pollinations)
    const raw = await generateWithFallback(prompt, { model: 'llama-3.3-70b-versatile' })
    if (!raw) {
      // All LLM providers failed — fall back to regex chaptering
      console.log('[audiobook-prep] Pass A: all LLM providers failed, falling back to regex')
      return boundariesFromDerived(fullText)
    }
    // Extract JSON from the response (may be wrapped in markdown code fences)
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    jsonText = jsonMatch ? jsonMatch[0] : null
  }

  if (!jsonText) {
    console.log('[audiobook-prep] Pass A: no JSON in LLM response, falling back to regex')
    return boundariesFromDerived(fullText)
  }

  try {
    const rawBoundaries = JSON.parse(jsonText)
    if (!Array.isArray(rawBoundaries) || rawBoundaries.length === 0) {
      console.log('[audiobook-prep] Pass A: LLM returned empty/invalid array, falling back to regex')
      return boundariesFromDerived(fullText)
    }

    // Validate and normalize
    const valid = rawBoundaries
      .filter((b: any) => typeof b.offset === 'number' && typeof b.title === 'string')
      .map((b: any) => ({ offset: Math.max(0, Math.floor(b.offset)), title: String(b.title).slice(0, 80) }))
      .sort((a: any, b: any) => a.offset - b.offset)

    if (valid.length < 2) {
      console.log('[audiobook-prep] Pass A: LLM found < 2 boundaries, falling back to regex')
      return boundariesFromDerived(fullText)
    }

    // Convert to ChapterBoundary with startOffset/endOffset.
    // Snap each LLM-guessed offset to the nearest real paragraph boundary
    // so chapters don't start mid-word (the LLM's offset is a rough guess
    // based on a compressed structural sample, not an exact position).
    const snappedOffsets = valid.map((b: any) => snapToParagraphBoundary(fullText, b.offset))
    const boundaries: ChapterBoundary[] = valid.map((b: any, i: number) => ({
      index: i,
      title: b.title,
      startOffset: snappedOffsets[i],
      endOffset: i + 1 < valid.length ? snappedOffsets[i + 1] : fullText.length,
    }))

    console.log(`[audiobook-prep] Pass A: LLM detected ${boundaries.length} chapters`)
    return boundaries
  } catch {
    console.log('[audiobook-prep] Pass A: JSON parse failed, falling back to regex')
    return boundariesFromDerived(fullText)
  }
}

/** Convert deriveChapters() (regex) output to ChapterBoundary format. */
function boundariesFromDerived(fullText: string): ChapterBoundary[] {
  const derived = deriveChapters(fullText)
  const boundaries: ChapterBoundary[] = []

  // deriveChapters doesn't expose offsets, so we reconstruct them by
  // finding where each chapter's text starts in the full text.
  let searchFrom = 0
  for (const d of derived) {
    const startOffset = d.text.length > 0 ? fullText.indexOf(d.text.slice(0, 100), searchFrom) : -1
    const actualStart = startOffset >= 0 ? startOffset : searchFrom
    boundaries.push({
      index: d.index,
      title: d.title,
      startOffset: actualStart,
      endOffset: actualStart + d.text.length,
    })
    searchFrom = actualStart + Math.max(1, d.text.length)
  }

  // Fix endOffset of last chapter to be the full text length
  if (boundaries.length > 0) {
    boundaries[boundaries.length - 1].endOffset = fullText.length
  }

  console.log(`[audiobook-prep] Pass A: regex fallback produced ${boundaries.length} chapters`)
  return boundaries
}

/** Pass B — LLM-based per-chapter cleaning.
 *  Returns the cleaned text, or null on failure (caller falls back to regex). */
async function cleanChapterLLM(rawText: string): Promise<string | null> {
  const prompt = `You are a narration text cleaner. Clean the following book chapter text for text-to-speech narration. Fix:
- Hyphenated word-breaks across lines (e.g. "under-\nstand" → "understand")
- Mid-sentence line wraps (join lines that were broken by page width)
- Repeated running headers/footers (e.g. book title or author name appearing at the top/bottom of every page)
- OCR artifacts and scanning errors
- Standalone page-number lines
- Remove any stray unicode replacement characters, boxes, or unrecognizable symbols that are clearly OCR scanning artifacts, not real punctuation or content

CRITICAL RULES:
- Do NOT summarize, paraphrase, or shorten the text
- Do NOT remove any actual story content
- Output ONLY the cleaned text, no commentary, no markdown
- Preserve paragraph breaks (blank lines between paragraphs)
- The output must be the same book, just narration-ready

Chapter text:
${rawText}`

  const result = await generateWithFallback(prompt, { model: 'llama-3.3-70b-versatile' })
  if (!result || result.length < rawText.length * 0.5) {
    // If the LLM output is suspiciously short (less than half the input), it
    // probably summarized instead of cleaning — reject and fall back to regex.
    return null
  }
  return result
}

/**
 * cleanChapterText — Phase 3 public API.
 *
 * Takes a single chapter's rawText (from PDF extraction) and returns
 * cleanedText optimized for TTS. Strips OCR artifacts before LLM cleaning,
 * then sends to the LLM with a prompt to fix page numbers, headers, footers,
 * hyphenated words, and line wraps — WITHOUT summarizing. Falls back to
 * regex-based cleanForNarration() if the LLM call fails.
 *
 * This is the function the prep-batch route calls per chapter.
 */
export async function cleanChapterText(rawText: string): Promise<string> {
  // Strip OCR control characters/mojibake BEFORE sending to the LLM
  const prepped = stripOcrArtifacts(rawText).trim()
  if (!prepped) return ''

  let cleanedText: string | null = null

  try {
    cleanedText = await cleanChapterLLM(prepped)
  } catch (e) {
    console.error('[audiobook-prep] cleanChapterText: LLM cleaning failed:', e instanceof Error ? e.message : String(e))
    cleanedText = null
  }

  if (!cleanedText) {
    // Fallback: regex-based cleaning (also strips OCR artifacts)
    cleanedText = cleanForNarration(prepped)
    console.log('[audiobook-prep] cleanChapterText: fell back to regex cleaning')
  }

  return cleanedText
}

/**
 * Pass B (batched) — clean a bounded range of chapters via LLM.
 *
 * Runs LLM cleaning for only `batchSize` chapters starting at `startIndex`,
 * not the whole book. Keeps the existing per-chapter LLM cleaning logic
 * and its regex-fallback-on-failure behavior exactly as before — just calls
 * it in a bounded loop instead of over the whole chapter list at once.
 *
 * Returns the prepared chapters for this batch only.
 */
export async function cleanChapterBatch(
  fullText: string,
  boundaries: ChapterBoundary[],
  startIndex: number,
  batchSize: number
): Promise<PreparedChapter[]> {
  const endIndex = Math.min(startIndex + batchSize, boundaries.length)
  const prepared: PreparedChapter[] = []

  for (let i = startIndex; i < endIndex; i++) {
    const boundary = boundaries[i]
    // Strip OCR control characters/mojibake BEFORE sending to the LLM, so
    // the LLM never sees this garbage rather than relying on it to remove them.
    const rawText = stripOcrArtifacts(fullText.slice(boundary.startOffset, boundary.endOffset)).trim()

    if (!rawText) {
      // Skip empty chapters
      prepared.push({ index: i, title: boundary.title, cleanedText: '' })
      continue
    }

    let cleanedText: string | null = null

    try {
      cleanedText = await cleanChapterLLM(rawText)
    } catch (e) {
      console.error(`[audiobook-prep] Pass B (LLM cleaning) failed for chapter ${i + 1}:`, e instanceof Error ? e.message : String(e))
      cleanedText = null
    }

    if (!cleanedText) {
      // Fallback: regex-based cleaning for this chapter (also strips OCR artifacts)
      cleanedText = cleanForNarration(rawText)
      console.log(`[audiobook-prep] Pass B: chapter ${i + 1} fell back to regex cleaning`)
    }

    prepared.push({
      index: i,
      title: boundary.title,
      cleanedText,
    })
  }

  console.log(`[audiobook-prep] Pass B: cleaned chapters ${startIndex + 1}-${endIndex} of ${boundaries.length}`)
  return prepared
}
