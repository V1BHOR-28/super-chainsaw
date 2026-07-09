import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/tts — This endpoint is kept for backward compatibility.
 *
 * TTS has been moved to the client side using the browser's built-in
 * SpeechSynthesis API (window.speechSynthesis). This is free, works
 * on all browsers, and doesn't require any backend API call.
 *
 * The message-bubble component now calls window.speechSynthesis.speak()
 * directly instead of fetching from this endpoint.
 *
 * This endpoint returns a 410 Gone to signal that TTS is now client-side.
 */
export async function POST(req: NextRequest) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json(
    { error: 'TTS is now handled client-side via browser SpeechSynthesis API.' },
    { status: 410 }
  )
}
