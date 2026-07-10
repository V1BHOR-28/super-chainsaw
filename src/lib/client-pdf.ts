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
  // Dynamic import — only loads pdfjs when this function is called (in browser).
  // This prevents SSR issues and keeps the bundle small.
  const pdfjsLib = await import('pdfjs-dist')

  // Set the worker source. The worker lets pdfjs parse PDFs off the main
  // thread (better performance). We try multiple approaches in order of
  // reliability:
  //   1. Local bundled worker via ?url import (Turbopack serves it as a static asset)
  //   2. unpkg CDN with the CORRECT filename (pdf.worker.min.mjs)
  //   3. Disable worker entirely (runs on main thread — slower but always works)
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    try {
      const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default
    } catch {
      try {
        // Fallback: unpkg CDN with correct filename
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
      } catch {
        // Last resort: no worker (main thread parsing)
        pdfjsLib.GlobalWorkerOptions.workerSrc = ''
      }
    }
  }

  const arrayBuffer = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    disableFontFace: true,
    useSystemFonts: true,
  })

  const pdf = await loadingTask.promise
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

      // Clean up page resources to avoid memory buildup on large PDFs
      page.cleanup()
    } catch {
      // Skip pages that fail — partial extraction is better than total failure
    }

    // Yield to the event loop every 10 pages so the UI doesn't freeze
    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  await pdf.destroy()
  return fullText
}
