/**
 * audiobook-prep-agent.ts — LLM-assisted chapter detection + text cleaning.
 *
 * Replaces the regex-only deriveChapters() + cleanForNarration() pair with a
 * two-pass LLM approach, falling back to the regex path per-chapter or
 * whole-book if the LLM path fails.
 *
 * Pass A — chapter boundary detection: sends the model a structural sample
 *   (first ~500 chars of every ~3000-char block) so it can recognize heading
 *   conventions the fixed regex misses ("ONE", roman numerals, unheaded
 *   sections, etc.). Returns a JSON array of { approximateCharOffset, chapterTitle }.
 *   Falls back to deriveChapters() if the LLM call fails.
 *
 * Pass B — per-chapter cleaning: sends each chapter's raw text to an LLM
 *   instructed to fix hyphenated word-breaks, mid-sentence line wraps, repeated
 *   running headers/footers, OCR artifacts, and page numbers — WITHOUT
 *   summarizing or shortening the prose. Falls back to cleanForNarration()
 *   per-chapter if the LLM call fails.
 *
 * Uses generateWithFallback with model 'llama-3.3-70b-versatile' (larger, more
 * precise for quality-sensitive tasks) — matching the model choice used for
 * memory detection elsewhere in the codebase.
 */

import { generateWithFallback, callGeminiForExtraction } from '@/lib/llm-fallback'
import { deriveChapters } from '@/lib/audiobook-chapters'
import { cleanForNarration } from '@/lib/narration-clean'

export interface PreparedChapter {
  index: number
  title: string
  cleanedText: string
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

/** Pass A — LLM-based chapter boundary detection.
 *  Returns a list of { offset, title } boundaries, or null on failure. */
async function detectChapterBoundariesLLM(fullText: string): Promise<{ offset: number; title: string }[] | null> {
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
    if (!raw) return null
    // Extract JSON from the response (may be wrapped in markdown code fences)
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    jsonText = jsonMatch ? jsonMatch[0] : null
  }

  if (!jsonText) return null

  try {
    const boundaries = JSON.parse(jsonText)
    if (!Array.isArray(boundaries)) return null
    if (boundaries.length === 0) return null

    // Validate and normalize
    const valid = boundaries
      .filter((b: any) => typeof b.offset === 'number' && typeof b.title === 'string')
      .map((b: any) => ({ offset: Math.max(0, Math.floor(b.offset)), title: String(b.title).slice(0, 80) }))
      .sort((a: any, b: any) => a.offset - b.offset)

    if (valid.length < 2) return null // need at least 2 boundaries for meaningful chaptering
    return valid
  } catch {
    return null
  }
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
 * prepareAudiobookChapters — runs both passes and returns the final chapter
 * list, ready to insert as AudiobookChapter rows.
 *
 * Pass A: detect chapter boundaries via LLM (or fall back to deriveChapters).
 * Pass B: clean each chapter's text via LLM (or fall back to cleanForNarration
 *         per-chapter).
 */
export async function prepareAudiobookChapters(fullText: string): Promise<PreparedChapter[]> {
  // === Pass A: chapter boundary detection ===
  let boundaries: { offset: number; title: string }[] | null = null

  try {
    boundaries = await detectChapterBoundariesLLM(fullText)
  } catch (e) {
    console.error('[audiobook-prep] Pass A (LLM chapter detection) failed:', e instanceof Error ? e.message : String(e))
    boundaries = null
  }

  let segments: { title: string; text: string }[]

  if (boundaries && boundaries.length >= 2) {
    // Use LLM-detected boundaries to split the full text
    segments = boundaries.map((b, i) => {
      const start = b.offset
      const end = i + 1 < boundaries.length ? boundaries[i + 1].offset : fullText.length
      return { title: b.title, text: fullText.slice(start, end).trim() }
    }).filter(s => s.text.length > 0)
    console.log(`[audiobook-prep] Pass A: LLM detected ${segments.length} chapters`)
  } else {
    // Fallback: regex-based chaptering
    const derived = deriveChapters(fullText)
    segments = derived.map(d => ({ title: d.title, text: d.text }))
    console.log(`[audiobook-prep] Pass A: fell back to regex, ${segments.length} chapters`)
  }

  // === Pass B: per-chapter cleaning ===
  const prepared: PreparedChapter[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    let cleanedText: string | null = null

    try {
      cleanedText = await cleanChapterLLM(seg.text)
    } catch (e) {
      console.error(`[audiobook-prep] Pass B (LLM cleaning) failed for chapter ${i + 1}:`, e instanceof Error ? e.message : String(e))
      cleanedText = null
    }

    if (!cleanedText) {
      // Fallback: regex-based cleaning for this chapter
      cleanedText = cleanForNarration(seg.text)
      console.log(`[audiobook-prep] Pass B: chapter ${i + 1} fell back to regex cleaning`)
    }

    prepared.push({
      index: i,
      title: seg.title,
      cleanedText,
    })
  }

  console.log(`[audiobook-prep] Complete: ${prepared.length} chapters prepared`)
  return prepared
}
