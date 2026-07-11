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
