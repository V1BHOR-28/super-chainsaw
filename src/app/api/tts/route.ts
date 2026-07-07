import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/aria'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/tts — convert text to speech, return audio/wav bytes.
 * Requires authentication.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const text = (body.text as string)?.trim()
    if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 })

    const clean = text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>~]/g, '')
      .replace(/\n+/g, '. ')
      .slice(0, 1000)

    const voice = typeof body.voice === 'string' ? body.voice : 'tongtong'
    const speed = typeof body.speed === 'number' && body.speed >= 0.5 && body.speed <= 2.0 ? body.speed : 1.0

    const zai = await getZAI()
    const response = await zai.audio.tts.create({
      input: clean,
      voice,
      speed,
      response_format: 'wav',
      stream: false,
    })

    const arrayBuffer = await (response as Response).arrayBuffer()
    const buffer = Buffer.from(new Uint8Array(arrayBuffer))

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    console.error('[tts]', err)
    return NextResponse.json({ error: 'TTS failed' }, { status: 500 })
  }
}
