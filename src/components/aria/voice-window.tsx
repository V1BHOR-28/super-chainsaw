'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { useAriaChat } from '@/hooks/use-aria-chat'

/**
 * ARIA Voice Window (v3.0) — FULLY WIRED with ElevenLabs TTS
 *
 * Walkie-talkie voice mode:
 *   1. User taps orb → STT starts listening (browser SpeechRecognition API)
 *   2. User speaks → "Listening..." → interim transcript shows
 *   3. User pauses → transcript sent to /api/chat → "Thinking..."
 *   4. ARIA responds → ElevenLabs TTS speaks → "Speaking..."
 *   5. Speech ends → auto-restart listening (loop)
 *
 * Voice: "Sarah" from ElevenLabs — Mature, Reassuring, Confident (Friday-like).
 * Supports English + Hindi via eleven_turbo_v2_5 model.
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

/** Detect if text contains Hindi (Devanagari script) */
function isHindiText(text: string): boolean {
  return /[\u0900-\u097F]/.test(text)
}

export function VoiceWindow() {
  const { voiceOpen, setVoiceOpen, activeConversationId } = useAriaStore()
  const { sendMessage } = useAriaChat()
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [language, setLanguage] = useState<'en' | 'hi'>('en')
  const languageRef = useRef<'en' | 'hi'>('en')

  // Keep languageRef in sync
  useEffect(() => { languageRef.current = language }, [language])

  // Refs
  const recognitionRef = useRef<any>(null)
  const isListeningRef = useRef(false)
  const autoListenRef = useRef(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const stateRef = useRef<VoiceState>('idle') // tracks current state for callbacks

  // Keep stateRef in sync with state
  useEffect(() => { stateRef.current = state }, [state])

  // === TTS: Speak text using ElevenLabs API ===
  const speak = useCallback(async (text: string) => {
    // Stop any existing audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // CRITICAL: Stop the microphone completely while ARIA is speaking.
    // Without this, the STT picks up background noise (fans, traffic) and
    // ARIA's own TTS audio, causing it to interrupt itself.
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
      recognitionRef.current = null
    }
    isListeningRef.current = false

    const preferHindi = isHindiText(text) || languageRef.current === 'hi'

    setState('speaking')

    try {
      abortControllerRef.current = new AbortController()

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, hindi: preferHindi }),
        signal: abortControllerRef.current.signal,
      })

      if (!res.ok) {
        throw new Error('TTS failed')
      }

      // Get the audio as a blob and play it
      const blob = await res.blob()
      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)
      audioRef.current = audio

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        audioRef.current = null
        // Auto-restart listening
        if (autoListenRef.current && voiceOpen) {
          setTimeout(() => startListening(), 400)
        } else {
          setState('idle')
        }
      }

      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl)
        audioRef.current = null
        if (autoListenRef.current && voiceOpen) {
          setTimeout(() => startListening(), 400)
        } else {
          setState('idle')
        }
      }

      await audio.play()
    } catch (err) {
      // If aborted (user interrupted), don't restart
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      console.error('[voice.tts]', err)
      // Fallback to idle — don't crash the voice window
      setState('idle')
    }
  }, [language, voiceOpen])

  // === STT: Start listening using browser SpeechRecognition ===
  const startListening = useCallback(() => {
    if (typeof window === 'undefined') return

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      setTranscript('Speech recognition not supported. Try Chrome or Safari.')
      setState('idle')
      return
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = languageRef.current === 'hi' ? 'hi-IN' : 'en-US'
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      isListeningRef.current = true
      setState('listening')
      setTranscript('')
    }

    recognition.onresult = (event: any) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      if (interim) setTranscript(interim)
      if (final) {
        setTranscript(final)
        isListeningRef.current = false

        if (final.trim().length > 0) {
          setState('thinking')
          // Clear transcript after sending (don't show stale text during thinking)
          setTimeout(() => setTranscript(''), 1000)
          sendMessage(final.trim(), activeConversationId ?? undefined, (responseText) => {
            speak(responseText)
          })
        } else {
          setState('idle')
        }
      }
    }

    recognition.onerror = (event: any) => {
      isListeningRef.current = false
      if (event.error === 'no-speech') {
        // Only restart if ARIA isn't speaking/thinking (don't pick up her own audio)
        if (autoListenRef.current && voiceOpen && !audioRef.current && stateRef.current !== 'speaking' && stateRef.current !== 'thinking') {
          setTimeout(() => startListening(), 500)
        }
      } else if (event.error === 'not-allowed') {
        setTranscript('Microphone access denied.')
        setState('idle')
        autoListenRef.current = false
      } else if (event.error === 'aborted') {
        // Normal — user tapped to stop or ARIA started speaking
      } else {
        // For other errors, restart listening if we're still in the voice window
        if (autoListenRef.current && voiceOpen && !audioRef.current && stateRef.current === 'listening') {
          setTimeout(() => startListening(), 500)
        } else {
          setState('idle')
        }
      }
    }

    recognition.onend = () => {
      isListeningRef.current = false
      // Only auto-restart if we're actually in listening state AND not speaking/thinking.
      // Uses stateRef (not stale state closure) for accurate state check.
      if (stateRef.current === 'listening' && autoListenRef.current && voiceOpen && !audioRef.current) {
        setTimeout(() => {
          if (!isListeningRef.current && autoListenRef.current && voiceOpen && !audioRef.current && stateRef.current === 'listening') {
            startListening()
          }
        }, 500)
      }
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      // Already started
    }
  }, [language, voiceOpen, activeConversationId, sendMessage, speak, state])

  // === Handle ball tap ===
  const handleBallTap = useCallback(() => {
    if (state === 'speaking') {
      // Stop ARIA's speech and start listening
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      startListening()
    } else if (state === 'idle') {
      startListening()
    } else if (state === 'listening') {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      setState('idle')
    }
  }, [state, startListening])

  // === Auto-start listening when window opens ===
  useEffect(() => {
    if (voiceOpen) {
      autoListenRef.current = true
      setState('idle')
      setTranscript('')
      const timer = setTimeout(() => startListening(), 600)
      return () => clearTimeout(timer)
    } else {
      autoListenRef.current = false
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      setState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOpen])

  // === Close handler ===
  const handleClose = useCallback(() => {
    autoListenRef.current = false
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setVoiceOpen(false)
  }, [setVoiceOpen])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (audioRef.current) {
        audioRef.current.pause()
      }
    }
  }, [])

  if (!voiceOpen) return null

  const config = STATE_CONFIG[state]
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
          onClick={handleClose}
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

        {/* Language toggle */}
        <button
          onClick={() => {
            const newLang = language === 'en' ? 'hi' : 'en'
            setLanguage(newLang)
            if (recognitionRef.current) {
              try { recognitionRef.current.stop() } catch {}
            }
            setTimeout(() => startListening(), 300)
          }}
          className="absolute top-6 left-6 px-4 py-2 rounded-full text-[13px] font-medium transition-colors z-10"
          style={{
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            color: 'var(--aria-accent-glow)',
          }}
        >
          {language === 'en' ? 'English' : 'हिंदी'}
        </button>

        {/* Main content */}
        <div className="flex flex-col items-center gap-8 px-6">
          {/* Amber aura ball */}
          <div className="relative flex items-center justify-center" style={{ width: ballSize * 1.8, height: ballSize * 1.8 }}>
            {config.showRipple && (
              <>
                <div className="aria-voice-ripple" style={{ width: ballSize, height: ballSize, animationDelay: '0s' }} />
                <div className="aria-voice-ripple" style={{ width: ballSize, height: ballSize, animationDelay: '0.5s' }} />
                <div className="aria-voice-ripple" style={{ width: ballSize, height: ballSize, animationDelay: '1s' }} />
              </>
            )}

            <button
              onClick={handleBallTap}
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

          {/* Live transcript — only show during LISTENING (clean, short) */}
          {state === 'listening' && transcript && (
            <div
              className="aria-voice-transcript max-w-[450px] text-center text-[16px] leading-relaxed"
              style={{ color: 'var(--aria-fg)' }}
            >
              {transcript}
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
