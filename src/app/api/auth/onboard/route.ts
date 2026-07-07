import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

/**
 * POST /api/auth/onboard
 * Body: { name: string, persona: "student" | "professional", age?: number, occupation?: string }
 *
 * Saves the user's onboarding data. Only callable by authenticated users who
 * haven't completed onboarding yet.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const userId = (session.user as { id?: string }).id
    if (!userId) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const name = (body.name as string)?.trim()
    const persona = body.persona as string
    const age = typeof body.age === 'number' ? body.age : undefined
    const occupation = (body.occupation as string)?.trim() || undefined

    // Validate
    if (!name || name.length < 1 || name.length > 60) {
      return NextResponse.json({ error: 'Please enter your name' }, { status: 400 })
    }

    if (!['student', 'professional'].includes(persona)) {
      return NextResponse.json({ error: 'Please select whether you are a student or professional' }, { status: 400 })
    }

    if (age !== undefined && (age < 13 || age > 120)) {
      return NextResponse.json({ error: 'Please enter a valid age' }, { status: 400 })
    }

    if (occupation && occupation.length > 100) {
      return NextResponse.json({ error: 'Occupation is too long' }, { status: 400 })
    }

    // Update the user + mark as onboarded
    const updated = await db.user.update({
      where: { id: userId },
      data: {
        name,
        persona,
        age: age ?? null,
        occupation: occupation ?? null,
        onboarded: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        persona: true,
        age: true,
        occupation: true,
        onboarded: true,
        tier: true,
      },
    })

    // Create default settings if they don't exist
    await db.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    })

    return NextResponse.json({ ok: true, user: updated })
  } catch (err) {
    console.error('[auth.onboard]', err)
    return NextResponse.json({ error: 'Onboarding failed' }, { status: 500 })
  }
}
