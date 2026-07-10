import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding, embeddingToPgVector } from '@/lib/embeddings'
import { chunkText } from '@/lib/chunk-text'

/**
 * GET /api/knowledge — list all knowledge entries
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const knowledge = await db.knowledge.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, source: true, sourceUrl: true, createdAt: true, content: true },
    })

    // Truncate content for list view
    const list = knowledge.map(k => ({
      ...k,
      content: k.content.slice(0, 200) + (k.content.length > 200 ? '...' : ''),
      contentLength: k.content.length,
    }))

    return NextResponse.json({ knowledge: list })
  } catch (err) {
    console.error('[knowledge.list]', err)
    return NextResponse.json({ error: 'Failed to load knowledge' }, { status: 500 })
  }
}

// ─── Upload helpers ───────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 200_000 // ~50K tokens — covers most books up to 300 pages

/** Light text cleanup — collapse whitespace, strip obvious artifacts. */
function refineText(raw: string): string {
  return raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000/g, '')
    .replace(/\ufeff/g, '')
    .trim()
    .slice(0, MAX_CONTENT_LENGTH)
}

// chunkText is imported from '@/lib/chunk-text' — shared between client and server

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.split('/').filter(Boolean).pop() || u.hostname
    return decodeURIComponent(path).replace(/[-_]/g, ' ').slice(0, 80) || u.hostname
  } catch {
    return 'URL'
  }
}

async function fetchUrlContent(url: string): Promise<{ title: string; content: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARIA/1.0)' },
  })
  if (!res.ok) throw new Error(`Failed to fetch URL (HTTP ${res.status})`)
  const html = await res.text()
  const cheerio = await import('cheerio')
  const $ = cheerio.load(html)
  $('script, style, nav, footer, header, aside, noscript, iframe').remove()
  const title = $('title').first().text().trim() || titleFromUrl(url)
  const bodyText = $('article, main, [role=main]').first().text() || $('body').text()
  const content = refineText(bodyText)
  if (!content || content.length < 50) throw new Error('Could not extract meaningful text from the page.')
  return { title: title.slice(0, 200), content }
}

/**
 * Parse a PDF Blob into text using `unpdf`.
 *
 * `unpdf` is specifically designed for serverless/Node.js environments and
 * handles the two issues that break raw pdfjs-dist on Vercel:
 *   1. DOMMatrix (browser-only API) — unpdf polyfills this internally
 *   2. Worker module resolution — unpdf runs in fake-worker mode without
 *      needing to load a separate worker file
 *
 * Using raw pdfjs-dist or pdf-parse caused "DOMMatrix is not defined" and
 * "Setting up fake worker failed: Cannot find module pdf.worker.mjs" errors
 * on Vercel's serverless runtime.
 */
async function parsePdf(file: Blob): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const uint8 = new Uint8Array(arrayBuffer)
  const { extractText } = await import('unpdf')
  const { text } = await extractText(uint8, { mergePages: true })
  return refineText(text)
}

/**
 * POST /api/knowledge — upload knowledge to ARIA's digital library.
 * Body (JSON): { type: 'text' | 'url', content?: string, url?: string }
 * Body (multipart/form-data): { file: Blob (PDF or TXT), title?: string }
 *
 * Ingests knowledge: text, URL (fetches + extracts), or PDF (parses).
 * Generates an embedding for semantic retrieval so the chat route can
 * find this knowledge when the user asks related questions.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let title: string | undefined
    let content: string
    let source: string
    let sourceUrl: string | undefined

    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const file = formData.get('file')
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }
      title = (formData.get('title') as string)?.trim() || file.name || 'Uploaded document'
      const fileName = file.name.toLowerCase()
      if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
        content = await parsePdf(file)
        source = 'pdf'
      } else if (fileName.endsWith('.txt') || fileName.endsWith('.md') || file.type.startsWith('text/')) {
        content = refineText(await file.text())
        source = 'file'
      } else {
        return NextResponse.json({ error: 'Unsupported file type. Please upload a PDF or text file.' }, { status: 400 })
      }
    } else {
      const body = await req.json().catch(() => ({}))
      const type = body.type
      if (type === 'text') {
        content = refineText(body.content || '')
        source = 'text'
        title = body.title?.trim() || content.slice(0, 60)
      } else if (type === 'url') {
        const url = body.url?.trim()
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 })
        const fetched = await fetchUrlContent(url)
        content = fetched.content
        title = fetched.title
        source = 'url'
        sourceUrl = url
      } else {
        return NextResponse.json({ error: 'Invalid type. Use text, url, or upload a file.' }, { status: 400 })
      }
    }

    if (!content || content.length < 10) {
      return NextResponse.json({ error: 'Could not extract enough text to learn from. Try a different source.' }, { status: 400 })
    }

    // === CHUNKING ===
    // Split the content into ~3000-char chunks at paragraph boundaries.
    // Each chunk is stored as a separate Knowledge row with its own embedding,
    // so semantic search can find the RIGHT section from anywhere in a 300-page
    // book. Without this, only the first ~50 pages would be retrievable.
    const chunks = chunkText(content)
    const totalChunks = chunks.length
    const documentId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    console.log(`[knowledge.upload] Chunking: ${content.length} chars → ${totalChunks} chunks (doc: ${documentId})`)

    // Generate embeddings for all chunks in parallel (batched to avoid rate limits).
    // Each embedding is ~750 tokens, so even 60 chunks = 45K tokens = $0.001 (essentially free).
    // Batch in groups of 10 to avoid hammering the OpenAI API.
    const BATCH_SIZE = 10
    const embeddings: (number[] | null)[] = new Array(totalChunks).fill(null)

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async (chunk) => {
          try {
            return await generateEmbedding(chunk.slice(0, 8000))
          } catch {
            return null // best-effort — chunk stored without embedding, still keyword-searchable
          }
        })
      )
      batchResults.forEach((emb, j) => { embeddings[i + j] = emb })
    }

    const embeddedCount = embeddings.filter(e => e !== null).length
    console.log(`[knowledge.upload] Embeddings: ${embeddedCount}/${totalChunks} chunks embedded`)

    // Store each chunk as a separate Knowledge row.
    // Title format: "[Book Title] — Part N/M" so ARIA knows which section she's reading.
    const savedIds: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const chunkTitle = totalChunks > 1
        ? `${title} — Part ${i + 1}/${totalChunks}`
        : title!
      const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`
      const embedding = embeddings[i]

      try {
        if (embedding) {
          const vectorStr = embeddingToPgVector(embedding)
          await db.$executeRaw`
            INSERT INTO "Knowledge" (id, "userId", title, content, source, "sourceUrl", embedding, "createdAt")
            VALUES (${id}, ${userId}, ${chunkTitle}, ${chunk}, ${source}, ${sourceUrl ?? null}, ${vectorStr}::vector, NOW())
          `
        } else {
          await db.knowledge.create({
            data: { id, userId, title: chunkTitle, content: chunk, source, sourceUrl },
          })
        }
        savedIds.push(id)
      } catch (e) {
        console.error(`[knowledge.upload] Failed to store chunk ${i + 1}:`, e instanceof Error ? e.message : String(e))
        // Continue — partial storage is better than total failure
      }
    }

    if (savedIds.length === 0) {
      return NextResponse.json({ error: 'Failed to store any chunks. Check database connection.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      knowledge: {
        id: savedIds[0],
        documentId,
        title: title!,
        source,
        contentLength: content.length,
        chunks: savedIds.length,
        embedded: embeddedCount,
      },
    })
  } catch (err) {
    console.error('[knowledge.upload]', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
