import { NextRequest, NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/settings — fetch the default user's settings (creates row if missing)
 */
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const settings = await db.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    })
    const user = await db.user.findUnique({ where: { id: userId } })
    return NextResponse.json({ settings, user })
  } catch (err) {
    console.error('[settings.get]', err)
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 })
  }
}

/**
 * PATCH /api/settings — update tone, length, toggles, etc.
 */
export async function PATCH(req: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json().catch(() => ({}))

    const allowed: Record<string, string | boolean> = {
      tone: body.tone,
      responseLength: body.responseLength,
      modelPreference: body.modelPreference,
      soundEffects: body.soundEffects,
      localEncryption: body.localEncryption,
      trainingOptIn: body.trainingOptIn,
      autoDestruct: body.autoDestruct,
      voiceEnabled: body.voiceEnabled,
    }

    const data: Record<string, string | boolean> = {}
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) data[k] = v
    }

    // Validate enums
    if (data.tone && !['Warm & Honest', 'Direct & Sharp', 'Reflective & Calm'].includes(data.tone as string)) {
      delete data.tone
    }
    if (data.responseLength && !['Concise', 'Balanced', 'In-depth'].includes(data.responseLength as string)) {
      delete data.responseLength
    }

    // Update display name on user too
    if (typeof body.name === 'string' && body.name.trim()) {
      await db.user.update({ where: { id: userId }, data: { name: body.name.trim().slice(0, 60) } })
    }

    const settings = await db.userSettings.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    })

    return NextResponse.json({ settings })
  } catch (err) {
    console.error('[settings.patch]', err)
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 })
  }
}
