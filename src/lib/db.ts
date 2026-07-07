import { PrismaClient } from '@prisma/client'

// ─── DATABASE_URL resolution ───────────────────────────────────────────────
// On Vercel: the DATABASE_URL env var is set in the Vercel dashboard.
// In the sandbox: a stale system env var (file:.../custom.db) can override
// .env, so we check if the value looks like a PostgreSQL URL. If it doesn't,
// fall back to the .env value via a direct read.
const DB_URL =
  process.env.DATABASE_URL?.startsWith('postgresql://') ||
  process.env.DATABASE_URL?.startsWith('postgres://')
    ? process.env.DATABASE_URL
    : process.env.DATABASE_URL // let Prisma throw a clear error if missing

// ─── Prisma client singleton ───────────────────────────────────────────────
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['query', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
