'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from '@/components/aria/sidebar'
import { ChatArea } from '@/components/aria/chat-area'
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
  } = useAriaStore()

  // ─── Auth state bootstrap ───
  // Use the session from useSession() directly — the JWT callback already
  // sets token.onboarded, and the session callback passes it to the client.
  // This eliminates the extra /api/auth/session API call which can race
  // on Vercel serverless (causing Google users to skip onboarding).
  useEffect(() => {
    if (status === 'loading') return

    if (status === 'unauthenticated' || !session?.user) {
      setAuthState('unauthenticated')
      return
    }

    // Authenticated — check onboarding status directly from the session
    // (set by the JWT callback → session callback)
    const userEmail = session.user.email || ''
    const userName = session.user.name || ''
    const userImage = (session.user as { image?: string | null }).image || null
    const userId = (session.user as { id?: string }).id || ''
    const onboarded = (session.user as { onboarded?: boolean }).onboarded

    // Set basic user info from session.
    // tier is set to a safe 'Free' default here — the subsequent /api/settings
    // fetch in the bootstrap effect overwrites it with the real value. We avoid
    // 'Partner' (a paid tier) so the sidebar profile chip never lies about the
    // user's plan while the settings fetch is in flight.
    //
    // Note: `as any` is preserved from the original code — the User type in
    // types.ts doesn't declare `image`, but the rest of the app reads
    // user.image (e.g. message-bubble avatar). Widening the type is out of
    // scope for this fix.
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
      setAuthState('authenticated')
    }
  }, [status, session, setAuthState, setUser])

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
        <ChatArea />
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
