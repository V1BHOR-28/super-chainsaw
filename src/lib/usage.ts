import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/** Daily token budget per tier. */
export const DAILY_LIMITS: Record<string, number> = {
  Free: 10_000,
  Partner: 100_000,
  Pro: 500_000,
}

export const DEFAULT_DAILY_LIMIT = 100_000

export function getDailyLimit(tier: string): number {
  return DAILY_LIMITS[tier] ?? DEFAULT_DAILY_LIMIT
}

/** Returns the UTC midnight timestamp for the day containing `date`. */
export function midnightUTC(date: Date = new Date()): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** Returns the next UTC midnight (when the daily window resets). */
export function nextMidnightUTC(date: Date = new Date()): Date {
  const m = midnightUTC(date)
  return new Date(m.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * Atomically increment today's usage for the default user.
 * Creates the row if it doesn't exist yet.
 */
export async function recordUsage(tokens: number): Promise<void> {
  const userId = await getAuthenticatedUserId()
  if (!userId) throw new Error("Unauthorized")
  const today = midnightUTC()

  await db.usage.upsert({
    where: { userId_date: { userId, date: today } },
    create: { userId, date: today, tokensUsed: tokens, requestCount: 1 },
    update: {
      tokensUsed: { increment: tokens },
      requestCount: { increment: 1 },
    },
  })
}

/**
 * Fetch today's usage for the default user, plus the tier limit + reset time.
 */
export async function getTodayUsage(): Promise<{
  tokensUsed: number
  requestCount: number
  dailyLimit: number
  resetsAt: string
}> {
  const userId = await getAuthenticatedUserId()
  if (!userId) throw new Error("Unauthorized")
  const user = await db.user.findUnique({ where: { id: userId }, select: { tier: true } })
  const today = midnightUTC()

  const row = await db.usage.findUnique({
    where: { userId_date: { userId, date: today } },
  })

  return {
    tokensUsed: row?.tokensUsed ?? 0,
    requestCount: row?.requestCount ?? 0,
    dailyLimit: getDailyLimit(user?.tier ?? 'Partner'),
    resetsAt: nextMidnightUTC().toISOString(),
  }
}

/**
 * Returns true if the default user has hit their daily token limit.
 * Used to block new /api/chat requests with a friendly 429.
 */
export async function hasHitDailyLimit(): Promise<{ limited: boolean; tokensUsed: number; dailyLimit: number; resetsAt: string }> {
  const usage = await getTodayUsage()
  return {
    limited: usage.tokensUsed >= usage.dailyLimit,
    tokensUsed: usage.tokensUsed,
    dailyLimit: usage.dailyLimit,
    resetsAt: usage.resetsAt,
  }
}

/**
 * Rough token estimate — ~4 characters per token, same heuristic Claude/ChatGPT use
 * for client-side estimates. Good enough for a meter; not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
