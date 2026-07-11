'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useAriaStore } from '@/lib/store'
import { useAriaChat } from '@/hooks/use-aria-chat'

/**
 * ARIA Voice Window (v3.0) — FULLY WIRED
 *
 * Walkie-talkie voice mode:
 *   1. User taps orb → STT starts listening (browser SpeechRecognition API)
 *   2. User speaks → "Listening..." → interim transcript shows
 *   3. User pauses → transcript sent to /api/chat → "Thinking..."
 *   4. ARIA responds → TTS speaks via speechSynthesis → "Speaking..."
 *   5. Speech ends → auto-restart listening (loop)
 *
 * Supports English + Hindi:
 *   - STT: SpeechRecognition lang set to 'en-US' or 'hi-IN'
 *   - TTS: picks the best available voice for the language
 *   - ARIA's response language detected from Devanagari characters
 *
 * Friday from Iron Man inspired — calm, warm, amber.
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

/** Strip markdown for cleaner speech */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>~]/g, '')
    .replace(/\n+/g, '. ')
    .slice(0, 1500) // cap TTS length — don't speak more than ~1500 chars
}

/** Get the best available voice for the target language */
function pickVoice(voices: SpeechSynthesisVoice[], preferHindi: boolean): SpeechSynthesisVoice | null {
  if (!voices.length) return null

  if (preferHindi) {
    // Prefer Hindi female voices
    const hindiFemale = voices.find(v =>
      v.lang.startsWith('hi') &&
      /female|samantha|google|priya|kalpana/i.test(v.name)
    )
    if (hindiFemale) return hindiFemale

    const hindi = voices.find(v => v.lang.startsWith('hi'))
    if (hindi) return hindi
  }

  // English female voices — prefer natural-sounding ones
  const englishFemale = voices.find(v =>
    v.lang.startsWith('en') &&
    /female|samantha|google|karen|tessa|moira|fiona|veena/i.test(v.name)
  )
  if (englishFemale) return englishFemale

  // Fallback: any English voice
  const english = voices.find(v => v.lang.startsWith('en'))
  if (english) return english

  return voices[0]
}

export function VoiceWindow() {
  const { voiceOpen, setVoiceOpen, activeConversationId } = useAriaStore()
  const { sendMessage } = useAriaChat()
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [ariaResponse, setAriaResponse] = useState('')
  const [language, setLanguage] = useState<'en' | 'hi'>('en')

  // Refs for STT/TTS — must survive re-renders
  const recognitionRef = useRef<any>(null)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const isListeningRef = useRef(false)
  const autoListenRef = useRef(true)

  // Load available TTS voices (browser-dependent)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return

    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices()
    }
    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices
    return () => {
      window.speechSynthesis.onvoiceschanged = null
    }
  }, [])

  // === TTS: Speak text using browser speechSynthesis ===
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      // No TTS available — skip to listening
      setState('idle')
      return
    }

    // Stop any ongoing speech
    window.speechSynthesis.cancel()

    const cleanText = stripMarkdown(text)
    const preferHindi = isHindiText(cleanText) || language === 'hi'
    const voice = pickVoice(voicesRef.current, preferHindi)

    const utterance = new SpeechSynthesisUtterance(cleanText)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang
    } else {
      utterance.lang = preferHindi ? 'hi-IN' : 'en-US'
    }
    utterance.rate = 0.95  // slightly slower for calm, Friday-like delivery
    utterance.pitch = 1.05 // slightly higher pitch for female warmth
    utterance.volume = 1.0

    utterance.onstart = () => {
      setState('speaking')
      setAriaResponse(cleanText)
    }

    utterance.onend = () => {
      setAriaResponse('')
      // Auto-restart listening if the loop is active
      if (autoListenRef.current && voiceOpen) {
        setTimeout(() => startListening(), 500)
      } else {
        setState('idle')
      }
    }

    utterance.onerror = () => {
      setAriaResponse('')
      if (autoListenRef.current && voiceOpen) {
        setTimeout(() => startListening(), 500)
      } else {
        setState('idle')
      }
    }

    window.speechSynthesis.speak(utterance)
  }, [language, voiceOpen])

  // === STT: Start listening using browser SpeechRecognition ===
  const startListening = useCallback(() => {
    if (typeof window === 'undefined') return

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      // Browser doesn't support STT — show error
      setTranscript('Speech recognition not supported in this browser. Try Chrome or Safari.')
      setState('idle')
      return
    }

    // Stop any existing recognition
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = language === 'hi' ? 'hi-IN' : 'en-US'
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

        // Send to ARIA
        if (final.trim().length > 0) {
          setState('thinking')
          sendMessage(final.trim(), activeConversationId ?? undefined, (responseText) => {
            // onComplete — speak ARIA's response
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
        // No speech detected — restart listening
        if (autoListenRef.current && voiceOpen) {
          setTimeout(() => startListening(), 300)
        }
      } else if (event.error === 'not-allowed') {
        setTranscript('Microphone access denied. Please allow microphone access in your browser settings.')
        setState('idle')
      } else {
        setState('idle')
      }
    }

    recognition.onend = () => {
      isListeningRef.current = false
      // If we didn't get a final result, go back to idle or restart
      if (state === 'listening' && autoListenRef.current && voiceOpen) {
        setTimeout(() => {
          if (!isListeningRef.current && autoListenRef.current && voiceOpen) {
            startListening()
          }
        }, 300)
      }
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      // Already started — ignore
    }
  }, [language, voiceOpen, activeConversationId, sendMessage, speak, state])

  // === Handle ball tap ===
  const handleBallTap = useCallback(() => {
    if (state === 'idle' || state === 'speaking') {
      // Stop speaking if ARIA is talking
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      // Start listening
      startListening()
    } else if (state === 'listening') {
      // Stop listening
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
      setAriaResponse('')
      // Start listening after a short delay (let the animation play)
      const timer = setTimeout(() => startListening(), 600)
      return () => clearTimeout(timer)
    } else {
      // Window closed — stop everything
      autoListenRef.current = false
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel()
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
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    setVoiceOpen(false)
  }, [setVoiceOpen])

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
            // Restart listening with new language
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

          {/* Live transcript (listening + thinking) */}
          {(state === 'listening' || state === 'thinking') && transcript && (
            <div
              className="aria-voice-transcript max-w-[500px] text-center text-[15px] leading-relaxed"
              style={{ color: 'var(--aria-fg)' }}
            >
              {transcript}
            </div>
          )}

          {/* ARIA's response preview (speaking) */}
          {state === 'speaking' && ariaResponse && (
            <div
              className="aria-voice-transcript max-w-[500px] text-center text-[15px] leading-relaxed"
              style={{ color: 'var(--aria-fg-muted)' }}
            >
              {ariaResponse.slice(0, 300)}{ariaResponse.length > 300 ? '...' : ''}
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
