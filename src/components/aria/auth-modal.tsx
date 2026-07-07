'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { signIn } from 'next-auth/react'
import { toast } from 'sonner'
import { Loader2, Mail, Lock, ArrowRight, X } from 'lucide-react'
import { useAriaStore } from '@/lib/store'

type Step = 'signup' | 'verify' | 'login'

/* ---------- Inline brand SVGs (no external deps) ---------- */

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962l3.007 2.332C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  )
}

function GitHubLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

/* ---------- Shared styled primitives ---------- */

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--aria-bg-panel)',
  border: '1px solid var(--aria-border)',
  borderRadius: '12px',
  padding: '12px 14px 12px 40px',
  color: 'var(--aria-fg)',
  fontSize: '15px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
}

const oauthButtonStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--aria-card)',
  border: '1px solid var(--aria-border)',
  borderRadius: '12px',
  padding: '11px 14px',
  color: 'var(--aria-fg)',
  fontSize: '14px',
  fontFamily: 'inherit',
  fontWeight: 500,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '10px',
  transition: 'border-color 0.2s ease, background 0.2s ease',
}

function FieldError({ message }: { message: string }) {
  return (
    <p className="m-0 mt-1.5 text-[12px]" style={{ color: '#ef4444' }}>
      {message}
    </p>
  )
}

/* ---------- The modal ---------- */

export function AuthModal() {
  const authModalOpen = useAriaStore((s) => s.authModalOpen)
  const setAuthModalOpen = useAriaStore((s) => s.setAuthModalOpen)

  const [step, setStep] = useState<Step>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string; code?: string }>({})

  const reset = useCallback(() => {
    setStep('signup')
    setEmail('')
    setPassword('')
    setCode('')
    setLoading(false)
    setErrors({})
  }, [])

  const close = useCallback(() => {
    setAuthModalOpen(false)
    // Defer reset so the exit animation doesn't flash empty content
    setTimeout(reset, 200)
  }, [setAuthModalOpen, reset])

  // Esc to close
  useEffect(() => {
    if (!authModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [authModalOpen, close])

  /* ---------- API handlers ---------- */

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    const nextErrors: typeof errors = {}
    if (!email) nextErrors.email = 'Email is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      nextErrors.email = 'Please enter a valid email address'
    if (!password) nextErrors.password = 'Password is required'
    else if (password.length < 8)
      nextErrors.password = 'Password must be at least 8 characters'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setStep('verify')
        toast.success('Verification code sent to your email')
      } else if (res.status === 409) {
        toast.error(data.error || 'An account with this email already exists.')
      } else {
        // Show the actual error message from the server
        toast.error(data.error || 'Sign up failed. Please try again.')
        setErrors({ email: data.error || '' })
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      setErrors({ code: 'Enter the 6-digit code' })
      return
    }
    setErrors({})
    setLoading(true)
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success('Email verified! Signing you in...')
        // Auto-login via credentials provider
        const result = await signIn('credentials', {
          email,
          password,
          redirect: false,
          callbackUrl: '/',
        })
        if (result?.error) {
          toast.error('Verified! Please log in with your email and password.')
          setStep('login')
        } else if (result?.url) {
          window.location.href = result.url
        } else {
          window.location.reload()
        }
      } else {
        toast.error(data.error || 'Verification failed.')
        setErrors({ code: data.error || 'Incorrect code' })
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    if (!email) return
    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (res.ok) toast.success('New code sent')
      else toast.error('Please wait a minute before resending')
    } catch {
      toast.error('Network error. Please try again.')
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    const nextErrors: typeof errors = {}
    if (!email) nextErrors.email = 'Email is required'
    if (!password) nextErrors.password = 'Password is required'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    setLoading(true)
    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl: '/',
      })
      if (result?.error) {
        // NextAuth returns a generic error — we can't tell if it was
        // "wrong password" or "email not verified". Check the DB to give
        // a specific message.
        try {
          const checkRes = await fetch('/api/auth/check-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          if (checkRes.ok) {
            const status = await checkRes.json()
            if (status.exists && !status.verified) {
              toast.error("Your email isn't verified yet. Check your inbox for the 6-digit code, or sign up again to resend.")
              return
            }
          }
        } catch {
          /* ignore — fall through to generic message */
        }
        toast.error('Wrong email or password. Please try again.')
      } else if (result?.url) {
        // Success — reload to let the server check the session
        window.location.href = result.url
      } else {
        // No error and no URL — reload anyway
        window.location.reload()
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogle = () => {
    signIn('google', { callbackUrl: '/' })
  }

  const handleGitHub = () => {
    toast.info('GitHub sign-in coming soon. Use email or Google for now.')
  }

  if (!authModalOpen) return null

  /* ---------- Reusable pieces ---------- */

  const OAuthButtons = (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={handleGoogle}
        style={oauthButtonStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
          e.currentTarget.style.background = 'rgba(245,158,11,0.05)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--aria-border)'
          e.currentTarget.style.background = 'var(--aria-card)'
        }}
      >
        <GoogleLogo />
        Continue with Google
      </button>
      <button
        type="button"
        onClick={handleGitHub}
        style={oauthButtonStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
          e.currentTarget.style.background = 'rgba(245,158,11,0.05)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--aria-border)'
          e.currentTarget.style.background = 'var(--aria-card)'
        }}
      >
        <GitHubLogo />
        Continue with GitHub
      </button>
    </div>
  )

  const Divider = ({ label }: { label: string }) => (
    <div
      className="flex items-center gap-3 my-5"
      style={{ color: 'var(--aria-fg-dim)' }}
    >
      <div className="h-px flex-1" style={{ background: 'var(--aria-border)' }} />
      <span className="text-[12px]">{label}</span>
      <div className="h-px flex-1" style={{ background: 'var(--aria-border)' }} />
    </div>
  )

  const SubmitButton = ({
    label,
    onSubmit,
  }: {
    label: string
    onSubmit: (e: React.FormEvent) => void
  }) => (
    <button
      type="submit"
      onClick={onSubmit}
      disabled={loading}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg transition-all"
      style={{
        background: 'var(--aria-accent)',
        color: 'var(--aria-bg)',
        padding: '12px 16px',
        fontSize: '15px',
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.7 : 1,
        border: 'none',
      }}
      onMouseEnter={(e) => {
        if (!loading) {
          e.currentTarget.style.background = 'var(--aria-accent-glow)'
          e.currentTarget.style.boxShadow = '0 0 24px 2px rgba(245,158,11,0.4)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--aria-accent)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {loading ? (
        <Loader2 size={18} className="animate-spin" />
      ) : (
        <>
          {label}
          <ArrowRight size={16} />
        </>
      )}
    </button>
  )

  /* ---------- Render ---------- */

  return (
    <AnimatePresence>
      {authModalOpen && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{
            background: 'rgba(8,6,4,0.75)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-labelledby="aria-auth-heading"
        >
          <motion.div
            className="relative w-full max-w-[440px] max-h-[90vh] overflow-y-auto"
            style={{
              background: 'var(--aria-bg-soft)',
              border: '1px solid var(--aria-border)',
              borderRadius: '24px',
              padding: '32px 24px',
              boxShadow: '0 30px 80px rgba(0,0,0,0.5), 0 0 60px rgba(245,158,11,0.06)',
            }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              title="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors"
              style={{
                color: 'var(--aria-fg-dim)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--aria-fg)'
                e.currentTarget.style.background = 'rgba(245,158,11,0.08)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--aria-fg-dim)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <X size={18} />
            </button>

            {/* Logo + wordmark */}
            <div className="mb-7 flex items-center justify-center gap-2.5">
              <span className="aria-logo-dot" />
              <span
                className="font-serif-aria"
                style={{ fontSize: '22px', color: 'var(--aria-fg)', letterSpacing: '0.04em' }}
              >
                ARIA
              </span>
            </div>

            {/* ---------- SIGNUP ---------- */}
            {step === 'signup' && (
              <div className="aria-fade-slide">
                <h2
                  id="aria-auth-heading"
                  className="font-serif-aria m-0 text-center"
                  style={{ fontSize: '36px', lineHeight: 1.1, color: 'var(--aria-fg)' }}
                >
                  Welcome.
                </h2>
                <p
                  className="m-0 mb-7 mt-2 text-center"
                  style={{ color: 'var(--aria-fg-muted)', fontSize: '14px' }}
                >
                  ARIA is not a chatbot. She&rsquo;s a partner.
                </p>

                {OAuthButtons}

                <Divider label="or sign up with email" />

                <form onSubmit={handleSignup} className="flex flex-col gap-3">
                  <div className="relative">
                    <Mail
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--aria-fg-dim)' }}
                    />
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value)
                        if (errors.email) setErrors((p) => ({ ...p, email: undefined }))
                      }}
                      style={inputStyle}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--aria-border)'
                      }}
                      autoComplete="email"
                    />
                    {errors.email && <FieldError message={errors.email} />}
                  </div>

                  <div className="relative">
                    <Lock
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--aria-fg-dim)' }}
                    />
                    <input
                      type="password"
                      placeholder="Password (min 8 characters)"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        if (errors.password) setErrors((p) => ({ ...p, password: undefined }))
                      }}
                      style={inputStyle}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--aria-border)'
                      }}
                      autoComplete="new-password"
                    />
                    {errors.password && <FieldError message={errors.password} />}
                  </div>

                  <SubmitButton label="Create account" onSubmit={handleSignup} />
                </form>

                <p
                  className="m-0 mt-5 text-center text-[13px]"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  Already have an account?{' '}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    style={{
                      color: 'var(--aria-accent-glow)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      padding: 0,
                    }}
                    onClick={() => {
                      setStep('login')
                      setErrors({})
                    }}
                  >
                    Log in
                  </button>
                </p>
              </div>
            )}

            {/* ---------- VERIFY ---------- */}
            {step === 'verify' && (
              <div className="aria-fade-slide">
                <h2
                  id="aria-auth-heading"
                  className="font-serif-aria m-0 text-center"
                  style={{ fontSize: '36px', lineHeight: 1.1, color: 'var(--aria-fg)' }}
                >
                  Check your email.
                </h2>
                <p
                  className="m-0 mb-7 mt-2 text-center"
                  style={{ color: 'var(--aria-fg-muted)', fontSize: '14px' }}
                >
                  We sent a 6-digit code to{' '}
                  <span style={{ color: 'var(--aria-fg)' }}>{email}</span>
                </p>

                <form onSubmit={handleVerify} className="flex flex-col gap-3">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                      setCode(v)
                      if (errors.code) setErrors((p) => ({ ...p, code: undefined }))
                    }}
                    className="font-mono-aria mx-auto text-center outline-none"
                    style={{
                      width: '100%',
                      background: 'var(--aria-bg-panel)',
                      border: '1px solid var(--aria-border)',
                      borderRadius: '12px',
                      padding: '16px 14px',
                      color: 'var(--aria-fg)',
                      fontSize: '32px',
                      letterSpacing: '0.3em',
                      transition: 'border-color 0.2s ease',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--aria-border)'
                    }}
                  />
                  {errors.code && (
                    <p
                      className="m-0 text-center text-[12px]"
                      style={{ color: '#ef4444' }}
                    >
                      {errors.code}
                    </p>
                  )}

                  <SubmitButton label="Verify" onSubmit={handleVerify} />
                </form>

                <p
                  className="m-0 mt-5 text-center text-[13px]"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  Didn&rsquo;t get the code?{' '}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    style={{
                      color: 'var(--aria-accent-glow)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      padding: 0,
                    }}
                    onClick={handleResend}
                  >
                    Resend
                  </button>
                </p>
                <p
                  className="m-0 mt-2 text-center text-[13px]"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  Wrong email?{' '}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    style={{
                      color: 'var(--aria-fg-dim)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      padding: 0,
                    }}
                    onClick={() => {
                      setStep('signup')
                      setCode('')
                      setErrors({})
                    }}
                  >
                    Start over
                  </button>
                </p>
              </div>
            )}

            {/* ---------- LOGIN ---------- */}
            {step === 'login' && (
              <div className="aria-fade-slide">
                <h2
                  id="aria-auth-heading"
                  className="font-serif-aria m-0 text-center"
                  style={{ fontSize: '36px', lineHeight: 1.1, color: 'var(--aria-fg)' }}
                >
                  Welcome back.
                </h2>
                <p
                  className="m-0 mb-7 mt-2 text-center"
                  style={{ color: 'var(--aria-fg-muted)', fontSize: '14px' }}
                >
                  Pick up exactly where you left off.
                </p>

                {OAuthButtons}

                <Divider label="or sign in with email" />

                <form onSubmit={handleLogin} className="flex flex-col gap-3">
                  <div className="relative">
                    <Mail
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--aria-fg-dim)' }}
                    />
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value)
                        if (errors.email) setErrors((p) => ({ ...p, email: undefined }))
                      }}
                      style={inputStyle}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--aria-border)'
                      }}
                      autoComplete="email"
                    />
                    {errors.email && <FieldError message={errors.email} />}
                  </div>

                  <div className="relative">
                    <Lock
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--aria-fg-dim)' }}
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        if (errors.password) setErrors((p) => ({ ...p, password: undefined }))
                      }}
                      style={inputStyle}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(245,158,11,0.45)'
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'var(--aria-border)'
                      }}
                      autoComplete="current-password"
                    />
                    {errors.password && <FieldError message={errors.password} />}
                  </div>

                  <SubmitButton label="Sign In" onSubmit={handleLogin} />
                </form>

                <p
                  className="m-0 mt-5 text-center text-[13px]"
                  style={{ color: 'var(--aria-fg-muted)' }}
                >
                  New to ARIA?{' '}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    style={{
                      color: 'var(--aria-accent-glow)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      padding: 0,
                    }}
                    onClick={() => {
                      setStep('signup')
                      setErrors({})
                    }}
                  >
                    Create an account
                  </button>
                </p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default AuthModal
