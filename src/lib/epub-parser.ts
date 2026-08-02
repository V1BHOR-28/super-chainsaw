/**
 * epub-parser.ts — Server-side EPUB parser.
 *
 * Extracts the EPUB's native Table of Contents (TOC) and reading order (spine),
 * then retrieves the raw HTML for each chapter. Uses epub2 for parsing and
 * cheerio for HTML-to-text conversion.
 *
 * EPUBs are much cleaner than PDFs — no page numbers, no OCR artifacts, no
 * running headers. The HTML is already structured by chapter.
 */

import { EPub } from 'epub2'
import * as cheerio from 'cheerio'

export interface EpubChapter {
  title: string
  order: number
  rawHtml: string
  rawText: string
}

export interface EpubParseResult {
  title: string
  author: string | null
  chapters: EpubChapter[]
  fullText: string
}

/** Extract text from HTML using cheerio — strips tags, scripts, styles. */
function htmlToText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, nav, header, footer, aside, link, meta').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

/**
 * Parse an EPUB file and extract its chapters with TOC titles and raw HTML.
 *
 * This parser is designed to be robust across different EPUB structures:
 * - EPUB2 with NCX toc
 * - EPUB3 with nav document
 * - EPUBs with non-standard manifest IDs
 * - EPUBs where getChapterAsync fails (falls back to getChapterRawAsync)
 * - EPUBs with no spine (falls back to iterating the manifest directly)
 */
export async function parseEpub(fileBuffer: Buffer): Promise<EpubParseResult> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')

  const tmpFile = path.join(os.tmpdir(), `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.epub`)
  await fs.writeFile(tmpFile, fileBuffer)

  try {
    const epub = await EPub.createAsync(tmpFile)

    const title = epub.metadata?.title || 'Untitled'
    const author = epub.metadata?.creator || epub.metadata?.author || null

    const flow = epub.flow || []
    const toc = epub.toc || []

    // Build a map of href → title from the TOC
    const tocMap = new Map<string, string>()
    for (const item of toc) {
      if (item.title && item.href) {
        const hrefBase = item.href.split('#')[0]
        tocMap.set(hrefBase, item.title)
      }
    }

    const chapters: EpubChapter[] = []
    let fullText = ''

    // Try the spine (flow) first — this is the correct reading order
    if (flow.length > 0) {
      for (let i = 0; i < flow.length; i++) {
        const item = flow[i]
        if (!item.id) continue

        let rawHtml: string | null = null

        // Try getChapterAsync first (epub2's processed version)
        try {
          rawHtml = await epub.getChapterAsync(item.id)
        } catch {
          // Fall back to getChapterRawAsync (raw HTML without processing)
          try {
            rawHtml = await epub.getChapterRawAsync(item.id)
          } catch (rawErr) {
            console.error(`[epub-parser] Both getChapter and getChapterRaw failed for ${item.id}:`, rawErr instanceof Error ? rawErr.message : String(rawErr))
          }
        }

        if (!rawHtml || rawHtml.trim().length === 0) {
          // Try fetching via getFileAsync as a last resort
          try {
            const [fileBuffer] = await epub.getFileAsync(item.id)
            if (fileBuffer) {
              rawHtml = fileBuffer.toString('utf-8')
            }
          } catch {
            // Give up on this chapter
          }
        }

        if (!rawHtml || rawHtml.trim().length === 0) continue

        const rawText = htmlToText(rawHtml)
        if (rawText.length < 10) continue

        // Get chapter title
        const hrefBase = (item.href || '').split('#')[0]
        let chapterTitle = tocMap.get(hrefBase) || ''
        if (!chapterTitle) {
          const $ = cheerio.load(rawHtml)
          const heading = $('h1, h2, h3, h4, title').first().text().trim()
          if (heading) chapterTitle = heading.slice(0, 200)
        }
        if (!chapterTitle) chapterTitle = `Chapter ${chapters.length + 1}`

        chapters.push({
          title: chapterTitle.slice(0, 200),
          order: chapters.length,
          rawHtml: rawHtml.slice(0, 500_000),
          rawText: rawText.slice(0, 500_000),
        })
        fullText += rawText + '\n\n'
      }
    }

    // If spine yielded zero chapters, fall back to iterating ALL manifest items
    // that look like HTML content. This catches EPUBs where the spine is
    // malformed or empty but the content files exist in the manifest.
    if (chapters.length === 0 && epub.manifest) {
      console.log('[epub-parser] Spine yielded 0 chapters, falling back to manifest iteration')
      const manifestItems = Object.values(epub.manifest)
      let order = 0
      for (const item of manifestItems as any[]) {
        const mediaType = item['media-type'] || item.mediaType || ''
        const href = item.href || ''
        // Only process HTML-like content
        if (!mediaType.includes('html') && !mediaType.includes('xml') &&
            !href.endsWith('.html') && !href.endsWith('.xhtml') && !href.endsWith('.htm')) {
          continue
        }
        if (!item.id) continue

        let rawHtml: string | null = null
        try {
          rawHtml = await epub.getChapterAsync(item.id)
        } catch {
          try {
            rawHtml = await epub.getChapterRawAsync(item.id)
          } catch {
            try {
              const [fileBuffer] = await epub.getFileAsync(item.id)
              if (fileBuffer) rawHtml = fileBuffer.toString('utf-8')
            } catch { /* skip */ }
          }
        }

        if (!rawHtml || rawHtml.trim().length === 0) continue

        const rawText = htmlToText(rawHtml)
        if (rawText.length < 10) continue

        const hrefBase = href.split('#')[0]
        let chapterTitle = tocMap.get(hrefBase) || ''
        if (!chapterTitle) {
          const $ = cheerio.load(rawHtml)
          const heading = $('h1, h2, h3, h4, title').first().text().trim()
          if (heading) chapterTitle = heading.slice(0, 200)
        }
        if (!chapterTitle) chapterTitle = `Chapter ${order + 1}`

        chapters.push({
          title: chapterTitle.slice(0, 200),
          order,
          rawHtml: rawHtml.slice(0, 500_000),
          rawText: rawText.slice(0, 500_000),
        })
        fullText += rawText + '\n\n'
        order++
      }
    }

    console.log(`[epub-parser] Parsed "${title}" by ${author || 'unknown'}: ${chapters.length} chapters, ${fullText.length} chars`)

    return { title, author, chapters, fullText }
  } finally {
    try { await fs.unlink(tmpFile) } catch { /* best-effort */ }
  }
}
