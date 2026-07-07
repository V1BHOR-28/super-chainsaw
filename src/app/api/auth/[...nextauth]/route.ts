import NextAuth from 'next-auth'
export const runtime = "nodejs"
import { authOptions } from '@/lib/auth'
import { NextRequest } from 'next/server'

/**
 * NextAuth route handler.
 *
 * CRITICAL FIX: NextAuth v4 was built for Next.js 13/14 where `params` was a
 * plain object. In Next.js 16, `params` is a Promise. NextAuth tries to
 * destructure `ctx.params.nextauth` synchronously, gets undefined, and
 * redirects to the error page. Fix: await the params before passing them.
 *
 * Also sets NEXTAUTH_URL dynamically from the request's host header so Google
 * OAuth's redirect_uri matches the actual domain (z.ai preview, localhost,
 * production).
 */

function setUrlFromRequest(req: NextRequest) {
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto') || 'https'
  const host = forwardedHost || req.headers.get('host')

  if (host) {
    const proto = host.includes('localhost') ? 'http' : forwardedProto
    process.env.NEXTAUTH_URL = `${proto}://${host}`
  } else {
    process.env.NEXTAUTH_URL = 'http://localhost:3000'
  }
}

const handler = NextAuth(authOptions)

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> }
) {
  setUrlFromRequest(req)
  const params = await ctx.params
  return handler(req, { params })
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> }
) {
  setUrlFromRequest(req)
  const params = await ctx.params
  return handler(req, { params })
}
