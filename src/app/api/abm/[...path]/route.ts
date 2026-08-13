import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * /api/abm/[...path] — Next.js API proxy for the audiobook-maker Flask service.
 *
 * In production, the Flask app runs on Render (ABM_SERVICE_URL env var).
 * In the sandbox, it runs locally on port 5601 (default fallback).
 *
 * This proxy forwards ALL methods (GET/POST/PUT/DELETE), bodies (JSON,
 * multipart form-data, plain), query params, and headers (including cookies
 * for abm_cid session identity) to the Flask service.
 *
 * Response handling:
 *   - SSE (text/event-stream): streamed chunk-by-chunk (live progress updates)
 *   - Audio (audio/*): streamed (large files, range requests)
 *   - Everything else (JSON): buffered fully then returned (avoids truncation)
 */

const FLASK_BASE = process.env.ABM_SERVICE_URL || 'http://localhost:5601'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, params)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, params)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, params)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, params)
}

async function proxy(
  req: NextRequest,
  paramsPromise: Promise<{ path: string[] }>
) {
  const { path: pathSegments } = await paramsPromise
  // The Next.js route is /api/abm/[...path], so pathSegments captures everything
  // after /api/abm/. The Flask app's routes are under /api/, so we prepend /api.
  // Example: /api/abm/voices → Flask /api/voices
  //          /api/abm/job_status/abc → Flask /api/job_status/abc
  const flaskPath = '/api/' + pathSegments.join('/')

  // Build the target URL with query string
  const searchParams = req.nextUrl.search
  const targetUrl = `${FLASK_BASE}${flaskPath}${searchParams}`

  // Forward headers, excluding host (Flask sets its own) and accept-encoding
  // (we want Flask to send UNCOMPRESSED responses — if Flask sends gzip/br,
  // the proxy's Content-Length refers to the compressed size but the body is
  // decompressed by Node's fetch, causing a size mismatch that truncates the
  // response in the browser).
  const headers = new Headers()
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase()
    if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'accept-encoding') return
    headers.set(key, value)
  })
  // Explicitly request no encoding from Flask
  headers.set('Accept-Encoding', 'identity')
  // Forward the client IP for rate-limiting
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '127.0.0.1'
  headers.set('X-Forwarded-For', clientIp)
  // Skip ngrok free-tier warning page (interstitial HTML) for API calls
  headers.set('ngrok-skip-browser-warning', '1')

  // Forward the body as-is (works for JSON, multipart form-data, plain text)
  let body: BodyInit | null = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer()
  }

  try {
    const flaskRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      // @ts-expect-error: duplex is needed for streaming requests in Node.js fetch
      duplex: 'half',
    })

    // Build the response headers, preserving status + content-type
    const responseHeaders = new Headers()
    flaskRes.headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      // Skip transfer-encoding (Next.js handles chunking) and content-encoding
      // (the proxy decompresses; let Next.js re-compress if needed)
      if (lk === 'transfer-encoding' || lk === 'content-encoding') return
      responseHeaders.set(key, value)
    })

    const contentType = (flaskRes.headers.get('content-type') || '').toLowerCase()
    const isSSE = contentType.includes('text/event-stream')
    const isAudio = contentType.startsWith('audio/')
    const shouldStream = isSSE || isAudio

    if (shouldStream && flaskRes.body) {
      // Stream SSE + audio directly — critical for live progress and audio playback
      return new NextResponse(flaskRes.body, {
        status: flaskRes.status,
        statusText: flaskRes.statusText,
        headers: responseHeaders,
      })
    } else {
      // Buffer JSON + other responses fully — avoids truncation issues where
      // Next.js cuts the stream short before all bytes are flushed.
      // The Flask /api/analyze response can be ~8KB for a 60-chapter book;
      // buffering it fully ensures the frontend gets valid JSON.
      const buf = await flaskRes.arrayBuffer()
      return new NextResponse(buf, {
        status: flaskRes.status,
        statusText: flaskRes.statusText,
        headers: responseHeaders,
      })
    }
  } catch (err) {
    console.error(`[abm-proxy] Error forwarding to ${targetUrl}:`, err)
    return NextResponse.json(
      { error: 'Audiobook service unavailable', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502 }
    )
  }
}
