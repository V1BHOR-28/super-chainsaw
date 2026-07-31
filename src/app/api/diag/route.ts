import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { isCurrentUserAdmin } from '@/lib/usage'

/**
 * GET /api/diag — diagnostic endpoint. Admin-only.
 *
 * Returns a boolean-only status ('SET' / 'NOT SET') for each checked env var.
 * No key material, length, or prefix is ever exposed in the response body —
 * a partial fingerprint (prefix + exact length) would let an attacker confirm
 * which providers are configured and verify whether a leaked key belongs to
 * this environment. If you need length/prefix for debugging, log it
 * server-side with console.log, never in the JSON response.
 */
export async function GET() {
  const isAdmin = await isCurrentUserAdmin()
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    env: {
      GROQ_API_KEY: process.env.GROQ_API_KEY ? 'SET' : 'NOT SET',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? 'SET' : 'NOT SET',
      TAVILY_API_KEY: process.env.TAVILY_API_KEY ? 'SET' : 'NOT SET',
      SERPER_API_KEY: process.env.SERPER_API_KEY ? 'SET' : 'NOT SET',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET',
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
    },
    timestamp: new Date().toISOString(),
  })
}
