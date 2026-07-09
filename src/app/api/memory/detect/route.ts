import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * POST /api/memory/detect
 * Body: { userMessage: string, ariaReply: string }
 *
 * Uses OpenRouter API (same key as chat) to extract memory candidates.
 * No Z.ai dependency.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const userMessage = (body.userMessage as string)?.trim()
    const ariaReply = (body.ariaReply as string)?.trim()

    if (!userMessage || !ariaReply) {
      return NextResponse.json({ candidates: [] })
    }

    // Skip detection for tiny messages
    if (userMessage.length < 30) {
      return NextResponse.json({ candidates: [] })
    }

    // Load past decisions for in-context learning
    const decisions = await db.memoryDecision.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    })

    // Load existing memories for dedup
    const existingMemories = await db.memory.findMany({
      where: { userId },
      select: { content: true },
      take: 30,
    })

    const examplesBlock =
      decisions.length > 0
        ? `\n\nTHE USER'S PAST MEMORY DECISIONS:\n${decisions
            .map((d) => `- ${d.accepted ? 'SAVED' : 'SKIPPED'}: "${d.candidateText}" (${d.category})`)
            .join('\n')}\n`
        : '\n\n(No past decisions yet — be conservative.)\n'

    const existingBlock =
      existingMemories.length > 0
        ? `\n\nEXISTING MEMORIES (do not propose duplicates):\n${existingMemories.map((m) => `- "${m.content}"`).join('\n')}\n`
        : ''

    const prompt = `You are ARIA's memory curator. Read the exchange and extract 0-2 memory candidates.

USER SAID: "${userMessage.slice(0, 800)}"
ARIA REPLIED: "${ariaReply.slice(0, 800)}"${examplesBlock}${existingBlock}

RULES:
- SAVE: permanent facts, stable preferences, identities, goals, relationships
- SKIP: transient states, temporary emotions, small talk
- "high" = clear fact (auto-save), "medium" = borderline (ask user)
- NEVER propose duplicates

Respond with ONLY JSON: {"candidates":[{"text":"...","category":"personal|preference|goal|fact|general","confidence":"high|medium"}]}`

    const apiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ariav2-seven.vercel.app',
        'X-Title': 'ARIA',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!apiResponse.ok) {
      return NextResponse.json({ candidates: [] })
    }

    const apiData = await apiResponse.json()
    const raw = apiData.choices?.[0]?.message?.content ?? ''

    let parsed: { candidates?: Array<{ text: string; category: string; confidence: string }> } = { candidates: [] }
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
    } catch {
      // ignore
    }

    const candidates = (parsed.candidates || [])
      .filter((c) => c.text && c.text.length > 3 && c.text.length < 300 && ['high', 'medium'].includes(c.confidence))
      .map((c) => (c.category === 'personal' && c.confidence === 'high' ? { ...c, confidence: 'medium' } : c))
      .slice(0, 2)

    return NextResponse.json({ candidates })
  } catch (err) {
    console.error('[memory.detect]', err)
    return NextResponse.json({ candidates: [] })
  }
}
