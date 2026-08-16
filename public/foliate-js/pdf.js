/**
 * pdf.js — foliate-js PDF adapter.
 *
 * Uses pdfjs-dist to extract text from PDF pages and creates a reflowable
 * book object (text-based, not image-based) that foliate-js's paginator
 * can render like an EPUB. This gives the reader selectable text, font
 * size control, and smooth pagination — better for reading than rendering
 * each page as a fixed image.
 *
 * pdfjs-dist build files are copied locally into ./vendor/ (same origin as
 * this module) to avoid CORS/CSP issues with cross-origin dynamic imports.
 */

let pdfjsLib = null

async function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib
    try {
        // Import from same-origin — no CORS/CSP issues
        pdfjsLib = await import('./vendor/pdf.min.mjs')
        // Set the worker URL (required for pdfjs-dist to function).
        // Use same-origin worker path.
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href
        console.log('[pdf.js] pdfjs-dist loaded successfully')
        return pdfjsLib
    } catch (err) {
        console.error('[pdf.js] Failed to load pdfjs-dist:', err)
        throw new Error(`PDF library load failed: ${err.message}`)
    }
}

/**
 * Create a foliate-js-compatible book object from a PDF file.
 * Each PDF page becomes a "section" with extracted text content.
 */
export async function makePDF(file) {
    console.log('[pdf.js] makePDF called, file size:', file.size, 'name:', file.name)
    const pdfjs = await loadPdfjs()
    const data = new Uint8Array(await file.arrayBuffer())
    console.log('[pdf.js] Loading PDF document...')
    const pdf = await pdfjs.getDocument({ data }).promise
    console.log('[pdf.js] PDF loaded, pages:', pdf.numPages)

    const numPages = pdf.numPages
    const metadata = await pdf.getMetadata().catch(() => ({}))
    const info = metadata?.info || {}
    console.log('[pdf.js] Metadata:', info.Title, info.Author)

    // Extract text from all pages (lazy — each section loads on demand)
    const sections = []
    for (let i = 1; i <= numPages; i++) {
        sections.push(createPageSection(pdf, i))
    }

    // Build TOC from PDF outline (bookmarks) if available
    const toc = await buildTocFromOutline(pdf)

    return {
        sections,
        toc,
        pageList: [],
        landmarks: [],
        metadata: {
            title: info.Title || file.name?.replace(/\.pdf$/i, '') || 'Untitled PDF',
            author: info.Author || '',
            language: info.Language || '',
            publisher: info.Producer || info.Creator || '',
        },
        rendition: { layout: 'reflowable' },
        dir: 'ltr',
    }
}

/**
 * Create a section object for a single PDF page.
 * The section lazily loads and renders the page text as an HTML document.
 */
function createPageSection(pdf, pageNum) {
    const index = pageNum - 1
    let cachedDoc = null
    let cachedUrl = null

    return {
        id: `page-${pageNum}`,
        index,
        linear: 'yes',
        size: 0, // unknown until loaded
        cfi: `epubcfi(/6/${index * 2}!/4)`,
        // foliate-js's paginator calls load() and expects a STRING (a URL
        // it can set as an iframe src). It does NOT accept a Document object.
        // Return a blob URL pointing to the page's HTML content.
        load: async () => {
            if (cachedUrl) return cachedUrl
            const doc = await createDocument()
            const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8">' +
                '<style>body{font-family:serif;margin:1em;line-height:1.6;}</style>' +
                '</head><body>' + doc.body.innerHTML + '</body></html>'
            const blob = new Blob([html], { type: 'text/html' })
            cachedUrl = URL.createObjectURL(blob)
            return cachedUrl
        },
        unload: () => {
            if (cachedUrl) {
                URL.revokeObjectURL(cachedUrl)
                cachedUrl = null
            }
        },
        createDocument: async () => {
            if (cachedDoc) return cachedDoc
            console.log('[pdf.js] Extracting text from page', pageNum)
            const page = await pdf.getPage(pageNum)
            const textContent = await page.getTextContent()
            console.log('[pdf.js] Page', pageNum, ':', textContent.items.length, 'text items')

            // Build an HTML document with the page's text
            const doc = document.implementation.createHTMLDocument(`Page ${pageNum}`)
            const body = doc.body
            body.style.fontFamily = 'serif'
            body.style.margin = '1em'

            const items = textContent.items
            if (items.length === 0) {
                // No extractable text — probably a scanned/image-only page
                const p = doc.createElement('p')
                p.textContent = `[Page ${pageNum} has no extractable text — it may be a scanned image.]`
                p.style.color = '#999'
                p.style.fontStyle = 'italic'
                body.appendChild(p)
            } else {
                // === STEP 1: Group text items into LINES by Y position ===
                // pdfjs returns text as individual span fragments. Items on the
                // same visual line share (approximately) the same Y coordinate.
                // Use a font-size-relative threshold — typical line height is
                // 1.2× font size, so items within 0.5× font size of each other
                // vertically are on the same line.
                const avgFontSize = items.reduce((s, it) => s + (it.height || 12), 0) / items.length
                const yThreshold = avgFontSize * 0.5

                // Build a map: Y position → list of items on that line
                const lineMap = new Map()
                for (const item of items) {
                    if (!item.str) continue
                    const y = item.transform?.[5] ?? 0
                    // Find an existing line within threshold
                    let foundKey = null
                    for (const [existingY] of lineMap) {
                        if (Math.abs(y - existingY) < yThreshold) {
                            foundKey = existingY
                            break
                        }
                    }
                    const key = foundKey ?? y
                    if (!lineMap.has(key)) lineMap.set(key, [])
                    lineMap.get(key).push(item)
                }

                // === STEP 2: Sort lines top-to-bottom and build line text ===
                // PDF coordinate system: Y=0 at bottom, increasing upward.
                // Sort descending by Y so top-of-page lines come first.
                const sortedLines = [...lineMap.entries()]
                    .sort((a, b) => b[0] - a[0])

                const lines = sortedLines.map(([_, lineItems]) => {
                    // Sort items left-to-right within the line
                    lineItems.sort((a, b) =>
                        (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0))

                    // Join items, inserting spaces when there's an X gap
                    let text = ''
                    let prevEndX = null
                    for (const item of lineItems) {
                        const x = item.transform?.[4] ?? 0
                        if (prevEndX !== null) {
                            const gap = x - prevEndX
                            // Insert a space if the gap is > 0.2× font size
                            // (covers missing spaces between word fragments)
                            if (gap > avgFontSize * 0.2 && !text.endsWith(' ')) {
                                text += ' '
                            }
                        }
                        text += item.str
                        prevEndX = x + (item.width || item.str.length * avgFontSize * 0.5)
                    }
                    return text.trim()
                }).filter(t => t.length > 0)

                // === STEP 3: Group lines into PARAGRAPHS ===
                // Consecutive lines with small Y gaps are the same paragraph.
                // A larger Y gap (paragraph break) starts a new <p>.
                // Use the average line gap to detect paragraph breaks: if the
                // gap between two lines is > 1.5× the average line gap, it's
                // a paragraph break.
                const paragraphs = []
                let currentParagraph = []

                for (let i = 0; i < lines.length; i++) {
                    currentParagraph.push(lines[i])
                    // Check if the NEXT line starts a new paragraph
                    if (i < lines.length - 1) {
                        const [y1] = sortedLines[i]
                        const [y2] = sortedLines[i + 1]
                        const gap = y1 - y2  // positive: next line is below
                        // Estimate average line height from font size
                        const lineGap = avgFontSize * 1.2
                        // If gap > 1.8× normal line gap → paragraph break
                        if (gap > lineGap * 1.8) {
                            paragraphs.push(currentParagraph.join(' '))
                            currentParagraph = []
                        }
                    }
                }
                if (currentParagraph.length > 0) {
                    paragraphs.push(currentParagraph.join(' '))
                }

                // === STEP 4: Create <p> elements ===
                for (const para of paragraphs) {
                    if (para.trim()) {
                        const p = doc.createElement('p')
                        p.textContent = para
                        body.appendChild(p)
                    }
                }
            }

            cachedDoc = doc
            return doc
        },
    }
}

/**
 * Build a foliate-js-compatible TOC from the PDF's outline (bookmarks).
 */
async function buildTocFromOutline(pdf) {
    try {
        const outline = await pdf.getOutline()
        if (!outline || outline.length === 0) return []

        const toc = []
        for (const item of outline) {
            const entry = { label: item.title || 'Untitled', href: '' }
            if (item.dest) {
                // Resolve the destination to a page number
                try {
                    let dest = item.dest
                    if (typeof dest === 'string') {
                        dest = await pdf.getDestination(dest)
                    }
                    if (dest && dest[0]) {
                        const pageIndex = await pdf.getPageIndex(dest[0])
                        entry.href = `${pageIndex}`
                    }
                } catch {
                    entry.href = '0'
                }
            }
            if (item.items && item.items.length > 0) {
                entry.subitems = item.items.map(sub => ({
                    label: sub.title || 'Untitled',
                    href: entry.href,
                }))
            }
            toc.push(entry)
        }
        return toc
    } catch {
        return []
    }
}
