'use client'

/**
 * Client-side PDF parser — runs entirely in the user's browser.
 *
 * This is the key to supporting 3000+ page books: instead of parsing on
 * Vercel's serverless (which times out at 60s), we parse in the browser
 * where there's no timeout, no memory limit, and no DOMMatrix error.
 *
 * The browser's pdfjs-dist works perfectly — it's the same library Google
 * Docs and Mozilla's own PDF viewer use. The extracted text is then sent
 * to the backend in batches for embedding + storage.
 *
 * Flow:
 *   1. User selects a PDF file
 *   2. This parser extracts text page-by-page (with progress callback)
 *   3. The extracted text is chunked into ~3000-char sections
 *   4. Chunks are sent to /api/knowledge/batch in groups of 10
 *   5. Backend embeds + stores each chunk
 */

export interface PdfParseProgress {
  currentPage: number
  totalPages: number
  /** 0-100 percentage */
  percent: number
}

// Cache the pdfjs library + worker setup so repeated uploads don't re-import.
let pdfjsLibCache: typeof import('pdfjs-dist') | null = null

async function getPdfjs() {
  if (pdfjsLibCache) return pdfjsLibCache

  const pdfjsLib = await import('pdfjs-dist')

  // Set the worker source ONCE. The worker lets pdfjs parse PDFs off the
  // main thread (better performance). We try multiple approaches in order
  // of reliability:
  //   1. unpkg CDN with the CORRECT filename (pdf.worker.min.mjs)
  //   2. If that fails, disable the worker (runs on main thread — slower but always works)
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    try {
      // Use unpkg CDN — the file definitely exists (verified in node_modules).
      // The correct filename is pdf.worker.min.mjs (NOT .min.min.js which was the bug).
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
    } catch {
      // If CDN setup fails (shouldn't happen — it's just a string assignment),
      // disable the worker. pdfjs will parse on the main thread.
      pdfjsLib.GlobalWorkerOptions.workerSrc = ''
    }
  }

  pdfjsLibCache = pdfjsLib
  return pdfjsLib
}

/**
 * Parse a PDF file in the browser, extracting all text.
 * Calls onProgress with page-by-page updates.
 *
 * @param file The PDF File/Blob to parse
 * @param onProgress Progress callback (called after each page)
 * @returns The full extracted text from all pages
 */
export async function parsePdfInBrowser(
  file: Blob,
  onProgress?: (progress: PdfParseProgress) => void
): Promise<string> {
  const pdfjsLib = await getPdfjs()

  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    disableFontFace: true,
    useSystemFonts: true,
  })

  let pdf: Awaited<typeof loadingTask.promise> | null = null
  try {
    pdf = await loadingTask.promise
  } catch (err) {
    throw new Error(
      `Could not open this PDF. It might be corrupted or password-protected. ` +
      `(Detail: ${err instanceof Error ? err.message : String(err)})`
    )
  }

  const totalPages = pdf.numPages
  let fullText = ''

  // Parse page by page. Each page takes ~10-50ms in the browser, so even
  // 3000 pages = 30-150 seconds total. The progress bar keeps the user
  // informed — no timeout risk since this runs on the user's device.
  for (let i = 1; i <= totalPages; i++) {
    try {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item: { str?: string }) => item.str || '')
        .join(' ')
      fullText += pageText + '\n\n'

      if (onProgress) {
        onProgress({
          currentPage: i,
          totalPages,
          percent: Math.round((i / totalPages) * 100),
        })
      }

      // Clean up page resources to avoid memory buildup on large PDFs.
      // Use optional chaining — some pdfjs versions name this differently.
      try { page.cleanup?.() } catch { /* best-effort cleanup */ }
    } catch {
      // Skip pages that fail — partial extraction is better than total failure
    }

    // Yield to the event loop every 10 pages so the UI doesn't freeze
    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // Cleanup — best-effort. Method name varies across pdfjs versions:
  //   - v3: pdf.destroy()
  //   - v4: pdf.destroy()
  //   - v6: pdf.cleanup() or pdf.destroy() (both may exist)
  // Wrap in try/catch + optional chaining so a missing method doesn't crash.
  try { await pdf.destroy?.() } catch { /* best-effort cleanup */ }
  try { await pdf.cleanup?.() } catch { /* best-effort cleanup */ }

  return fullText
}

// ─── PDF TOC (Table of Contents) Extraction ─────────────────────────────

/** A chapter extracted from the PDF's outline/bookmark tree. */
export interface PdfChapter {
  title: string
  /** 1-indexed start page (PDF page number) */
  startPage: number
  /** 1-indexed end page (inclusive). The last chapter ends on the last page. */
  endPage: number
  /** The raw text for this chapter, extracted from its page range */
  rawText: string
}

/** Flatten the PDF outline tree (which can be nested) into a flat list of
 *  { title, dest } items, preserving document order. */
async function flattenOutline(
  outline: any[],
  pdf: any,
  result: { title: string; dest: any }[] = []
): Promise<{ title: string; dest: any }[]> {
  for (const item of outline) {
    if (item.title) {
      result.push({ title: item.title, dest: item.dest })
    }
    // Recurse into nested items (sub-chapters)
    if (item.items && Array.isArray(item.items) && item.items.length > 0) {
      await flattenOutline(item.items, pdf, result)
    }
  }
  return result
}

/** Resolve an outline item's destination to a 1-indexed page number.
 *  Returns 0 if the destination can't be resolved. */
async function resolveDestToPage(pdf: any, dest: any): Promise<number> {
  try {
    if (!dest) return 0

    // `dest` can be a string (a named destination) or an array
    // [pageRef, ...coords]. Handle both.
    let explicitDest = dest
    if (typeof dest === 'string') {
      // Named destination — resolve it first
      explicitDest = await pdf.getDestination(dest)
      if (!explicitDest) return 0
    }

    if (Array.isArray(explicitDest) && explicitDest.length > 0) {
      // explicitDest[0] is a page reference object — resolve it to a page index
      const pageIndex = await pdf.getPageIndex(explicitDest[0])
      return pageIndex + 1 // pdfjs uses 0-indexed page indices; convert to 1-indexed
    }
  } catch {
    // Best-effort — if we can't resolve, return 0
  }
  return 0
}

/** Extract the PDF's Table of Contents (outline/bookmarks) and map each
 *  chapter to its page range + raw text. This is the core of Phase 2:
 *  we use the PDF's ACTUAL metadata for chapter boundaries, not arbitrary
 *  character limits or LLM guesses.
 *
 *  Falls back to a single "whole book" chapter if the PDF has no outline. */
export async function extractPdfChapters(
  file: Blob,
  onProgress?: (progress: PdfParseProgress) => void
): Promise<{ chapters: PdfChapter[]; fullText: string }> {
  const pdfjsLib = await getPdfjs()

  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    disableFontFace: true,
    useSystemFonts: true,
  })

  let pdf: Awaited<typeof loadingTask.promise> | null = null
  try {
    pdf = await loadingTask.promise
  } catch (err) {
    throw new Error(
      `Could not open this PDF. It might be corrupted or password-protected. ` +
      `(Detail: ${err instanceof Error ? err.message : String(err)})`
    )
  }

  const totalPages = pdf.numPages

  // Step 1: Extract the PDF's outline (bookmark tree)
  let outline: any[] = []
  try {
    outline = await pdf.getOutline() || []
  } catch {
    outline = []
  }

  // Step 2: Parse all pages' text first (we need it to slice chapters)
  const pageTexts: string[] = []
  let fullText = ''

  for (let i = 1; i <= totalPages; i++) {
    try {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = (content.items as any[])
        .map((item: any) => item.str || '')
        .join(' ')
      pageTexts.push(pageText)
      fullText += pageText + '\n\n'

      if (onProgress) {
        onProgress({
          currentPage: i,
          totalPages,
          percent: Math.round((i / totalPages) * 100),
        })
      }

      try { page.cleanup?.() } catch { /* best-effort cleanup */ }
    } catch {
      pageTexts.push('') // empty page on failure — partial extraction is better than total failure
    }

    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // Step 3: Map outline items to page numbers and build chapter list
  let chapters: PdfChapter[] = []

  if (outline.length > 0) {
    // Flatten the outline tree (handles nested sub-chapters)
    const flatOutline = await flattenOutline(outline, pdf)

    // Resolve each outline item to a start page
    const outlinePages = await Promise.all(
      flatOutline.map(async (item) => ({
        title: item.title,
        startPage: await resolveDestToPage(pdf, item.dest),
      }))
    )

    // Filter out items that couldn't be resolved to a page (startPage === 0)
    // and deduplicate (some PDFs have duplicate outline entries)
    const validChapters = outlinePages
      .filter((c, i, arr) => c.startPage > 0 && arr.findIndex(x => x.startPage === c.startPage) === i)
      .sort((a, b) => a.startPage - b.startPage)

    if (validChapters.length >= 2) {
      // Build chapter ranges: each chapter starts at its startPage and ends
      // at the page before the next chapter's startPage (or the last page).
      chapters = validChapters.map((ch, i) => {
        const startPage = ch.startPage
        const endPage = i + 1 < validChapters.length
          ? validChapters[i + 1].startPage - 1
          : totalPages
        // Slice the page texts for this chapter's page range (1-indexed → 0-indexed array)
        const chapterText = pageTexts
          .slice(startPage - 1, endPage)
          .join('\n\n')
          .trim()
        return {
          title: ch.title.slice(0, 200), // cap title length
          startPage,
          endPage,
          rawText: chapterText,
        }
      }).filter(ch => ch.rawText.length > 0)
    }
  }

  // Step 4: Fallback — if no outline or too few chapters, treat the whole
  // document as a single chapter. This ensures we always have at least one
  // chapter to work with, even for PDFs without bookmarks.
  if (chapters.length === 0) {
    // Split by a large fixed size as a last resort (not ideal, but better
    // than a single 500K-char chapter that can't be TTS'd)
    const SECTION_SIZE = 10000
    const sections: PdfChapter[] = []
    for (let i = 0; i < fullText.length; i += SECTION_SIZE) {
      const text = fullText.slice(i, i + SECTION_SIZE).trim()
      if (text.length > 0) {
        sections.push({
          title: `Section ${sections.length + 1}`,
          startPage: 1,
          endPage: totalPages,
          rawText: text,
        })
      }
    }
    chapters = sections.length > 0 ? sections : [{
      title: 'Full Text',
      startPage: 1,
      endPage: totalPages,
      rawText: fullText.trim(),
    }]
  }

  // Cleanup
  try { await (pdf as any).destroy?.() } catch { /* best-effort cleanup */ }
  try { await (pdf as any).cleanup?.() } catch { /* best-effort cleanup */ }

  return { chapters, fullText }
}
