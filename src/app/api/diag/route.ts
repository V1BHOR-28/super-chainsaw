import { NextResponse } from 'next/server'
export const runtime = "nodejs"

/**
 * GET /api/diag — diagnostic endpoint. Shows which env vars are configured.
 * Safe to expose — only shows whether keys are SET (not the values).
 */
export async function GET() {
  return NextResponse.json({
    env: {
      GROQ_API_KEY: process.env.GROQ_API_KEY ? `SET (len ${process.env.GROQ_API_KEY.length}, starts ${process.env.GROQ_API_KEY.slice(0, 6)}...)` : 'NOT SET',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? `SET (len ${process.env.GEMINI_API_KEY.length}, starts ${process.env.GEMINI_API_KEY.slice(0, 6)}...)` : 'NOT SET',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? `SET (len ${process.env.OPENROUTER_API_KEY.length})` : 'NOT SET',
      TAVILY_API_KEY: process.env.TAVILY_API_KEY ? 'SET' : 'NOT SET',
      SERPER_API_KEY: process.env.SERPER_API_KEY ? 'SET' : 'NOT SET',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET',
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
    },
    timestamp: new Date().toISOString(),
  })
}
