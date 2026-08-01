import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding, embeddingToPgVector } from '@/lib/embeddings'
import { hasHitUploadLimit, recordUpload } from '@/lib/usage'
import { chunkText } from '@/lib/chunk-text'

/**
 * GET /api/knowledge — list all knowledge entries.
 * Chunks from the same book are GROUPED into one entry so the library
 * doesn't show 100 "Part 1/100", "Part 2/100"... entries for one book.
 * The base title (without " — Part N/M") is used as the group key.
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const knowledge = await db.knowledge.findMany({
      where: { userId, source: { not: 'summary' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, source: true, sourceUrl: true, documentId: true, createdAt: true, content: true },
    })

    // Group chunks by documentId when available (the robust way), falling back
    // to base-title grouping for legacy rows uploaded before documentId existed.
    const groups = new Map<string, { id: string; title: string; source: string; sourceUrl: string | null; createdAt: Date; totalLength: number; chunkCount: number }>()

    for (const k of knowledge) {
      // Extract base title: "Book Title — Part 3/100" → "Book Title"
      const baseTitle = k.title.replace(/\s+—\s+Part\s+\d+\/\d+$/, '')
      // Prefer documentId as the group key (one upload = one documentId);
      // fall back to baseTitle for legacy rows with NULL documentId.
      const groupKey = k.documentId ?? baseTitle

      const existing = groups.get(groupKey)
      if (existing) {
        // Same document — accumulate
        existing.totalLength += k.content.length
        existing.chunkCount += 1
        // Keep the most recent createdAt
        if (k.createdAt > existing.createdAt) {
          existing.createdAt = k.createdAt
        }
      } else {
        // New document
        groups.set(groupKey, {
          id: k.documentId ?? k.id, // documentId is the stable identifier for delete
          title: baseTitle,
          source: k.source,
          sourceUrl: k.sourceUrl,
          createdAt: k.createdAt,
          totalLength: k.content.length,
          chunkCount: 1,
        })
      }
    }

    // Convert to array, sorted by most recent
    const list = Array.from(groups.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(g => ({
        id: g.id, // documentId (or legacy row id) — the client sends this back to DELETE
        title: g.title,
        source: g.source,
        sourceUrl: g.sourceUrl,
        createdAt: g.createdAt.toISOString(),
        contentLength: g.totalLength,
        chunks: g.chunkCount,
      }))

    return NextResponse.json({ knowledge: list })
  } catch (err) {
    console.error('[knowledge.list]', err)
    return NextResponse.json({ error: 'Failed to load knowledge' }, { status: 500 })
  }
}

// ─── Upload helpers ───────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 200_000 // ~50K tokens — covers most books up to 300 pages

/** Light text cleanup — collapse whitespace, strip obvious artifacts.
 *  Returns the cleaned text AND whether it was truncated, so the caller
 *  can signal silent truncation to the user instead of hiding it. */
function refineText(raw: string): { text: string; truncated: boolean } {
  const cleaned = raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000/g, '')
    .replace(/\ufeff/g, '')
    .trim()
  const truncated = cleaned.length > MAX_CONTENT_LENGTH
  return { text: cleaned.slice(0, MAX_CONTENT_LENGTH), truncated }
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

/** SSRF guard — blocks fetches to private/internal hosts and non-HTTP schemes.
 *  Known limitation: this catches IP-literal and hostname-string cases, but
 *  NOT DNS rebinding (where a public hostname resolves to a private IP at
 *  fetch time). That's an accepted gap for now. */
function isUrlSafe(urlStr: string): boolean {
  let u: URL
  try { u = new URL(urlStr) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const hostname = u.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '0.0.0.0') return false
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipMatch) {
    const [a, b] = [parseInt(ipMatch[1]), parseInt(ipMatch[2])]
    if (a === 127) return false
    if (a === 10) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false
  return true
}

async function fetchUrlContent(url: string): Promise<{ title: string; content: string; truncated: boolean }> {
  if (!isUrlSafe(url)) {
    throw new Error('This URL cannot be fetched (blocked for security reasons).')
  }

  // Archive.org _djvu.txt files are plain text — skip the HTML/cheerio path entirely.
  const parsedUrl = new URL(url)
  const isArchiveOrgText = (parsedUrl.hostname === 'archive.org' || parsedUrl.hostname === 'www.archive.org')
    && parsedUrl.pathname.endsWith('_djvu.txt')

  if (isArchiveOrgText) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARIA/1.0)' },
    })
    if (!res.ok) throw new Error(`Failed to fetch URL (HTTP ${res.status})`)
    const rawText = await res.text()
    // Strip leading/trailing whitespace-only lines — Archive.org _djvu.txt files
    // sometimes have a few blank lines at the start before the actual text begins.
    const cleaned = rawText.replace(/^\s+/, '').replace(/\s+$/, '')
    const { text: content, truncated } = refineText(cleaned)
    if (!content || content.length < 50) throw new Error('Could not extract meaningful text from the page.')
    return { title: titleFromUrl(url), content, truncated }
  }

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
  const { text: content, truncated } = refineText(bodyText)
  if (!content || content.length < 50) throw new Error('Could not extract meaningful text from the page.')
  return { title: title.slice(0, 200), content, truncated }
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
async function parsePdf(file: Blob): Promise<{ text: string; truncated: boolean }> {
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

    // Rate limit: 20 knowledge uploads/day for non-admin tiers
    const uploadLimit = await hasHitUploadLimit(userId, 'knowledge')
    if (uploadLimit.limited) {
      return NextResponse.json(
        { error: `Daily knowledge upload limit reached (${uploadLimit.limit}). Resets at ${uploadLimit.resetsAt}.` },
        { status: 429 }
      )
    }

    let title: string | undefined
    let content: string
    let source: string
    let sourceUrl: string | undefined
    let truncated = false
    let forceReupload = false

    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const file = formData.get('file')
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }
      title = (formData.get('title') as string)?.trim() || file.name || 'Uploaded document'
      forceReupload = (formData.get('forceReupload') as string) === 'true'
      const fileName = file.name.toLowerCase()
      if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
        const pdf = await parsePdf(file)
        content = pdf.text
        truncated = pdf.truncated
        source = 'pdf'
      } else if (fileName.endsWith('.txt') || fileName.endsWith('.md') || file.type.startsWith('text/')) {
        const refined = refineText(await file.text())
        content = refined.text
        truncated = refined.truncated
        source = 'file'
      } else {
        return NextResponse.json({ error: 'Unsupported file type. Please upload a PDF or text file.' }, { status: 400 })
      }
    } else {
      const body = await req.json().catch(() => ({}))
      const type = body.type
      forceReupload = body.forceReupload === true
      if (type === 'text') {
        const refined = refineText(body.content || '')
        content = refined.text
        truncated = refined.truncated
        source = 'text'
        title = body.title?.trim() || content.slice(0, 60)
      } else if (type === 'url') {
        const url = body.url?.trim()
        if (!url) return NextResponse.json({ error: 'URL is required' }, { status: 400 })
        const fetched = await fetchUrlContent(url)
        content = fetched.content
        truncated = fetched.truncated
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

    // === DE-DUPLICATION ===
    // If the user has already fed ARIA something with the same (base) title,
    // refuse the upload with a 409 unless forceReupload is set. The client
    // catches 409 and asks the user to confirm a re-upload.
    if (!forceReupload && title) {
      const existing = await db.knowledge.findFirst({
        where: { userId, title: { startsWith: title } },
        select: { documentId: true },
      })
      if (existing) {
        return NextResponse.json(
          { error: 'duplicate', message: `You've already fed ARIA something titled "${title}". Upload anyway?`, existingDocumentId: existing.documentId },
          { status: 409 }
        )
      }
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
            INSERT INTO "Knowledge" (id, "userId", title, content, source, "sourceUrl", "documentId", embedding, "createdAt")
            VALUES (${id}, ${userId}, ${chunkTitle}, ${chunk}, ${source}, ${sourceUrl ?? null}, ${documentId}, ${vectorStr}::vector, NOW())
          `
        } else {
          await db.knowledge.create({
            data: { id, userId, title: chunkTitle, content: chunk, source, sourceUrl, documentId },
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

    // === AUTO-GENERATE BOOK SUMMARY + QUOTES ===
    // After storing chunks, generate a 3-sentence summary and extract notable
    // quotes using a lightweight LLM call. Store as special "summary" and
    // "quotes" Knowledge entries so ARIA can answer "what is this book about?"
    // without searching random chunks.
    try {
      const firstChunk = chunks[0].slice(0, 2000)
      const summaryPrompt = `Summarize this book in exactly 3 sentences. Focus on the main argument, not the plot.\n\n${firstChunk}`

      // Use a quick Pollinations call (free, no API key) for the summary
      const summaryRes = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai',
          messages: [
            { role: 'system', content: 'You are a literary critic. Summarize books in 3 sharp, insightful sentences.' },
            { role: 'user', content: summaryPrompt },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (summaryRes.ok) {
        const summaryData = await summaryRes.json()
        const summaryText = summaryData.choices?.[0]?.message?.content?.trim()

        if (summaryText) {
          // Generate embedding for the summary too (so it's searchable)
          let summaryEmbedding: string | undefined
          try {
            const emb = await generateEmbedding(summaryText)
            if (emb) summaryEmbedding = embeddingToPgVector(emb)
          } catch {}

          const summaryId = `${Date.now()}-summary-${Math.random().toString(36).slice(2, 8)}`
          const summaryContent = `[BOOK SUMMARY] ${title}\n\n${summaryText}`

          if (summaryEmbedding) {
            await db.$executeRaw`
              INSERT INTO "Knowledge" (id, "userId", title, content, source, "sourceUrl", "documentId", embedding, "createdAt")
              VALUES (${summaryId}, ${userId}, ${title!}, ${summaryContent}, 'summary', NULL, ${documentId}, ${summaryEmbedding}::vector, NOW())
            `
          } else {
            await db.knowledge.create({
              data: { id: summaryId, userId, title: title!, content: summaryContent, source: 'summary', documentId },
            })
          }
          console.log(`[knowledge.upload] Auto-summary generated for "${title}"`)
        }
      }
    } catch (e) {
      console.warn('[knowledge.upload] Auto-summary failed (non-blocking):', e instanceof Error ? e.message : String(e))
    }

    // Record the upload for rate limiting
    await recordUpload(userId, 'knowledge').catch(() => {})

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
      truncated,
    })
  } catch (err) {
    console.error('[knowledge.upload]', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
