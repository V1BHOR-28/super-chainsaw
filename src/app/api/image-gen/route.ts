import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/image-gen — generate a single image from a prompt.
 * Uses Pollinations.ai — free, no API key, works on Vercel.
 * Returns a direct image URL (not base64).
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const prompt = (body.prompt as string)?.trim()
    if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 })

    // Pollinations.ai — free image generation, no API key needed
    const encodedPrompt = encodeURIComponent(prompt.slice(0, 500))
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`

    return NextResponse.json({ url: imageUrl, prompt })
  } catch (err) {
    console.error('[image-gen]', err)
    return NextResponse.json({ error: 'Image generation failed' }, { status: 500 })
  }
}
