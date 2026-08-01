/**
 * ARIA — shared types
 */

export type Conversation = {
  id: string
  title: string
  pinned: boolean
  updatedAt: string
  createdAt: string
  messageCount: number
  preview: string
}

export type Attachment = {
  type: 'image'
  dataUrl: string
  name: string
}

export type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachmentsJson: string | null
  toolUsed: string | null
  createdAt: string
}

export type Memory = {
  id: string
  userId: string
  content: string
  category: string
  pinned: boolean
  source: string
  createdAt: string
  updatedAt: string
}

export type Mood = {
  id: string
  mood: 'great' | 'good' | 'okay' | 'low' | 'rough'
  note: string | null
  createdAt: string
}

export type Reminder = {
  id: string
  title: string
  dueAt: string | null
  completed: boolean
  completedAt: string | null
  createdAt: string
}

export type AriaSettings = {
  tone: string
  responseLength: string
  soundEffects: boolean
  localEncryption: boolean
  trainingOptIn: boolean
  autoDestruct: boolean
  voiceEnabled: boolean
  currentStreak: number
  longestStreak: number
  lastActiveDate: string | null
}

export type User = {
  id: string
  name: string | null
  email: string
  tier: string
}

export type Usage = {
  tokensUsed: number
  requestCount: number
  dailyLimit: number
  resetsAt: string // ISO when the daily window resets
}

export type MemoryCandidate = {
  text: string
  category: string
  confidence: 'high' | 'medium'
}

export type BookSuggestion = {
  title: string
  author: string
  canAddFullText: boolean
  sourceUrl: string | null
}

/** A message rendered in the chat UI (DB-backed + ephemeral streaming). */
export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  toolUsed?: string | null
  streaming?: boolean
  createdAt: string
  memoriesUsed?: number
  moodContext?: string | null
  /** Web sources cited in this response (for the "Found N web pages" bar). */
  sources?: Array<{ title: string; url: string; host: string }>
}
