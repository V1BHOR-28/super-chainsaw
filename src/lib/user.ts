import { db } from '@/lib/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

/**
 * Returns the authenticated user's ID from the NextAuth session.
 * Throws if not authenticated — API routes should call requireUserId()
 * to get a clean 401 instead.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return null

  const userId = (session.user as { id?: string }).id
  return userId ?? null
}

/**
 * Returns the authenticated user's ID, or throws a 401-shaped error.
 * Use this in API routes that require auth:
 *
 *   const userId = await requireUserId()
 *   if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 *
 * (The function itself doesn't throw — it returns null so you can handle
 * the response shape yourself.)
 */
export async function requireUserId(): Promise<string | null> {
  return getAuthenticatedUserId()
}

/**
 * Returns the authenticated user's full profile.
 */
export async function getAuthenticatedUser() {
  const userId = await getAuthenticatedUserId()
  if (!userId) return null
  return db.user.findUnique({ where: { id: userId } })
}
