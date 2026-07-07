import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { sendVerificationEmail } from '@/lib/email'

/**
 * POST /api/auth/resend
 * Body: { email: string }
 *
 * Generates a new 6-digit code and resends it. Rate-limited to once per 60s
 * by checking the previous code's creation time (stored as verifyExpires - 14min).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = (body.email as string)?.toLowerCase().trim()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const user = await db.user.findUnique({ where: { email } })

    // Don't reveal whether the email exists
    if (!user) {
      return NextResponse.json({ ok: true, message: 'If an account exists, a new code was sent.' })
    }

    // If already verified, no need to resend
    if (user.emailVerified) {
      return NextResponse.json({ error: 'This email is already verified. Please log in.' }, { status: 400 })
    }

    // Rate limit: don't allow resend if a code was issued < 60s ago
    // verifyExpires = codeIssuedAt + 15min, so codeIssuedAt = verifyExpires - 15min
    if (user.verifyExpires) {
      const codeIssuedAt = new Date(user.verifyExpires.getTime() - 15 * 60 * 1000)
      if (Date.now() - codeIssuedAt.getTime() < 60 * 1000) {
        return NextResponse.json(
          { error: 'Please wait a minute before requesting a new code.' },
          { status: 429 }
        )
      }
    }

    // Generate new code
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const codeHash = await bcrypt.hash(code, 10)
    const verifyExpires = new Date(Date.now() + 15 * 60 * 1000)

    await db.user.update({
      where: { id: user.id },
      data: {
        verifyCode: codeHash,
        verifyExpires,
      },
    })

    const sent = await sendVerificationEmail(email, code)
    if (!sent) {
      return NextResponse.json({ error: 'Could not send email. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, message: 'New code sent to your email' })
  } catch (err) {
    console.error('[auth.resend]', err)
    return NextResponse.json({ error: 'Could not resend code' }, { status: 500 })
  }
}
