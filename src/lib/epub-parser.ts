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

/**
 * Parse an EPUB file and extract its chapters with TOC titles and raw HTML.
 *
 * @param fileBuffer - The EPUB file as a Buffer (from a Blob/File upload)
 * @returns { title, author, chapters, fullText }
 */
export async function parseEpub(fileBuffer: Buffer): Promise<EpubParseResult> {
  // epub2's createAsync expects a file path, but we can use the underlying
  // EPub constructor with a Buffer by writing to a temp file. On Vercel's
  // serverless environment, /tmp is writable.
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')

  const tmpFile = path.join(os.tmpdir(), `epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.epub`)
  await fs.writeFile(tmpFile, fileBuffer)

  try {
    const epub = await EPub.createAsync(tmpFile)

    const title = epub.metadata?.title || 'Untitled'
    const author = epub.metadata?.creator || epub.metadata?.author || null

    // The `flow` is the spine — the reading order of the book.
    // The `toc` has the chapter titles mapped to hrefs.
    const flow = epub.flow || []
    const toc = epub.toc || []

    // Build a map of href → title from the TOC for quick lookup
    const tocMap = new Map<string, string>()
    for (const item of toc) {
      if (item.title && item.href) {
        // TOC hrefs can be "chapter.xhtml" or "chapter.xhtml#section"
        // — normalize to just the filename for matching
        const hrefBase = item.href.split('#')[0]
        tocMap.set(hrefBase, item.title)
      }
    }

    const chapters: EpubChapter[] = []
    let fullText = ''

    for (let i = 0; i < flow.length; i++) {
      const item = flow[i]
      if (!item.id) continue

      try {
        // Get the raw HTML for this spine item
        const rawHtml = await epub.getChapterAsync(item.id)

        if (!rawHtml || rawHtml.trim().length === 0) continue

        // Convert HTML to text using cheerio
        const $ = cheerio.load(rawHtml)
        // Remove scripts, styles, and other non-content elements
        $('script, style, nav, header, footer, aside').remove()
        const rawText = $('body').text().replace(/\s+/g, ' ').trim()

        if (rawText.length < 10) continue // skip near-empty chapters

        // Try to get the title from the TOC, fall back to the first heading
        // in the HTML, or a generic "Chapter N"
        const hrefBase = (item.href || '').split('#')[0]
        let chapterTitle = tocMap.get(hrefBase) || ''

        if (!chapterTitle) {
          // Try to extract from the HTML's first heading
          const heading = $('h1, h2, h3, h4').first().text().trim()
          if (heading) chapterTitle = heading.slice(0, 200)
        }

        if (!chapterTitle) {
          chapterTitle = `Chapter ${i + 1}`
        }

        chapters.push({
          title: chapterTitle.slice(0, 200),
          order: i,
          rawHtml: rawHtml.slice(0, 500_000), // cap to prevent DB overflow
          rawText: rawText.slice(0, 500_000),
        })

        fullText += rawText + '\n\n'
      } catch (chapterErr) {
        console.error(`[epub-parser] Failed to get chapter ${item.id}:`, chapterErr instanceof Error ? chapterErr.message : String(chapterErr))
        // Skip failed chapters — partial extraction is better than total failure
      }
    }

    console.log(`[epub-parser] Parsed "${title}" by ${author || 'unknown'}: ${chapters.length} chapters, ${fullText.length} chars`)

    return { title, author, chapters, fullText }
  } finally {
    // Clean up temp file
    try { await fs.unlink(tmpFile) } catch { /* best-effort */ }
  }
}
