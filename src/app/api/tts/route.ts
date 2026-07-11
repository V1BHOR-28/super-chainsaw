import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
export const maxDuration = 30
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/tts — ElevenLabs Text-to-Speech
 *
 * Body: { text: string, hindi?: boolean }
 * Returns: audio/mpeg stream ( playable via <audio> element)
 *
 * Uses the "Sarah" voice (Mature, Reassuring, Confident) — the closest
 * to Friday from Iron Man. Calm, warm, professional female voice.
 *
 * Falls back to browser speechSynthesis if ELEVENLABS_API_KEY is not set.
 */

// Sarah — Mature, Reassuring, Confident. The Friday voice.
const ARIA_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'

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

    // Clean text for speech — strip markdown artifacts
    const cleanText = text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>~]/g, '')
      .replace(/\n+/g, '. ')
      .slice(0, 2500) // ElevenLabs can handle up to ~5000 chars, but cap for speed
      .trim()

    // Call ElevenLabs API
    // Model: eleven_turbo_v2_5 (fast, supports multilingual including Hindi)
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
          model_id: 'eleven_turbo_v2_5',
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

    // Return the audio stream directly — the frontend plays it via <audio>
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
