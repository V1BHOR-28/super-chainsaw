/**
 * pdf.js — foliate-js PDF adapter.
 *
 * Uses pdfjs-dist to extract text from PDF pages and creates a reflowable
 * book object (text-based, not image-based) that foliate-js's paginator
 * can render like an EPUB. This gives the reader selectable text, font
 * size control, and smooth pagination — better for reading than rendering
 * each page as a fixed image.
 *
 * pdfjs-dist is loaded from a CDN (jsdelivr) because these files live in
 * /public and are served as static ES modules — they can't import from
 * node_modules. The worker is also loaded from the CDN.
 */

const PDFJS_VERSION = '4.8.69'
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`
const WORKER_URL = `${PDFJS_CDN}/pdf.worker.min.mjs`

let pdfjsLib = null

async function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib
    // Dynamic import from CDN — pdfjs-dist v4 ships as an ES module
    pdfjsLib = await import(/* @vite-ignore */ `${PDFJS_CDN}/pdf.min.mjs`)
    // Set the worker URL (required for pdfjs-dist to function)
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL
    return pdfjsLib
}

/**
 * Create a foliate-js-compatible book object from a PDF file.
 * Each PDF page becomes a "section" with extracted text content.
 */
export async function makePDF(file) {
    const pdfjs = await loadPdfjs()
    const data = new Uint8Array(await file.arrayBuffer())
    const pdf = await pdfjs.getDocument({ data }).promise

    const numPages = pdf.numPages
    const metadata = await pdf.getMetadata().catch(() => ({}))
    const info = metadata?.info || {}

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
        // Navigation helpers — foliate-js uses these for TOC clicks + CFI
        splitTOCHref: href => {
            const [index, anchor] = href.split('#')
            return [parseInt(index, 10) || 0, anchor || null]
        },
        getTOCFragment: async (index, anchor) => {
            const doc = await sections[index]?.createDocument?.()
            if (!doc) return null
            if (anchor) {
                const el = doc.getElementById(anchor) || doc.querySelector(`[name="${anchor}"]`)
                if (el) return el
            }
            return doc.body?.firstElementChild || doc.body
        },
        resolveCFI: cfi => {
            // Simple CFI resolution: CFI format is epubcfi(/6/N[...]!/4...)
            // The section index is encoded in the first step. For PDFs we
            // just parse the index from a simplified CFI.
            const match = cfi.match(/\/6\/(\d+)/)
            const index = match ? Math.floor(parseInt(match[1], 10) / 2) : 0
            return { index: Math.min(index, sections.length - 1), anchor: undefined }
        },
        resolveRef: ref => {
            const [index, anchor] = String(ref).split('#')
            return { index: parseInt(index, 10) || 0, anchor }
        },
    }
}

/**
 * Create a section object for a single PDF page.
 * The section lazily loads and renders the page text as an HTML document.
 */
function createPageSection(pdf, pageNum) {
    const index = pageNum - 1
    let cachedDoc = null

    return {
        id: `page-${pageNum}`,
        index,
        linear: 'yes',
        size: 0, // unknown until loaded
        cfi: `epubcfi(/6/${index * 2}!/4)`,
        load: async () => {
            const doc = await createDocument()
            return doc
        },
        createDocument: async () => {
            if (cachedDoc) return cachedDoc
            const page = await pdf.getPage(pageNum)
            const textContent = await page.getTextContent()

            // Build an HTML document with the page's text
            const doc = document.implementation.createHTMLDocument(`Page ${pageNum}`)
            const body = doc.body
            body.style.fontFamily = 'serif'
            body.style.margin = '1em'

            // Group text items into paragraphs based on Y position
            const items = textContent.items
            if (items.length === 0) {
                // No extractable text — probably a scanned/image-only page
                const p = doc.createElement('p')
                p.textContent = `[Page ${pageNum} has no extractable text — it may be a scanned image.]`
                p.style.color = '#999'
                p.style.fontStyle = 'italic'
                body.appendChild(p)
            } else {
                let currentY = null
                let currentLine = []

                for (const item of items) {
                    const y = item.transform?.[5]
                    if (currentY !== null && Math.abs(y - currentY) > 3) {
                        // New line — flush current line as a paragraph
                        if (currentLine.length > 0) {
                            const text = currentLine.join('').trim()
                            if (text) {
                                const p = doc.createElement('p')
                                p.textContent = text
                                body.appendChild(p)
                            }
                        }
                        currentLine = []
                    }
                    currentY = y
                    currentLine.push(item.str)
                    if (item.hasEOL) {
                        const text = currentLine.join('').trim()
                        if (text) {
                            const p = doc.createElement('p')
                            p.textContent = text
                            body.appendChild(p)
                        }
                        currentLine = []
                    }
                }
                // Flush remaining
                if (currentLine.length > 0) {
                    const text = currentLine.join('').trim()
                    if (text) {
                        const p = doc.createElement('p')
                        p.textContent = text
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
