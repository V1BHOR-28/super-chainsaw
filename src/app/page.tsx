'use client'

import { useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from '@/components/aria/sidebar'
import { ChatArea } from '@/components/aria/chat-area'
import { AudiobookWorkspace } from '@/components/aria/audiobook-workspace'
import { SettingsModal } from '@/components/aria/settings-modal'
import { FeedAriaModal } from '@/components/aria/feed-aria-modal'
import { LandingPage } from '@/components/aria/landing-page'
import { AuthModal } from '@/components/aria/auth-modal'
import { OnboardingScreen } from '@/components/aria/onboarding-screen'
import { useAriaStore } from '@/lib/store'

export default function HomePage() {
  const { data: session, status } = useSession()
  const {
    authState,
    setAuthState,
    authModalOpen,
    setAuthModalOpen,
    setSettings,
    setUser,
    setConversations,
    setActiveConversation,
    setUsage,
    activeWorkspace,
  } = useAriaStore()

  // ─── Auth state bootstrap ───
  // Use the session from useSession() directly — the JWT callback already
  // sets token.onboarded, and the session callback passes it to the client.
  // This eliminates the extra /api/auth/session API call which can race
  // on Vercel serverless (causing Google users to skip onboarding).
  // Track whether onboarding has been completed THIS session so the
  // session effect below doesn't override 'authenticated' with a stale
  // session (race condition: updateSession() may return a session where
  // onboarded is still false before the JWT cookie refreshes).
  // Uses the store's justOnboarded flag (set by onboarding-screen.tsx).
  const onboardingCompletedRef = useRef(false)
  const justOnboarded = useAriaStore((s) => s.justOnboarded)
  useEffect(() => {
    if (justOnboarded) onboardingCompletedRef.current = true
  }, [justOnboarded])

  useEffect(() => {
    if (status === 'loading') return

    if (status === 'unauthenticated' || !session?.user) {
      onboardingCompletedRef.current = false
      setAuthState('unauthenticated')
      return
    }

    // GUARD: once the user has completed onboarding in this session,
    // never flip back to 'needs-onboarding' even if the session is stale.
    // This prevents the onboarding loop where updateSession() returns a
    // session with onboarded=false before the JWT cookie refreshes.
    if (onboardingCompletedRef.current) {
      // Still update user info from the session, but don't touch authState.
      const userEmail = session.user.email || ''
      const userName = session.user.name || ''
      const userImage = (session.user as { image?: string | null }).image || null
      const userId = (session.user as { id?: string }).id || ''
      setUser({
        id: userId,
        email: userEmail,
        name: userName,
        image: userImage,
        tier: 'Free',
      } as any)
      return
    }

    // Authenticated — check onboarding status directly from the session
    // (set by the JWT callback → session callback)
    const userEmail = session.user.email || ''
    const userName = session.user.name || ''
    const userImage = (session.user as { image?: string | null }).image || null
    const userId = (session.user as { id?: string }).id || ''
    const onboarded = (session.user as { onboarded?: boolean }).onboarded

    setUser({
      id: userId,
      email: userEmail,
      name: userName,
      image: userImage,
      tier: 'Free',
    } as any)

    if (!onboarded) {
      setAuthState('needs-onboarding')
    } else {
      onboardingCompletedRef.current = true
      setAuthState('authenticated')
    }
  }, [status, session, setAuthState, setUser])

  // ─── Clear stale abm_cid cookie on user change ───
  // The Flask backend's abm_cid cookie is a 1-year HttpOnly cookie NOT tied
  // to the NextAuth session. Without this, a new user on the same browser
  // inherits the previous user's Flask client ID and sees their audiobook
  // library (e.g. admin's "Pride and Prejudice" test book). When the
  // authenticated user's ID changes, delete the abm_cid cookie so the Flask
  // backend issues a fresh one on the next request.
  const prevUserIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const currentUserId = (session?.user as { id?: string } | undefined)?.id || null
    if (currentUserId && prevUserIdRef.current && prevUserIdRef.current !== currentUserId) {
      // User changed — clear the abm_cid cookie so Flask issues a fresh one.
      document.cookie = 'abm_cid=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    }
    if (currentUserId) prevUserIdRef.current = currentUserId
  }, [session])

  // ─── App data bootstrap (only when authenticated + onboarded) ───
  useEffect(() => {
    if (authState !== 'authenticated') return

    // Default the sidebar to collapsed on mobile (< 768px)
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      useAriaStore.getState().setSidebarCollapsed(true)
    }

    ;(async () => {
      try {
        const [settingsRes, convRes, usageRes] = await Promise.all([
          fetch('/api/settings'),
          fetch('/api/conversations'),
          fetch('/api/usage'),
        ])
        if (settingsRes.ok) {
          const data = await settingsRes.json()
          if (data.settings) setSettings(data.settings)
          if (data.user) setUser(data.user)
        }
        if (convRes.ok) {
          const data = await convRes.json()
          if (data.conversations?.length) {
            setConversations(data.conversations)
            setActiveConversation(data.conversations[0].id)
            try {
              const msgRes = await fetch(`/api/conversations/${data.conversations[0].id}`)
              if (msgRes.ok) {
                const msgData = await msgRes.json()
                const msgs = (msgData.conversation.messages || []).map(
                  (m: { id: string; role: string; content: string; attachmentsJson: string | null; toolUsed: string | null; createdAt: string }) => ({
                    id: m.id,
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                    attachments: m.attachmentsJson ? safeParse(m.attachmentsJson) : undefined,
                    toolUsed: m.toolUsed,
                    createdAt: m.createdAt,
                  })
                )
                useAriaStore.getState().setMessages(msgs)
              }
            } catch {
              /* ignore */
            }
          }
        }
        if (usageRes.ok) {
          const data = await usageRes.json()
          if (data.usage) setUsage(data.usage)
        }
      } catch (err) {
        console.error('[bootstrap]', err)
      }
    })()
  }, [authState, setSettings, setUser, setConversations, setActiveConversation, setUsage])

  // ─── Render ───

  // Loading state (initial auth check)
  if (authState === 'loading') {
    return (
      <div
        className="flex items-center justify-center h-dvh"
        style={{ background: 'var(--aria-bg)' }}
      >
        <div className="aria-logo-dot" style={{ animation: 'pulse 2s infinite' }} />
      </div>
    )
  }

  // Unauthenticated → landing page + auth modal
  if (authState === 'unauthenticated') {
    return (
      <>
        <LandingPage onOpenAuth={() => setAuthModalOpen(true)} />
        <AuthModal />
      </>
    )
  }

  // Authenticated but not onboarded → onboarding screen
  if (authState === 'needs-onboarding') {
    return <OnboardingScreen email={session?.user?.email || ''} />
  }

  // Fully authenticated + onboarded → the app
  return (
    <>
      <div className="flex h-dvh w-screen overflow-hidden">
        <Sidebar />
        {activeWorkspace === 'audiobooks' ? (
          <div className="flex-1 overflow-y-auto">
            <AudiobookWorkspace />
          </div>
        ) : (
          <ChatArea />
        )}
        <SettingsModal />
        <FeedAriaModal />
      </div>
      <AuthModal />
    </>
  )
}

function safeParse(json: string) {
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed
  } catch {
    /* ignore */
  }
  return undefined
}
