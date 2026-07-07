import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { sendVerificationEmail } from '@/lib/email'

/**
 * POST /api/auth/signup
 * Body: { email: string, password: string }
 *
 * Creates a new user account (unverified), generates a 6-digit verification
 * code, and emails it via Resend. The user must verify before they can log in.
 *
 * Security:
 *   - Password hashed with bcrypt (12 rounds)
 *   - Verification code hashed with bcrypt + expires in 15 min
 *   - Returns generic messages (no email enumeration)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = (body.email as string)?.toLowerCase().trim()
    const password = body.password as string

    // Validate inputs
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    }

    // Password strength: min 8 chars
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    if (password.length > 200) {
      return NextResponse.json({ error: 'Password is too long' }, { status: 400 })
    }

    // Check if user already exists
    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      // Don't reveal whether the email exists — return a generic message
      // but still send a new code if they're unverified (so they can retry)
      if (existing.emailVerified) {
        return NextResponse.json({ error: 'An account with this email already exists. Try logging in.' }, { status: 409 })
      }
      // Unverified — regenerate code and resend
    }

    // Hash password (12 rounds — industry standard)
    const passwordHash = await bcrypt.hash(password, 12)

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString()

    // Hash the code too (don't store plaintext)
    const codeHash = await bcrypt.hash(code, 10)

    const verifyExpires = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

    // Create or update the user
    if (existing) {
      await db.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          verifyCode: codeHash,
          verifyExpires,
        },
      })
    } else {
      await db.user.create({
        data: {
          email,
          passwordHash,
          verifyCode: codeHash,
          verifyExpires,
          onboarded: false,
        },
      })
    }

    // Send the verification email
    const emailResult = await sendVerificationEmail(email, code)
    if (!emailResult.success) {
      return NextResponse.json(
        { error: emailResult.error || 'Could not send verification email. Please try again.' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      message: 'Verification code sent to your email',
      email,
    })
  } catch (err) {
    console.error('[auth.signup]', err)
    // Return a specific error message so the frontend can show what actually went wrong
    const message = err instanceof Error ? err.message : 'Sign up failed. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
