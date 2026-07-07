'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar, SidebarToggle } from '@/components/aria/sidebar'
import { ChatArea } from '@/components/aria/chat-area'
import { SettingsModal } from '@/components/aria/settings-modal'
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
    sidebarCollapsed,
  } = useAriaStore()

  // ─── Auth state bootstrap ───
  // Check /api/auth/session on mount to determine which screen to show.
  useEffect(() => {
    if (status === 'loading') return

    if (status === 'unauthenticated' || !session?.user) {
      setAuthState('unauthenticated')
      return
    }

    // Authenticated — check if onboarded
    ;(async () => {
      try {
        const res = await fetch('/api/auth/session')
        if (!res.ok) {
          setAuthState('unauthenticated')
          return
        }
        const data = await res.json()
        if (!data.authenticated || !data.user) {
          setAuthState('unauthenticated')
          return
        }
        setUser(data.user)
        if (!data.user.onboarded) {
          setAuthState('needs-onboarding')
          return
        }
        setAuthState('authenticated')
      } catch {
        setAuthState('unauthenticated')
      }
    })()
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
        className="flex items-center justify-center h-screen"
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
    return <OnboardingScreen email={session?.user?.email || useAriaStore.getState().user?.email || ''} />
  }

  // Fully authenticated + onboarded → the app
  return (
    <>
      <div className="flex h-screen w-screen overflow-hidden">
        {sidebarCollapsed && <SidebarToggle />}
        <Sidebar />
        <ChatArea />
        <SettingsModal />
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
