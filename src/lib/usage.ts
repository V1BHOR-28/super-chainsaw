import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/** Daily token budget per tier. */
export const DAILY_LIMITS: Record<string, number> = {
  Free: 10_000,
  Partner: 100_000,
  Pro: 500_000,
  Admin: Number.MAX_SAFE_INTEGER, // effectively unlimited
}

export const DEFAULT_DAILY_LIMIT = 100_000

// Per-UTC-day upload limits for non-admin tiers.
// Admin bypasses these entirely (mirrors hasHitDailyLimit's admin check).
const DAILY_KNOWLEDGE_UPLOAD_LIMIT = 20
const DAILY_MEMORY_WRITE_LIMIT = 100

/**
 * Admin email allowlist — these users bypass the daily token limit entirely.
 * Set via the ADMIN_EMAILS env var (comma-separated) in the Vercel dashboard.
 *
 * There is intentionally NO hardcoded fallback — admin emails must be
 * configured via environment variables so they never leak into source.
 * If ADMIN_EMAILS is unset, no user receives the admin bypass.
 */
const ADMIN_EMAILS_FALLBACK: string[] = []

function getAdminEmails(): Set<string> {
  const env = process.env.ADMIN_EMAILS
  const list = env
    ? env.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : ADMIN_EMAILS_FALLBACK.map((e) => e.toLowerCase())
  return new Set(list)
}

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
 * Check if the current user is an admin (bypasses daily limit).
 * Admins are identified by email matching the ADMIN_EMAILS allowlist.
 */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const userId = await getAuthenticatedUserId()
  if (!userId) return false
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, tier: true } })
  if (!user) return false
  if (user.tier === 'Admin') return true
  return getAdminEmails().has(user.email.toLowerCase())
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
 * Admin users report a very high limit so the UI meter doesn't fill up.
 */
export async function getTodayUsage(): Promise<{
  tokensUsed: number
  requestCount: number
  dailyLimit: number
  resetsAt: string
  isAdmin: boolean
}> {
  const userId = await getAuthenticatedUserId()
  if (!userId) throw new Error("Unauthorized")
  const user = await db.user.findUnique({ where: { id: userId }, select: { tier: true, email: true } })
  const today = midnightUTC()

  const row = await db.usage.findUnique({
    where: { userId_date: { userId, date: today } },
  })

  const isAdmin = user?.tier === 'Admin' || (user?.email ? getAdminEmails().has(user.email.toLowerCase()) : false)

  return {
    tokensUsed: row?.tokensUsed ?? 0,
    requestCount: row?.requestCount ?? 0,
    dailyLimit: isAdmin ? Number.MAX_SAFE_INTEGER : getDailyLimit(user?.tier ?? 'Free'),
    resetsAt: nextMidnightUTC().toISOString(),
    isAdmin,
  }
}

/**
 * Returns true if the default user has hit their daily token limit.
 * Used to block new /api/chat requests with a friendly 429.
 * ADMIN USERS ALWAYS RETURN limited: false — they have unlimited credits.
 */
export async function hasHitDailyLimit(): Promise<{ limited: boolean; tokensUsed: number; dailyLimit: number; resetsAt: string }> {
  // Admin bypass — check before any limit logic runs
  const isAdmin = await isCurrentUserAdmin()
  if (isAdmin) {
    return {
      limited: false,
      tokensUsed: 0,
      dailyLimit: Number.MAX_SAFE_INTEGER,
      resetsAt: nextMidnightUTC().toISOString(),
    }
  }

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

/**
 * Increment today's upload count for a user. Called after a successful
 * knowledge upload or memory write. Uses the same Usage row as token tracking
 * (smallest schema change — one table, one unique constraint, two new fields).
 */
export async function recordUpload(userId: string, type: 'knowledge' | 'memory'): Promise<void> {
  const today = midnightUTC()
  const field = type === 'knowledge' ? 'knowledgeUploadCount' : 'memoryWriteCount'
  await db.usage.upsert({
    where: { userId_date: { userId, date: today } },
    create: { userId, date: today, [field]: 1 },
    update: { [field]: { increment: 1 } },
  })
}

/**
 * Check if a user has hit their daily upload limit for knowledge or memory.
 * Admins bypass entirely. Returns { limited, limit, count, resetsAt } so the
 * 429 response can include the limit and reset time.
 */
export async function hasHitUploadLimit(
  userId: string,
  type: 'knowledge' | 'memory'
): Promise<{ limited: boolean; limit: number; count: number; resetsAt: string }> {
  // Admin bypass
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, tier: true } })
  if (user?.tier === 'Admin' || (user?.email && getAdminEmails().has(user.email.toLowerCase()))) {
    return { limited: false, limit: Number.MAX_SAFE_INTEGER, count: 0, resetsAt: nextMidnightUTC().toISOString() }
  }

  const today = midnightUTC()
  const limit = type === 'knowledge' ? DAILY_KNOWLEDGE_UPLOAD_LIMIT : DAILY_MEMORY_WRITE_LIMIT
  const field = type === 'knowledge' ? 'knowledgeUploadCount' : 'memoryWriteCount'

  const row = await db.usage.findUnique({
    where: { userId_date: { userId, date: today } },
    select: { [field]: true },
  })
  const count = row?.[field] != null ? Number(row[field]) : 0

  return {
    limited: count >= limit,
    limit,
    count,
    resetsAt: nextMidnightUTC().toISOString(),
  }
}
