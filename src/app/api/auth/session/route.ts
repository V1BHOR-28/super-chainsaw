import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { db } from '@/lib/db'

/**
 * GET /api/auth/session
 *
 * Returns the current user's profile + onboarding status.
 * Used by the frontend to decide whether to show the app, the onboarding
 * screen, or the landing page.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user?.email) {
      return NextResponse.json({ authenticated: false })
    }

    const userId = (session.user as { id?: string }).id
    if (!userId) {
      return NextResponse.json({ authenticated: false })
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        persona: true,
        age: true,
        occupation: true,
        onboarded: true,
        tier: true,
      },
    })

    if (!user) {
      return NextResponse.json({ authenticated: false })
    }

    return NextResponse.json({
      authenticated: true,
      user,
    })
  } catch (err) {
    console.error('[auth.session]', err)
    return NextResponse.json({ authenticated: false })
  }
}
