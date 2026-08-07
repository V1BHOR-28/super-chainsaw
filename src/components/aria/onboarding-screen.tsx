'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { motion } from 'framer-motion'
import { ArrowRight, Loader2, GraduationCap, Briefcase } from 'lucide-react'
import { toast } from 'sonner'
import { useAriaStore } from '@/lib/store'

/**
 * OnboardingScreen — appears after a new user signs up + verifies (or after
 * their first Google sign-in). Collects: name, persona (student/professional),
 * optional age, optional occupation. ARIA uses this to personalize her voice.
 *
 * Full-screen overlay, matches the landing page aesthetic.
 */
export function OnboardingScreen({ email }: { email: string }) {
  const setAuthState = useAriaStore((s) => s.setAuthState)
  const setUser = useAriaStore((s) => s.setUser)
  const setJustOnboarded = useAriaStore((s) => s.setJustOnboarded)
  // useSession().update refreshes the NextAuth session client-side after
  // onboarding succeeds. The jwt callback (src/lib/auth.ts) always re-reads
  // `onboarded` from the DB, so this both refreshes the JWT cookie and syncs
  // session.user.onboarded on the client — no full page reload required.
  const { update: updateSession } = useSession()

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [persona, setPersona] = useState<'student' | 'professional' | ''>('')
  const [age, setAge] = useState('')
  const [occupation, setOccupation] = useState('')
  const [loading, setLoading] = useState(false)

  const handleComplete = async () => {
    if (!name.trim()) {
      toast.error('Please enter your name')
      return
    }
    if (!persona) {
      toast.error('Please select whether you are a student or professional')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          persona,
          age: age ? parseInt(age, 10) : undefined,
          occupation: occupation.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Onboarding failed')
      }
      const data = await res.json()
      setUser(data.user)
      toast.success(`Welcome, ${name.trim().split(' ')[0]}. ARIA is here.`)

      // Refresh the NextAuth session so the JWT cookie picks up the new
      // onboarded=true flag from the DB. If this fails (serverless timeout,
      // cold start, network blip), fall back to a full page reload so the
      // session is re-fetched from scratch — without this, the page.tsx
      // session effect can race and flip authState back to 'needs-onboarding'.
      if (typeof updateSession === 'function') {
        try {
          await updateSession()
        } catch {
          // updateSession failed — force a full reload to get a fresh session.
          // This is more reliable than a client-side flip which can be
          // overridden by the stale session in the page.tsx effect.
          window.location.reload()
          return
        }
      }

      // Clean client-side transition: flip the store's authState so
      // page.tsx swaps <OnboardingScreen> for the app with no full reload.
      // The justOnboarded flag tells page.tsx's session effect to NOT
      // override this with a stale 'needs-onboarding' from the old session.
      setJustOnboarded(true)
      setAuthState('authenticated')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const firstName = name.trim().split(' ')[0] || 'there'

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-5 overflow-y-auto"
      style={{ background: 'var(--aria-bg)' }}
    >
      {/* Ambient glow */}
      <div
        className="aria-ambient-glow"
        style={{
          width: 600,
          height: 600,
          background: '#f59e0b',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          opacity: 0.08,
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 w-full max-w-[480px]"
      >
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="aria-logo-dot" />
          <span className="font-serif-aria text-2xl tracking-tight">ARIA</span>
        </div>

        {/* Step indicator — 3 dots styled after the aria-logo-dot visual
            language. Active dot uses the same radial amber gradient + glow;
            dimmed dots use --aria-fg-dim. */}
        <div
          className="flex items-center justify-center gap-2 mb-8"
          role="progressbar"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={3}
          aria-label="Onboarding progress"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-full transition-all"
              style={{
                width: i === step ? '10px' : '7px',
                height: i === step ? '10px' : '7px',
                background:
                  i === step
                    ? 'radial-gradient(circle at 30% 30%, var(--aria-accent-glow), var(--aria-accent-bright) 50%, var(--aria-accent-deep) 100%)'
                    : 'var(--aria-fg-dim)',
                boxShadow:
                  i === step ? '0 0 8px rgba(245, 158, 11, 0.5)' : 'none',
                opacity: i === step ? 1 : 0.5,
              }}
            />
          ))}
        </div>

        {step === 0 && (
          <motion.div
            key="step0"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <h1 className="font-serif-aria text-[42px] leading-[1.1] mb-3 text-center">
              What should ARIA <em className="aria-greeting-grad">call you?</em>
            </h1>
            <p className="text-center mb-8" style={{ color: 'var(--aria-fg-muted)', fontSize: '15px' }}>
              Your name shapes how ARIA greets you. You can change it later in Settings.
            </p>

            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) setStep(1)
              }}
              placeholder="Your name"
              autoFocus
              className="w-full rounded-2xl px-5 py-4 text-[18px] text-center outline-none transition-colors mb-6"
              style={{
                background: 'var(--aria-bg-soft)',
                border: '1px solid var(--aria-border)',
                color: 'var(--aria-fg)',
                fontFamily: 'inherit',
              }}
            />

            <button
              onClick={() => {
                if (name.trim()) setStep(1)
                else toast.error('Please enter your name')
              }}
              disabled={!name.trim()}
              className="w-full py-4 rounded-2xl flex items-center justify-center gap-2 text-[15px] font-medium transition-all disabled:opacity-50"
              style={{
                background: name.trim() ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                color: 'var(--aria-bg)',
                border: 'none',
                cursor: name.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Continue
              <ArrowRight size={16} />
            </button>

            <p className="text-center mt-6 text-[12px]" style={{ color: 'var(--aria-fg-dim)' }}>
              Signed in as {email}
            </p>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <h1 className="font-serif-aria text-[42px] leading-[1.1] mb-3 text-center">
              Are you a <em className="aria-greeting-grad">student</em> or a <em className="aria-greeting-grad">professional?</em>
            </h1>
            <p className="text-center mb-8" style={{ color: 'var(--aria-fg-muted)', fontSize: '15px' }}>
              ARIA adapts her voice to fit your world.
            </p>

            <div className="grid grid-cols-2 gap-4 mb-8">
              <button
                onClick={() => setPersona('student')}
                className="rounded-2xl p-6 flex flex-col items-center gap-3 transition-all"
                style={{
                  background: persona === 'student' ? 'rgba(245,158,11,0.1)' : 'var(--aria-card)',
                  border: persona === 'student' ? '1px solid var(--aria-accent)' : '1px solid var(--aria-border)',
                  cursor: 'pointer',
                }}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    background: persona === 'student' ? 'rgba(245,158,11,0.15)' : 'var(--aria-bg-panel)',
                    color: persona === 'student' ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                  }}
                >
                  <GraduationCap size={24} strokeWidth={1.5} />
                </div>
                <span
                  className="text-[15px] font-medium"
                  style={{
                    color: persona === 'student' ? 'var(--aria-accent-glow)' : 'var(--aria-fg)',
                  }}
                >
                  Student
                </span>
              </button>

              <button
                onClick={() => setPersona('professional')}
                className="rounded-2xl p-6 flex flex-col items-center gap-3 transition-all"
                style={{
                  background: persona === 'professional' ? 'rgba(245,158,11,0.1)' : 'var(--aria-card)',
                  border: persona === 'professional' ? '1px solid var(--aria-accent)' : '1px solid var(--aria-border)',
                  cursor: 'pointer',
                }}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    background: persona === 'professional' ? 'rgba(245,158,11,0.15)' : 'var(--aria-bg-panel)',
                    color: persona === 'professional' ? 'var(--aria-accent-glow)' : 'var(--aria-fg-muted)',
                  }}
                >
                  <Briefcase size={24} strokeWidth={1.5} />
                </div>
                <span
                  className="text-[15px] font-medium"
                  style={{
                    color: persona === 'professional' ? 'var(--aria-accent-glow)' : 'var(--aria-fg)',
                  }}
                >
                  Professional
                </span>
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(0)}
                className="py-4 px-6 rounded-2xl text-[15px] transition-colors"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg-muted)',
                  cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (persona) setStep(2)
                  else toast.error('Please select one')
                }}
                disabled={!persona}
                className="flex-1 py-4 rounded-2xl flex items-center justify-center gap-2 text-[15px] font-medium transition-all disabled:opacity-50"
                style={{
                  background: persona ? 'var(--aria-accent)' : 'var(--aria-fg-dim)',
                  color: 'var(--aria-bg)',
                  border: 'none',
                  cursor: persona ? 'pointer' : 'not-allowed',
                }}
              >
                Continue
                <ArrowRight size={16} />
              </button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <h1 className="font-serif-aria text-[42px] leading-[1.1] mb-3 text-center">
              One more <em className="aria-greeting-grad">thing, {firstName}.</em>
            </h1>
            <p className="text-center mb-8" style={{ color: 'var(--aria-fg-muted)', fontSize: '15px' }}>
              Optional — but it helps ARIA understand your world.
            </p>

            <div className="space-y-4 mb-8">
              <div>
                <label
                  className="text-[12px] uppercase tracking-wider mb-2 block"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  Age (optional)
                </label>
                <input
                  type="number"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="e.g. 24"
                  min={13}
                  max={120}
                  className="w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
                  style={{
                    background: 'var(--aria-bg-soft)',
                    border: '1px solid var(--aria-border)',
                    color: 'var(--aria-fg)',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div>
                <label
                  className="text-[12px] uppercase tracking-wider mb-2 block"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  {persona === 'student' ? 'What are you studying?' : 'What do you do?'} (optional)
                </label>
                <input
                  type="text"
                  value={occupation}
                  onChange={(e) => setOccupation(e.target.value)}
                  placeholder={persona === 'student' ? 'e.g. Computer Science' : 'e.g. Product Designer'}
                  maxLength={100}
                  className="w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors focus:border-[rgba(245,158,11,0.45)]"
                  style={{
                    background: 'var(--aria-bg-soft)',
                    border: '1px solid var(--aria-border)',
                    color: 'var(--aria-fg)',
                    fontFamily: 'inherit',
                  }}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                className="py-4 px-6 rounded-2xl text-[15px] transition-colors"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--aria-border)',
                  color: 'var(--aria-fg-muted)',
                  cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                onClick={handleComplete}
                disabled={loading}
                className="flex-1 py-4 rounded-2xl flex items-center justify-center gap-2 text-[15px] font-medium transition-all disabled:opacity-50"
                style={{
                  background: 'var(--aria-accent)',
                  color: 'var(--aria-bg)',
                  border: 'none',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Setting up...
                  </>
                ) : (
                  <>
                    Meet ARIA
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>

            <button
              onClick={handleComplete}
              disabled={loading}
              className="w-full mt-4 py-3 text-[13px] transition-colors"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--aria-fg-dim)',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              Skip for now
            </button>
          </motion.div>
        )}

        <div className="flex items-center justify-center gap-2 mt-8">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-1 rounded-full transition-all"
              style={{
                width: i === step ? '24px' : '8px',
                background: i === step ? 'var(--aria-accent)' : 'var(--aria-border)',
              }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  )
}

export default OnboardingScreen
