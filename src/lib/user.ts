import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

/**
 * Returns the authenticated user's ID from the NextAuth session.
 * Returns null if not authenticated — API routes should check for null
 * and return a 401 response.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return null

  const userId = (session.user as { id?: string }).id
  return userId ?? null
}
