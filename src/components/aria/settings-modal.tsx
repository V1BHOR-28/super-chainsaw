'use client'

import { useEffect, useRef, useState } from 'react'
import {
  X,
  Settings as SettingsIcon,
  User as UserIcon,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Link2,
  LayoutGrid,
  Info,
  ChevronDown,
  Check,
  Brain,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'
import type { AriaSettings, User as AriaUser } from '@/lib/types'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { MemoryPanel } from '@/components/aria/side-panels'

type TabId = 'general' | 'account' | 'privacy' | 'customize' | 'memory'

const TABS: { id: TabId; label: string; icon: typeof SettingsIcon }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'privacy', label: 'Privacy', icon: Shield },
  { id: 'customize', label: 'Customize', icon: SlidersHorizontal },
]

const TONES = ['Warm & Honest', 'Direct & Sharp', 'Reflective & Calm'] as const
const LENGTHS = ['Balanced', 'Concise', 'In-depth'] as const

/* ---------- Small styled primitives (kept in-file to avoid new files) ---------- */

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
      style={{ borderBottom: '1px solid var(--aria-border)' }}
    >
      <div className="sm:max-w-[420px]">
        <h4 className="m-0 mb-1 text-[15px] font-medium" style={{ color: 'var(--aria-fg)' }}>
          {title}
        </h4>
        <p className="m-0 text-[13px]" style={{ color: 'var(--aria-fg-muted)' }}>
          {desc}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function AriaSelect({
  value,
  onChange,
  options,
  width = '180px',
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly string[]
  width?: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
      style={{
        width,
        background: 'var(--aria-bg-panel)',
        border: '1px solid var(--aria-border)',
        padding: '8px 12px',
        color: 'var(--aria-fg)',
        fontSize: '13px',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {options.map((o) => (
        <option key={o} value={o} style={{ background: 'var(--aria-bg-panel)' }}>
          {o}
        </option>
      ))}
    </select>
  )
}

function AriaToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange?: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="aria-toggle" aria-disabled={disabled}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="aria-toggle-slider" />
    </label>
  )
}

function IntegrationCard({
  icon,
  title,
  desc,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-xl p-4"
      style={{
        background: 'var(--aria-card)',
        border: '1px solid var(--aria-border)',
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: 'var(--aria-bg-panel)',
            color: 'var(--aria-accent-glow)',
          }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="m-0 text-[15px]" style={{ color: 'var(--aria-fg)' }}>
            {title}
          </h4>
          <p
            className="m-0 mt-1 truncate text-[13px]"
            style={{ color: 'var(--aria-fg-muted)' }}
          >
            {desc}
          </p>
        </div>
      </div>
      <button
        onClick={onAction}
        className="shrink-0 rounded-lg px-3 py-2 text-[13px] transition-colors"
        style={{
          color: 'var(--aria-accent-glow)',
          border: '1px solid var(--aria-accent-deep)',
          background: 'transparent',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      >
        {actionLabel}
      </button>
    </div>
  )
}

/* ---------- Main modal ---------- */

export function SettingsModal() {
  const open = useAriaStore((s) => s.settingsOpen)
  const setOpen = useAriaStore((s) => s.setSettingsOpen)
  const settings = useAriaStore((s) => s.settings)
  const user = useAriaStore((s) => s.user)
  const setSettings = useAriaStore((s) => s.setSettings)
  const setUser = useAriaStore((s) => s.setUser)

  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [lightMode, setLightMode] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [exporting, setExporting] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* Load settings/user whenever the modal opens */
  useEffect(() => {
    if (!open) return
    // Sync lightMode state with current DOM
    setLightMode(document.documentElement.classList.contains('light'))
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error('fetch failed')
        const data = (await res.json()) as { settings?: AriaSettings; user?: AriaUser }
        if (cancelled) return
        if (data.settings) setSettings(data.settings)
        if (data.user) {
          setUser(data.user)
          setDisplayName(data.user.name || '')
        }
      } catch {
        if (!cancelled) toast.error('Could not load settings')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, setSettings, setUser])

  /* Debounced PATCH helper */
  const patchSettings = (patch: Record<string, string | boolean>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) throw new Error('patch failed')
        const data = (await res.json()) as { settings?: AriaSettings }
        if (data.settings) setSettings(data.settings)
        // If display name was patched, mirror it in the store
        if (typeof patch.name === 'string' && user) {
          setUser({ ...user, name: patch.name })
        }
        toast.success('Saved')
      } catch {
        toast.error('Could not save')
      }
    }, 450)
  }

  const handleFullExport = async (format: 'json' | 'markdown') => {
    setExporting(true)
    try {
      const res = await fetch(`/api/export/all?format=${format}`)
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `aria-full-export-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Full export downloaded')
    } catch {
      toast.error('Could not complete export — try again')
    } finally {
      setExporting(false)
    }
  }

  const updateField = (key: keyof AriaSettings, value: string | boolean) => {
    if (!settings) {
      // Optimistically create a default settings object so UI updates instantly
      const fallback: AriaSettings = {
        tone: 'Warm & Honest',
        responseLength: 'Balanced',
        soundEffects: true,
        localEncryption: true,
        trainingOptIn: false,
        autoDestruct: false,
        voiceEnabled: false,
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: null,
      }
      setSettings({ ...fallback, [key]: value })
    } else {
      setSettings({ ...settings, [key]: value })
    }
    patchSettings({ [key]: value })
  }

  /* Esc closes the modal */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-5"
      style={{
        background: 'rgba(8, 6, 4, 0.75)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        transition: 'opacity 0.3s ease',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="aria-settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <div
        className="aria-fade-slide relative flex w-full max-w-[900px] flex-col overflow-hidden sm:flex-row"
        style={{
          background: 'var(--aria-bg-soft)',
          border: '1px solid var(--aria-border)',
          borderRadius: '24px',
          height: '85vh',
          maxHeight: '92vh',
          boxShadow:
            '0 25px 80px rgba(0,0,0,0.6), 0 0 60px rgba(245, 158, 11, 0.08)',
        }}
      >
        {/* Close */}
        <button
          aria-label="Close settings"
          onClick={() => setOpen(false)}
          className="absolute right-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
          style={{
            color: 'var(--aria-fg-muted)',
            background: 'transparent',
            border: '1px solid transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--aria-fg)'
            e.currentTarget.style.background = 'var(--aria-card)'
            e.currentTarget.style.borderColor = 'var(--aria-border)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--aria-fg-muted)'
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.borderColor = 'transparent'
          }}
        >
          <X size={18} />
        </button>

        {/* Aside */}
        <aside
          className="flex w-full shrink-0 gap-1 overflow-x-auto p-4 sm:w-[240px] sm:flex-col sm:overflow-y-auto sm:p-6"
          style={{
            background: 'rgba(0,0,0,0.2)',
            borderRight: '1px solid var(--aria-border)',
          }}
        >
          <div
            id="aria-settings-title"
            className="font-serif-aria shrink-0"
            style={{
              fontSize: '28px',
              padding: '0 12px 24px 12px',
              borderBottom: '1px solid var(--aria-border)',
              marginBottom: '16px',
              whiteSpace: 'nowrap',
            }}
          >
            Settings
          </div>
          {TABS.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="flex shrink-0 items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-sm transition-all"
                style={{
                  color: active ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                  background: active ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'var(--aria-card)'
                    e.currentTarget.style.color = 'var(--aria-fg)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'var(--aria-fg-muted)'
                  }
                }}
              >
                <Icon size={18} strokeWidth={1.5} />
                {t.label}
              </button>
            )
          })}
        </aside>

        {/* Main */}
        <main
          className="flex-1 overflow-y-auto"
          style={{ padding: '32px 24px' }}
        >
          <div className="mx-auto max-w-[640px] sm:px-4">
            {activeTab === 'general' && (
              <section className="aria-fade-slide">
                <h2
                  className="font-serif-aria"
                  style={{ fontSize: '40px', marginBottom: '8px', lineHeight: 1.1 }}
                >
                  General
                </h2>
                <p
                  style={{
                    color: 'var(--aria-fg-muted)',
                    marginBottom: '24px',
                    fontSize: '14px',
                  }}
                >
                  Configure how ARIA behaves and communicates with you.
                </p>
                <SettingRow
                  title="Tone of Voice"
                  desc="Adjust how ARIA structures her sentences and speaks to you."
                >
                  <AriaSelect
                    value={settings?.tone ?? 'Warm & Honest'}
                    onChange={(v) => updateField('tone', v)}
                    options={TONES}
                  />
                </SettingRow>
                <SettingRow
                  title="Response Length"
                  desc="Choose the default verbosity of ARIA's answers."
                >
                  <AriaSelect
                    value={settings?.responseLength ?? 'Balanced'}
                    onChange={(v) => updateField('responseLength', v)}
                    options={LENGTHS}
                  />
                </SettingRow>
                <SettingRow
                  title="Voice Responses"
                  desc="Let ARIA read her replies aloud using your browser's built-in voice. Tap the speaker icon on any message to play. Works offline — no API key needed."
                >
                  <AriaToggle
                    checked={settings?.voiceEnabled ?? false}
                    onChange={(v) => updateField('voiceEnabled', v)}
                  />
                </SettingRow>
                <SettingRow
                  title="Light Mode"
                  desc="Switch to a light theme. Amber accents stay, background becomes warm white."
                >
                  <AriaToggle
                    checked={lightMode}
                    onChange={(v) => {
                      setLightMode(v)
                      if (typeof document !== 'undefined') {
                        if (v) {
                          document.documentElement.classList.add('light')
                        } else {
                          document.documentElement.classList.remove('light')
                        }
                      }
                    }}
                  />
                </SettingRow>
                <SettingRow
                  title="AI Model"
                  desc="GPT-OSS 120B is the default — free forever, largest free model available."
                >
                  <ModelSelector
                    value={
                      settings?.modelPreference &&
                      AI_MODELS.map(m => m.id).includes(settings.modelPreference)
                        ? settings.modelPreference
                        : 'openai/gpt-oss-120b:free'
                    }
                    onChange={(v) => updateField('modelPreference', v)}
                  />
                </SettingRow>
              </section>
            )}

            {activeTab === 'account' && (
              <section className="aria-fade-slide">
                <h2
                  className="font-serif-aria"
                  style={{ fontSize: '40px', marginBottom: '8px', lineHeight: 1.1 }}
                >
                  Account
                </h2>
                <p
                  style={{
                    color: 'var(--aria-fg-muted)',
                    marginBottom: '24px',
                    fontSize: '14px',
                  }}
                >
                  Manage your personal information and subscription.
                </p>
                <SettingRow title="Display Name" desc="The name ARIA uses to greet you.">
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onBlur={() => {
                      const trimmed = displayName.trim()
                      if (trimmed && trimmed !== (user?.name || '')) {
                        patchSettings({ name: trimmed })
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    placeholder="Your name"
                    className="rounded-lg outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
                    style={{
                      width: '180px',
                      background: 'var(--aria-bg-panel)',
                      border: '1px solid var(--aria-border)',
                      padding: '8px 12px',
                      color: 'var(--aria-fg)',
                      fontSize: '13px',
                      fontFamily: 'inherit',
                    }}
                  />
                </SettingRow>
                <SettingRow
                  title="Email Address"
                  desc="Used for login and critical security alerts."
                >
                  <span
                    className="text-[13px]"
                    style={{ color: 'var(--aria-fg-muted)' }}
                  >
                    {user?.email ?? '—'}
                  </span>
                </SettingRow>
                <SettingRow
                  title="Subscription Tier"
                  desc="Your current plan."
                >
                  <button
                    disabled
                    className="rounded-lg px-3 py-2 text-[13px]"
                    style={{
                      color: 'var(--aria-accent-glow)',
                      border: '1px solid var(--aria-accent-deep)',
                      background: 'transparent',
                      cursor: 'not-allowed',
                    }}
                  >
                    {user?.tier || 'Free'}
                  </button>
                </SettingRow>
                <SettingRow
                  title="Export Everything"
                  desc="Download a full backup of every conversation, memory, fed document, mood entry, and reminder."
                >
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleFullExport('json')}
                      disabled={exporting}
                      className="rounded-lg px-3 py-2 text-[13px] transition-colors"
                      style={{
                        color: 'var(--aria-accent-glow)',
                        border: '1px solid var(--aria-accent-deep)',
                        background: 'transparent',
                        cursor: exporting ? 'not-allowed' : 'pointer',
                        opacity: exporting ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!exporting) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {exporting ? 'Exporting…' : 'JSON'}
                    </button>
                    <button
                      onClick={() => handleFullExport('markdown')}
                      disabled={exporting}
                      className="rounded-lg px-3 py-2 text-[13px] transition-colors"
                      style={{
                        color: 'var(--aria-accent-glow)',
                        border: '1px solid var(--aria-accent-deep)',
                        background: 'transparent',
                        cursor: exporting ? 'not-allowed' : 'pointer',
                        opacity: exporting ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!exporting) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {exporting ? 'Exporting…' : 'Markdown'}
                    </button>
                  </div>
                </SettingRow>
              </section>
            )}

            {activeTab === 'privacy' && (
              <section className="aria-fade-slide">
                <h2
                  className="font-serif-aria"
                  style={{ fontSize: '40px', marginBottom: '8px', lineHeight: 1.1 }}
                >
                  Privacy
                </h2>
                <p
                  style={{
                    color: 'var(--aria-fg-muted)',
                    marginBottom: '16px',
                    fontSize: '14px',
                  }}
                >
                  Control your data. ARIA is private by design.
                </p>

                {/* Honest disclaimer about the underlying model provider */}
                <div
                  className="flex items-start gap-2.5 rounded-xl p-3.5 mb-6"
                  style={{
                    background: 'rgba(245, 158, 11, 0.05)',
                    border: '1px solid rgba(245, 158, 11, 0.18)',
                  }}
                >
                  <Info
                    size={15}
                    strokeWidth={1.75}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--aria-accent-glow)' }}
                  />
                  <p
                    className="m-0 text-[12.5px] leading-relaxed"
                    style={{ color: 'var(--aria-fg-muted)' }}
                  >
                    ARIA is powered by Z.ai&apos;s GLM model. Your messages pass
                    through their API. We do not control their data retention or
                    training policies.
                  </p>
                </div>
                {/* "Local-First Encryption" toggle removed (Option A): no client-side
                    encryption is implemented — Message.content is stored as plaintext.
                    Shipping a toggle claiming otherwise would be dishonest. If real
                    client-side encryption is added later (WebCrypto AES-GCM, per-user
                    key in IndexedDB), the toggle can be restored with real behavior. */}
                <SettingRow
                  title="Training Data Opt-In"
                  desc="Allow anonymized snippets to improve ARIA's reasoning. (Off by default)"
                >
                  <AriaToggle
                    checked={settings?.trainingOptIn ?? false}
                    onChange={(v) => updateField('trainingOptIn', v)}
                  />
                </SettingRow>
                <SettingRow
                  title="Auto-Destruct Memory"
                  desc="Wipe ARIA's persistent memory after 30 days of inactivity."
                >
                  <AriaToggle
                    checked={settings?.autoDestruct ?? false}
                    onChange={(v) => updateField('autoDestruct', v)}
                  />
                </SettingRow>
              </section>
            )}

            {activeTab === 'customize' && (
              <section className="aria-fade-slide">
                <h2
                  className="font-serif-aria"
                  style={{ fontSize: '40px', marginBottom: '8px', lineHeight: 1.1 }}
                >
                  Customize
                </h2>
                <p
                  style={{
                    color: 'var(--aria-fg-muted)',
                    marginBottom: '24px',
                    fontSize: '14px',
                  }}
                >
                  Extend ARIA&apos;s capabilities with Skills, Connectors, and Plugins.
                </p>
                <IntegrationCard
                  icon={<Sparkles size={20} strokeWidth={1.5} />}
                  title="Skills"
                  desc="Teach ARIA domain-specific frameworks (e.g., Stoicism, Code Review)."
                  actionLabel="Manage"
                  onAction={() => toast.info('Coming soon')}
                />
                <IntegrationCard
                  icon={<Link2 size={20} strokeWidth={1.5} />}
                  title="Connectors"
                  desc="Link external tools (Notion, Google Drive, GitHub)."
                  actionLabel="Connect"
                  onAction={() => toast.info('Coming soon')}
                />
                <IntegrationCard
                  icon={<LayoutGrid size={20} strokeWidth={1.5} />}
                  title="Plugins"
                  desc="Enable specialized tools (Web Search, Weather, Calendars)."
                  actionLabel="Browse"
                  onAction={() => toast.info('Coming soon')}
                />
              </section>
            )}

            {activeTab === 'memory' && (
              <section className="aria-fade-slide" style={{ minHeight: '420px' }}>
                <MemoryPanel />
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

/* ---------- Model Selector (Claude-style compact dropdown) ---------- */

const AI_MODELS = [
  {
    id: 'openai/gpt-oss-120b:free',
    name: 'GPT-OSS 120B',
    desc: 'Largest free model, 117B MoE',
    badge: 'Default',
    badgeColor: 'var(--aria-accent-glow)',
    cost: 'Free forever',
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    desc: 'Strong reasoning and coding',
    badge: 'Paid',
    badgeColor: '#f59e0b',
    cost: '~$0.14/M tokens',
  },
  {
    id: 'sarvam-105b',
    name: 'Sarvam 105B',
    desc: '128K context, strong tool-use',
    badge: 'Paid',
    badgeColor: '#f59e0b',
    cost: '~₹29/M in, ~₹73/M out',
  },
] as const

function ModelSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const current = AI_MODELS.find((m) => m.id === value) ?? AI_MODELS[0]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors"
          style={{
            background: 'var(--aria-bg-panel)',
            border: '1px solid var(--aria-border)',
            color: 'var(--aria-fg)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            minWidth: '180px',
          }}
        >
          <span
            className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
            style={{
              background: `${current.badgeColor}1a`,
              color: current.badgeColor,
            }}
          >
            {current.badge}
          </span>
          <span className="font-medium">{current.name}</span>
          <ChevronDown
            size={14}
            style={{
              color: 'var(--aria-fg-muted)',
              transition: 'transform 0.2s',
              transform: open ? 'rotate(180deg)' : 'none',
            }}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="z-[300]"
        style={{
          background: 'var(--aria-bg-soft)',
          border: '1px solid var(--aria-border)',
          borderRadius: '12px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          width: '280px',
          padding: '6px',
          zIndex: 300,
        }}
      >
        {AI_MODELS.map((m) => {
          const selected = m.id === value
          return (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors"
              style={{
                background: selected ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => {
                if (!selected) e.currentTarget.style.background = 'var(--aria-card)'
              }}
              onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.background = 'transparent'
              }}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[13px] font-medium"
                    style={{ color: 'var(--aria-fg)' }}
                  >
                    {m.name}
                  </span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide"
                    style={{
                      background: `${m.badgeColor}1a`,
                      color: m.badgeColor,
                    }}
                  >
                    {m.badge}
                  </span>
                </div>
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  {m.desc}
                </span>
              </div>
              {selected && (
                <Check
                  size={14}
                  className="shrink-0"
                  style={{ color: 'var(--aria-accent-glow)' }}
                />
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export default SettingsModal
