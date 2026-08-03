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
 * Response streaming is preserved for:
 *   - /api/abm/progress/<job_id> (Server-Sent Events for live progress)
 *   - /api/abm/download/<job_id> (audio MP3 streaming with range requests)
 *   - /api/abm/preview_audio/<job_id> (preview audio)
 *
 * The frontend calls /api/abm/voices, /api/abm/analyze, /api/abm/generate,
 * etc. — all relative paths, no CORS issues, works on both Vercel and sandbox.
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

  // Forward headers, excluding host (Flask sets its own)
  const headers = new Headers()
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase()
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') return
    headers.set(key, value)
  })
  // Forward the client IP for rate-limiting
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '127.0.0.1'
  headers.set('X-Forwarded-For', clientIp)

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

    // Build the response, preserving status + headers
    const responseHeaders = new Headers()
    flaskRes.headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      // Skip transfer-encoding (Next.js handles chunking) and content-encoding
      // (the proxy decompresses; let Next.js re-compress if needed)
      if (lk === 'transfer-encoding' || lk === 'content-encoding') return
      responseHeaders.set(key, value)
    })

    // Stream the body — critical for SSE progress and audio download
    return new NextResponse(flaskRes.body, {
      status: flaskRes.status,
      statusText: flaskRes.statusText,
      headers: responseHeaders,
    })
  } catch (err) {
    console.error(`[abm-proxy] Error forwarding to ${targetUrl}:`, err)
    return NextResponse.json(
      { error: 'Audiobook service unavailable', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502 }
    )
  }
}
