import { db } from '@/lib/db'
import { generateWithFallback } from '@/lib/llm-fallback'

const SUMMARIZE_EVERY_N_MESSAGES = 10 // trigger a re-summarize once this many new messages have piled up
const MAX_SUMMARY_WORDS = 300         // keep the summary itself bounded so it doesn't grow forever

/**
 * updateConversationSummary — best-effort, runs after a reply completes.
 * Folds any messages not yet covered by the existing summary into an updated,
 * still-bounded summary. Safe to call every turn; it no-ops until enough new
 * messages have accumulated.
 *
 * Never throws — a failed summary update must not affect the chat response.
 */
export async function updateConversationSummary(conversationId: string): Promise<void> {
  try {
    const convo = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { summary: true, summaryMessageCount: true },
    })
    if (!convo) return

    const totalCount = await db.message.count({ where: { conversationId } })
    const newMessageCount = totalCount - convo.summaryMessageCount
    if (newMessageCount < SUMMARIZE_EVERY_N_MESSAGES) return // not enough new content yet

    // Fetch only the messages not yet folded into the summary
    const newMessages = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      skip: convo.summaryMessageCount,
      select: { role: true, content: true },
    })
    if (newMessages.length === 0) return

    const transcript = newMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'ARIA'}: ${m.content.slice(0, 500)}`)
      .join('\n')

    const prompt = `You maintain a rolling summary of an ongoing conversation between a user and their AI companion, ARIA.

${convo.summary ? `EXISTING SUMMARY:\n${convo.summary}\n\n` : ''}NEW MESSAGES TO FOLD IN:\n${transcript}

Write an updated summary that combines the existing summary (if any) with what's new. Rules:
- Under ${MAX_SUMMARY_WORDS} words, total, no exceptions.
- Capture: facts the user stated, decisions made, ongoing projects/threads, the user's stated opinions or positions, anything explicitly asked to be remembered.
- Drop small talk, pleasantries, and anything not likely to matter in a future conversation.
- Write it as plain prose ARIA can reference naturally, not a bulleted transcript.
- Do not editorialize or add commentary — just compress.

Return ONLY the updated summary text, nothing else.`

    const updatedSummary = await generateWithFallback(prompt)
    if (!updatedSummary) return // best-effort — don't block or throw if generation fails

    await db.conversation.update({
      where: { id: conversationId },
      data: {
        summary: updatedSummary.trim().slice(0, 3000), // hard ceiling regardless of word-count instruction
        summaryMessageCount: totalCount,
      },
    })
  } catch (err) {
    console.error('[conversation-summary]', err)
    // Best-effort — never throw. A failed summary update should not affect the chat response.
  }
}
