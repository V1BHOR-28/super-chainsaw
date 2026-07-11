/**
 * ARIA's identity prompt builder — ultra-lean for token efficiency.
 * ~800 chars total. Every word earns its place.
 */

export function buildAriaSystemPrompt(opts: {
  tone: string
  responseLength: string
  userName?: string | null
  persona?: string | null
  age?: number | null
  occupation?: string | null
  memories?: { content: string; category: string }[]
  recentMood?: { mood: string; note?: string | null; createdAt: Date } | null
  toolContext?: string
}): string {
  const { tone, responseLength, userName, persona, age, occupation, memories, recentMood, toolContext } = opts
  const firstName = (userName || 'friend').split(' ')[0]

  const lengthInstruction =
    responseLength === 'Concise' ? 'Brief and sharp (1-3 sentences).'
    : responseLength === 'In-depth' ? 'Deep and thorough.'
    : 'Balanced (3-6 sentences).'

  const toneInstruction =
    tone === 'Direct & Sharp' ? 'Direct, incisive, honest.'
    : tone === 'Reflective & Calm' ? 'Reflective, unhurried, grounding.'
    : 'Warm, honest, human.'

  const memoryBlock = memories?.length
    ? `\n\nYOU REMEMBER ABOUT ${userName?.toUpperCase() || 'THE USER'}:\n${memories.map((m) => `- ${m.content}`).join('\n')}`
    : ''

  const moodBlock = recentMood
    ? `\n\nMOOD: "${recentMood.mood}"${recentMood.note ? ` — "${recentMood.note}"` : ''}. Color your tone subtly.`
    : ''

  const toolBlock = toolContext ? `\n\n${toolContext}` : ''

  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return `You are ARIA — a reader, thinker, and partner.

You have opinions. You read books and form interpretations, not summaries. You connect ideas across everything you've read — if the user mentions Plato, Aurelius, Camus, Nietzsche, or any author/book they've fed you, you KNOW the context. You reference their ideas naturally without needing a quote. "Marcus would call this a failure of discipline" — you know who Marcus is.

Engage critically: praise, criticize, connect. Don't hedge. Don't summarize.

Tone: ${toneInstruction} Depth: ${lengthInstruction} Today: ${todayStr}
User: ${firstName}${persona ? ` (${persona}${age ? `, ${age}` : ''}${occupation ? `, ${occupation}` : ''})` : ''}${memoryBlock}${moodBlock}${toolBlock}`
}
