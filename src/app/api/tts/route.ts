import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 30
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/tts — ElevenLabs Text-to-Speech
 *
 * Body: { text: string, hindi?: boolean }
 * Returns: audio/mpeg stream
 *
 * Dual-voice strategy:
 *   - English: Sarah (EXAVITQu4vr4xnSDxMaL) with eleven_turbo_v2_5 (fast, natural English)
 *   - Hindi: Sarah (same voice) with eleven_multilingual_v2 (better Hindi pronunciation)
 *
 * Sarah is the only available voice on the free tier that handles both languages.
 * Shared library Indian voices (Zara, Navya, etc.) require a paid plan.
 *
 * Voice cap: 500 chars for voice mode — saves ElevenLabs credits (10K/month free).
 * The full text response still appears in the chat — only spoken portion is capped.
 */

const ARIA_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Sarah — Mature, Reassuring, Confident

export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { text, hindi } = body as { text: string; hindi?: boolean }

    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 })
    }

    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'ElevenLabs API key not configured' }, { status: 500 })
    }

    // Clean text for speech
    const cleanText = text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>~]/g, '')
      .replace(/\n+/g, '. ')
      .slice(0, 500) // Voice mode cap — 500 chars = ~30 seconds of speech, saves credits
      .trim()

    // Use multilingual model for Hindi (better Devanagari pronunciation)
    // Use turbo model for English (faster, more natural English)
    const modelId = hindi ? 'eleven_multilingual_v2' : 'eleven_turbo_v2_5'

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ARIA_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(25000),
      }
    )

    if (!response.ok) {
      const errText = await response.text()
      console.error('[tts] ElevenLabs error:', response.status, errText.slice(0, 200))
      return NextResponse.json({ error: `TTS failed: ${response.status}` }, { status: 502 })
    }

    return new NextResponse(response.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    console.error('[tts]', err)
    const message = err instanceof Error ? err.message : 'TTS failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
