import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { db } from '@/lib/db'
import { getAuthenticatedUserId } from '@/lib/user'

/**
 * GET /api/audiobooks/job-status/[id]
 *
 * Returns the status of an audiobook conversion job.
 * Used by the frontend to poll for completion.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const userId = await getAuthenticatedUserId()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const job = await db.audiobookJob.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        errorMessage: true,
        chapterUrls: true,
        audiobookId: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    return NextResponse.json({ job })
  } catch (err) {
    console.error('[audiobook.job-status]', err)
    return NextResponse.json({ error: 'Failed to get job status' }, { status: 500 })
  }
}
