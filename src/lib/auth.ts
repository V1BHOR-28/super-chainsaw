import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import CredentialsProvider from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'

// All secrets read from environment variables — set these in Vercel dashboard
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
// No hardcoded fallback — deploying to production without NEXTAUTH_SECRET
// must fail loudly, not silently sign sessions with a known string.
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET
if (!NEXTAUTH_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('NEXTAUTH_SECRET must be set in production')
}
const EFFECTIVE_SECRET = NEXTAUTH_SECRET || 'dev-only-not-for-production'

/**
 * NextAuth configuration — ARIA's authentication system.
 *
 * Providers:
 *   1. Google OAuth — for one-click sign-in (users still go through onboarding)
 *   2. Credentials — email + password (only for verified users)
 *
 * Session strategy: JWT (stateless, works on serverless)
 *
 * The session callback enriches the token with the user's database ID so
 * API routes can scope data by the authenticated user.
 */
export const authOptions: NextAuthOptions = {
  // Trust the host header on all domains (z.ai preview, localhost, production)
  // Without this, NextAuth rejects requests from non-localhost domains.
  cookies: {
    sessionToken: {
      name: `next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    callbackUrl: {
      name: `next-auth.callback-url`,
      options: {
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    csrfToken: {
      name: `next-auth.csrf-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    pkceCodeVerifier: {
      name: `next-auth.pkce.code-verifier`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    state: {
      name: `next-auth.state`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
    nonce: {
      name: `next-auth.nonce`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
  },
  providers: [
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      // Don't request offline access or force consent — Google blocks these
      // for unverified apps with "doesn't comply with OAuth 2.0 policy" error.
      // Basic profile + email scope is all we need.
    }),

    CredentialsProvider({
      name: 'email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const email = credentials.email.toLowerCase().trim()

        const user = await db.user.findUnique({
          where: { email },
        })

        // User must exist, have a password, and be verified
        if (!user || !user.passwordHash || !user.emailVerified) {
          return null
        }

        const valid = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!valid) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        }
      },
    }),
  ],

  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },

  callbacks: {
    async jwt({ token, user, account }) {
      // On first sign-in (user is present), enrich the token with the DB user ID
      if (user) {
        token.userId = user.id

        // For ALL providers: load the user from DB to get the ID + onboarding status.
        const dbUser = await db.user.findUnique({
          where: { email: user.email! },
        })
        if (dbUser) {
          token.userId = dbUser.id
          token.onboarded = dbUser.onboarded
        }
      }

      // ALWAYS re-read onboarding status from DB on every request.
      // This ensures the token is up-to-date after the user completes onboarding
      // (the onboarding API updates the DB, but the JWT token is stale until
      // the next jwt callback run).
      if (token.userId) {
        const freshUser = await db.user.findUnique({
          where: { id: token.userId as string },
          select: { onboarded: true, name: true, persona: true },
        })
        if (freshUser) {
          token.onboarded = freshUser.onboarded
          if (freshUser.name) token.name = freshUser.name
        }
      }

      return token
    },

    async session({ session, token }) {
      // Pass the user ID + onboarding status to the client session
      if (session.user) {
        ;(session.user as { id?: string }).id = token.userId as string
        ;(session.user as { onboarded?: boolean }).onboarded = token.onboarded as boolean
      }
      return session
    },

    async signIn({ user, account }) {
      // For Google OAuth: create the user if they don't exist yet
      if (account?.provider === 'google' && user.email) {
        const existing = await db.user.findUnique({
          where: { email: user.email },
        })

        if (!existing) {
          // Create a new user from Google profile
          await db.user.create({
            data: {
              email: user.email,
              name: user.name,
              image: user.image,
              emailVerified: new Date(), // Google emails are pre-verified
              onboarded: false, // Still need onboarding
            },
          })
        }
      }

      return true
    },
  },

  pages: {
    // We handle sign-in via the landing page modal, not a separate route
    signIn: '/',
    error: '/',
  },

  // trustHost: true tells NextAuth to use the request's Host header to
  // determine the URL. This works on z.ai preview domains, localhost, and
  // production without any NEXTAUTH_URL config.
  secret: EFFECTIVE_SECRET,
  trustHost: true,
}
