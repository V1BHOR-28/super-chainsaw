import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * POST /api/auth/check-status
 * Body: { email: string }
 *
 * Returns whether the email exists and is verified. Used by the login flow
 * to give specific error messages ("email not verified" vs "wrong password").
 *
 * This is safe to expose — it doesn't leak passwords or codes, only whether
 * an account exists and is in a usable state. We intentionally don't hide
 * "email exists" here because the signup flow already reveals that.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = (body.email as string)?.toLowerCase().trim()

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }

    const user = await db.user.findUnique({
      where: { email },
      select: { emailVerified: true },
    })

    if (!user) {
      return NextResponse.json({ exists: false, verified: false })
    }

    return NextResponse.json({
      exists: true,
      verified: !!user.emailVerified,
    })
  } catch (err) {
    console.error('[auth.check-status]', err)
    return NextResponse.json({ error: 'Check failed' }, { status: 500 })
  }
}
