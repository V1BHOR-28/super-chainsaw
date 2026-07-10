'use client'

import { create } from 'zustand'
import type {
  Conversation,
  ChatMessage,
  Memory,
  Mood,
  Reminder,
  AriaSettings,
  User,
  Usage,
  MemoryCandidate,
  Attachment,
} from '@/lib/types'

type SidebarPanel = 'conversations' | 'memory' | 'mood' | 'reminders'

type AriaState = {
  // User + settings
  user: User | null
  settings: AriaSettings | null
  setSettings: (s: AriaSettings) => void
  setUser: (u: User) => void

  // Conversations
  conversations: Conversation[]
  setConversations: (c: Conversation[]) => void
  upsertConversation: (c: Conversation) => void
  removeConversation: (id: string) => void

  activeConversationId: string | null
  setActiveConversation: (id: string | null) => void

  messages: ChatMessage[]
  setMessages: (m: ChatMessage[]) => void
  appendMessage: (m: ChatMessage) => void
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void
  removeMessage: (id: string) => void

  // Pending attachments for the next user message
  pendingAttachments: Attachment[]
  setPendingAttachments: (a: Attachment[]) => void

  // Active tool for next send (web search / image gen)
  pendingTool: 'web_search' | 'image_generation' | null
  setPendingTool: (t: 'web_search' | 'image_generation' | null) => void

  // Sidebar UI
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (v: boolean) => void

  activePanel: SidebarPanel
  setActivePanel: (p: SidebarPanel) => void

  // Memory / Mood / Reminders
  memories: Memory[]
  setMemories: (m: Memory[]) => void
  upsertMemory: (m: Memory) => void
  removeMemory: (id: string) => void

  moods: Mood[]
  setMoods: (m: Mood[]) => void
  prependMood: (m: Mood) => void
  removeMood: (id: string) => void

  reminders: Reminder[]
  setReminders: (r: Reminder[]) => void
  upsertReminder: (r: Reminder) => void
  removeReminder: (id: string) => void

  // Settings modal
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void

  // Feed ARIA modal
  feedAriaOpen: boolean
  setFeedAriaOpen: (v: boolean) => void

  // Sending state
  isStreaming: boolean
  setStreaming: (v: boolean) => void

  // Pending memory candidate from auto-detection (shown as an ask card below
  // the latest ARIA reply). Only one at a time — high confidence auto-saves
  // silently; medium confidence surfaces here for the user to decide.
  pendingMemoryCandidate: MemoryCandidate | null
  setPendingMemoryCandidate: (c: MemoryCandidate | null) => void

  // Auth (real multi-user authentication)
  authState: 'loading' | 'unauthenticated' | 'needs-onboarding' | 'authenticated'
  setAuthState: (s: 'loading' | 'unauthenticated' | 'needs-onboarding' | 'authenticated') => void
  authModalOpen: boolean
  setAuthModalOpen: (v: boolean) => void

  // Legacy — kept for backward compat with the landing page iframe bridge
  signedOut: boolean
  setSignedOut: (v: boolean) => void

  // Usage meter
  usage: Usage | null
  setUsage: (u: Usage | null) => void
  /** Increment local usage estimate after a streamed response completes. */
  addUsage: (tokens: number) => void
}

export const useAriaStore = create<AriaState>((set) => ({
  user: null,
  settings: null,
  setSettings: (s) => set({ settings: s }),
  setUser: (u) => set({ user: u }),

  conversations: [],
  setConversations: (c) => set({ conversations: c }),
  upsertConversation: (c) =>
    set((state) => {
      const exists = state.conversations.find((x) => x.id === c.id)
      const next = exists
        ? state.conversations.map((x) => (x.id === c.id ? { ...x, ...c } : x))
        : [c, ...state.conversations]
      // Re-sort: pinned first, then updatedAt desc
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
      return { conversations: next }
    }),
  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeConversationId:
        state.activeConversationId === id ? null : state.activeConversationId,
      messages: state.activeConversationId === id ? [] : state.messages,
    })),

  activeConversationId: null,
  setActiveConversation: (id) => set({ activeConversationId: id }),

  messages: [],
  setMessages: (m) => set({ messages: m }),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  removeMessage: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

  pendingAttachments: [],
  setPendingAttachments: (a) => set({ pendingAttachments: a }),

  pendingTool: null as 'web_search' | 'image_generation' | null,
  setPendingTool: (t) => set({ pendingTool: t }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

  activePanel: 'conversations',
  setActivePanel: (p) => set({ activePanel: p }),

  memories: [],
  setMemories: (m) => set({ memories: m }),
  upsertMemory: (mem) =>
    set((s) => {
      const exists = s.memories.find((x) => x.id === mem.id)
      const next = exists
        ? s.memories.map((x) => (x.id === mem.id ? { ...x, ...mem } : x))
        : [mem, ...s.memories]
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
      return { memories: next }
    }),
  removeMemory: (id) =>
    set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),

  moods: [],
  setMoods: (m) => set({ moods: m }),
  prependMood: (mood) => set((s) => ({ moods: [mood, ...s.moods] })),
  removeMood: (id) =>
    set((s) => ({ moods: s.moods.filter((m) => m.id !== id) })),

  reminders: [],
  setReminders: (r) => set({ reminders: r }),
  upsertReminder: (rem) =>
    set((s) => {
      const exists = s.reminders.find((x) => x.id === rem.id)
      const next = exists
        ? s.reminders.map((x) => (x.id === rem.id ? { ...x, ...rem } : x))
        : [rem, ...s.reminders]
      next.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1
        if (a.dueAt && b.dueAt) return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
        if (a.dueAt) return -1
        if (b.dueAt) return 1
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      })
      return { reminders: next }
    }),
  removeReminder: (id) =>
    set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) })),

  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  feedAriaOpen: false,
  setFeedAriaOpen: (v) => set({ feedAriaOpen: v }),

  isStreaming: false,
  setStreaming: (v) => set({ isStreaming: v }),

  pendingMemoryCandidate: null,
  setPendingMemoryCandidate: (c) => set({ pendingMemoryCandidate: c }),

  authState: 'loading',
  setAuthState: (s) => set({ authState: s }),
  authModalOpen: false,
  setAuthModalOpen: (v) => set({ authModalOpen: v }),

  signedOut: false,
  setSignedOut: (v) => set({ signedOut: v }),

  usage: null,
  setUsage: (u) => set({ usage: u }),
  addUsage: (tokens) =>
    set((s) => {
      if (!s.usage) return {}
      return {
        usage: {
          ...s.usage,
          tokensUsed: s.usage.tokensUsed + tokens,
          requestCount: s.usage.requestCount + 1,
        },
      }
    }),
}))
