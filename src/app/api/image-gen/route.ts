import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getZAI } from '@/lib/aria'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/image-gen — generate a single image from a prompt.
 * Requires authentication.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const prompt = (body.prompt as string)?.trim()
    if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 })

    const size = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'].includes(
      body.size as string
    )
      ? (body.size as string)
      : '1024x1024'

    const zai = await getZAI()
    const resp = await zai.images.generations.create({ prompt, size })
    const base64 = resp.data?.[0]?.base64
    if (!base64) return NextResponse.json({ error: 'No image returned' }, { status: 502 })

    return NextResponse.json({ url: `data:image/png;base64,${base64}`, prompt, size })
  } catch (err) {
    console.error('[image-gen]', err)
    return NextResponse.json({ error: 'Image generation failed' }, { status: 500 })
  }
}
