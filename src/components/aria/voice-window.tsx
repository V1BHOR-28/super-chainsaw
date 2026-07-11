'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Mic, MicOff } from 'lucide-react'
import { useAriaStore } from '@/lib/store'

/**
 * ARIA Voice Window (v3.0)
 *
 * A full-screen overlay with ARIA's signature amber aura ball.
 * Three states: Listening → Thinking → Speaking
 *
 * Design inspired by Friday from Iron Man — calm, warm, amber glow.
 * The ball is the visual identity. The state text tells the user what's happening.
 *
 * This is the UI shell only — TTS/STT logic will be wired in the next phase.
 */

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

const STATE_CONFIG: Record<VoiceState, {
  label: string
  sublabel: string
  ballClass: string
  showRipple: boolean
}> = {
  idle: {
    label: 'Tap to speak',
    sublabel: 'ARIA is ready',
    ballClass: 'aria-voice-listening',
    showRipple: false,
  },
  listening: {
    label: 'Listening...',
    sublabel: 'Speak naturally',
    ballClass: 'aria-voice-listening',
    showRipple: false,
  },
  thinking: {
    label: 'Thinking...',
    sublabel: 'ARIA is processing',
    ballClass: 'aria-voice-thinking',
    showRipple: false,
  },
  speaking: {
    label: 'Speaking...',
    sublabel: 'Tap to interrupt',
    ballClass: 'aria-voice-speaking',
    showRipple: true,
  },
}

export function VoiceWindow() {
  const { voiceOpen, setVoiceOpen } = useAriaStore()
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [language, setLanguage] = useState<'en' | 'hi'>('en')

  // Reset state when window closes
  useEffect(() => {
    if (!voiceOpen) {
      setState('idle')
      setTranscript('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOpen])

  if (!voiceOpen) return null

  const config = STATE_CONFIG[state]

  // Ball size — responsive, larger on desktop
  const ballSize = typeof window !== 'undefined' && window.innerWidth < 640 ? 160 : 220

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[300] flex flex-col items-center justify-center"
        style={{
          background: 'rgba(8, 6, 4, 0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        {/* Close button */}
        <button
          onClick={() => setVoiceOpen(false)}
          className="absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center transition-colors z-10"
          style={{
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            color: 'var(--aria-fg-muted)',
          }}
          aria-label="Close voice mode"
        >
          <X size={20} />
        </button>

        {/* Language toggle (top left) */}
        <button
          onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
          className="absolute top-6 left-6 px-4 py-2 rounded-full text-[13px] font-medium transition-colors z-10"
          style={{
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            color: 'var(--aria-accent-glow)',
          }}
        >
          {language === 'en' ? 'English' : 'हिंदी'}
        </button>

        {/* Main content — centered */}
        <div className="flex flex-col items-center gap-8 px-6">
          {/* ARIA's signature amber aura ball */}
          <div className="relative flex items-center justify-center" style={{ width: ballSize * 1.8, height: ballSize * 1.8 }}>
            {/* Ripple rings (speaking state only) */}
            {config.showRipple && (
              <>
                <div
                  className="aria-voice-ripple"
                  style={{ width: ballSize, height: ballSize, animationDelay: '0s' }}
                />
                <div
                  className="aria-voice-ripple"
                  style={{ width: ballSize, height: ballSize, animationDelay: '0.5s' }}
                />
                <div
                  className="aria-voice-ripple"
                  style={{ width: ballSize, height: ballSize, animationDelay: '1s' }}
                />
              </>
            )}

            {/* The ball itself */}
            <button
              onClick={() => {
                // Cycle through states for demo purposes (will be replaced with real STT/TTS)
                if (state === 'idle' || state === 'speaking') {
                  setState('listening')
                } else if (state === 'listening') {
                  setState('thinking')
                  setTimeout(() => setState('speaking'), 2000)
                }
              }}
              className={`aria-voice-ball ${config.ballClass}`}
              style={{
                width: ballSize,
                height: ballSize,
                cursor: 'pointer',
                border: 'none',
                outline: 'none',
              }}
              aria-label={config.label}
            />
          </div>

          {/* State label */}
          <div className="text-center">
            <motion.h2
              key={state}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="font-serif-aria text-[28px] sm:text-[36px] leading-none mb-2"
              style={{ color: 'var(--aria-accent-glow)' }}
            >
              {config.label}
            </motion.h2>
            <p className="text-[14px]" style={{ color: 'var(--aria-fg-muted)' }}>
              {config.sublabel}
            </p>
          </div>

          {/* Live transcript (shows during listening + thinking) */}
          {(state === 'listening' || state === 'thinking') && transcript && (
            <div
              className="aria-voice-transcript max-w-[500px] text-center text-[15px] leading-relaxed"
              style={{ color: 'var(--aria-fg)' }}
            >
              {transcript}
            </div>
          )}

          {/* ARIA's response preview (during speaking) */}
          {state === 'speaking' && (
            <div
              className="aria-voice-transcript max-w-[500px] text-center text-[15px] leading-relaxed"
              style={{ color: 'var(--aria-fg-muted)' }}
            >
              {/* This will show ARIA's actual response when TTS is wired up */}
              For now, this is a demo. ARIA's spoken response will appear here.
            </div>
          )}
        </div>

        {/* Bottom hint */}
        <div className="absolute bottom-8 left-0 right-0 text-center">
          <p className="text-[11px]" style={{ color: 'var(--aria-fg-dim)' }}>
            {language === 'en'
              ? 'Tap the orb to speak · Tap again to stop'
              : 'बोलने के लिए गोले को छुइए · रोकने के लिए फिर से छुइए'}
          </p>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

export default VoiceWindow
