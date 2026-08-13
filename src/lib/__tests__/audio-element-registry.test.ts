import { describe, it, expect, beforeEach } from 'vitest'
import { setAudioElement, getAudioElement } from '@/lib/audio-element-registry'

describe('audio-element-registry', () => {
  // The registry is a module-level singleton. Tests must reset it between
  // cases or they leak state across the suite.
  beforeEach(() => {
    setAudioElement(null)
  })

  it('returns null initially', () => {
    expect(getAudioElement()).toBeNull()
  })

  it('stores and returns the same audio element that was set', () => {
    // jsdom provides an HTMLAudioElement constructor — use it as a stand-in.
    const fakeAudio = new Audio()
    setAudioElement(fakeAudio)
    expect(getAudioElement()).toBe(fakeAudio)
  })

  it('clears the registry when set to null', () => {
    const fakeAudio = new Audio()
    setAudioElement(fakeAudio)
    expect(getAudioElement()).toBe(fakeAudio)
    setAudioElement(null)
    expect(getAudioElement()).toBeNull()
  })

  it('overwrites the previous element when set is called twice', () => {
    const a = new Audio()
    const b = new Audio()
    setAudioElement(a)
    setAudioElement(b)
    expect(getAudioElement()).toBe(b)
    expect(getAudioElement()).not.toBe(a)
  })
})
