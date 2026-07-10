import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 60
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'
import { generateEmbedding, embeddingToPgVector } from '@/lib/embeddings'

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

const MAX_CONTENT_LENGTH = 50_000 // ~12K tokens; keep embedding + retrieval sane

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

async function parsePdf(file: Blob): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const pdfParse = (await import('pdf-parse')).default
  const data = await pdfParse(buffer)
  return refineText(data.text)
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

    let embeddingClause: { embedding?: string } = {}
    try {
      const embedding = await generateEmbedding(content.slice(0, 8000))
      if (embedding) {
        embeddingClause = { embedding: embeddingToPgVector(embedding) }
      }
    } catch (e) {
      console.error('[knowledge.upload] embedding failed (stored without vector):', e instanceof Error ? e.message : String(e))
    }

    let saved: { id: string; title: string; source: string }
    if (embeddingClause.embedding) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      await db.$executeRaw`
        INSERT INTO "Knowledge" (id, "userId", title, content, source, "sourceUrl", embedding, "createdAt")
        VALUES (${id}, ${userId}, ${title}, ${content}, ${source}, ${sourceUrl ?? null}, ${embeddingClause.embedding}::vector, NOW())
      `
      saved = { id, title, source }
    } else {
      const row = await db.knowledge.create({
        data: { userId, title, content, source, sourceUrl },
      })
      saved = { id: row.id, title: row.title, source: row.source }
    }

    return NextResponse.json({
      ok: true,
      knowledge: {
        id: saved.id,
        title: saved.title,
        source: saved.source,
        contentLength: content.length,
      },
    })
  } catch (err) {
    console.error('[knowledge.upload]', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
