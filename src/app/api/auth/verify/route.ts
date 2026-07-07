import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'

/**
 * POST /api/auth/verify
 * Body: { email: string, code: string }
 *
 * Verifies the 6-digit code. If valid and not expired, marks the user's email
 * as verified so they can log in.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = (body.email as string)?.toLowerCase().trim()
    const code = (body.code as string)?.trim()

    if (!email || !code) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400 })
    }

    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Code must be 6 digits' }, { status: 400 })
    }

    const user = await db.user.findUnique({ where: { email } })

    if (!user || !user.verifyCode || !user.verifyExpires) {
      return NextResponse.json({ error: 'No verification pending. Please sign up first.' }, { status: 400 })
    }

    // Check expiry
    if (new Date() > user.verifyExpires) {
      return NextResponse.json({ error: 'This code has expired. Please request a new one.' }, { status: 410 })
    }

    // Verify the code (bcrypt compare)
    const valid = await bcrypt.compare(code, user.verifyCode)
    if (!valid) {
      return NextResponse.json({ error: 'Incorrect code. Please try again.' }, { status: 401 })
    }

    // Mark email as verified + clear the code
    await db.user.update({
      where: { id: user.id },
      data: {
        emailVerified: new Date(),
        verifyCode: null,
        verifyExpires: null,
      },
    })

    return NextResponse.json({
      ok: true,
      message: 'Email verified! You can now log in.',
    })
  } catch (err) {
    console.error('[auth.verify]', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}
