import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/cover-art
 *
 * Generates an AI book cover image from the title + author.
 * Uses the z-ai-web-dev-sdk image generation API.
 *
 * Request body: { title: string, author?: string }
 * Response: { url: string } — a data URL (base64 PNG) that can be used
 *   directly as an <img src> or stored in localStorage.
 *
 * The cover is generated at 768x1344 (portrait, 3:5 aspect ratio to match
 * the BookCover component's aspect-[3/5] container).
 *
 * On failure, returns 500 with an error message. The frontend falls back
 * to the CSS monogram cover.
 */
export async function POST(req: NextRequest) {
  try {
    const { title, author } = await req.json()

    if (!title || typeof title !== 'string') {
      return NextResponse.json(
        { error: 'title is required' },
        { status: 400 }
      )
    }

    // Build a prompt that produces a book-cover-style image.
    // The prompt is designed to work well for fiction + non-fiction:
    //   - "book cover illustration" sets the style
    //   - the title + author provide the subject
    //   - "atmospheric, cinematic lighting, detailed" ensures quality
    //   - "no text" prevents the AI from trying to render the title text
    //     (which usually looks garbled) — we overlay the title via CSS
    const authorPart = author ? ` by ${author}` : ''
    const prompt = [
      `book cover illustration for "${title}"${authorPart}`,
      'atmospheric, cinematic lighting, detailed digital painting',
      'rich colors, dramatic composition, professional book cover art',
      'no text, no letters, no typography',
    ].join(', ')

    const zai = await ZAI.create()

    const response = await zai.images.generations.create({
      prompt,
      size: '768x1344', // portrait 3:5 aspect ratio
    })

    const imageBase64 = response.data[0]?.base64
    if (!imageBase64) {
      throw new Error('No image data in response')
    }

    // Return as a data URL — can be used directly as <img src> and stored
    // in localStorage (base64 is ~1.5x the PNG size, acceptable for a cover).
    const dataUrl = `data:image/png;base64,${imageBase64}`

    return NextResponse.json({ url: dataUrl })
  } catch (error) {
    console.error('[cover-art] generation failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cover art generation failed' },
      { status: 500 }
    )
  }
}
