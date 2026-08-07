import { NextResponse } from 'next/server'

/**
 * POST /api/clear-abm-cid — clears the abm_cid cookie (set by the Flask backend).
 *
 * The abm_cid cookie is HttpOnly (set by Flask's after_request handler), so
 * JavaScript cannot delete it via document.cookie. This server-side route
 * sets the cookie to an expired value, which the browser honors regardless
 * of HttpOnly.
 *
 * Called from page.tsx when the authenticated user changes, so the Flask
 * backend issues a fresh abm_cid scoped to the new user (not the previous
 * user's stale cid).
 */
export async function POST() {
  const res = NextResponse.json({ ok: true })
  // Clear the cookie — must match the attributes Flask used when setting it
  // (httpOnly, sameSite=Lax, path=/) so the browser accepts the deletion.
  res.cookies.set('abm_cid', '', {
    expires: new Date(0),
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  })
  return res
}
