'use client'

import { useEffect } from 'react'

/**
 * useMobileViewport — fixes the two worst iOS Safari/PWA layout problems:
 *
 * 1. THE KEYBOARD PROBLEM
 *    On iOS, `100dvh` / `100vh` DO NOT shrink when the on-screen keyboard
 *    opens. The layout viewport stays full-height, so the chat input ends up
 *    buried under the keyboard and the message list's bottom is off-screen
 *    (i.e. "can't scroll"). The only reliable signal is the VisualViewport
 *    API. We track `visualViewport.height` and expose it as the CSS variable
 *    `--app-height`, which the app shell uses instead of 100dvh:
 *
 *        .h-app { height: var(--app-height, 100dvh); }
 *
 *    When the keyboard opens, the shell shrinks to exactly the visible area
 *    and the input sits right above the keyboard. When it closes, the
 *    shell grows back.
 *
 * 2. KEYBOARD AWARENESS FOR CSS
 *    We also toggle a `keyboard-open` class on <html> and expose
 *    `--keyboard-inset` (px) so components can pad above the keyboard when
 *    needed.
 *
 * The listener is iOS-only (iPhone/iPad Safari) — Android/Chrome resizes the
 * layout viewport natively, and desktop has no keyboard, so we leave those
 * platforms on plain 100dvh to avoid resize jank.
 */
export function useMobileViewport() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const html = document.documentElement

    // Mark touch devices — used by CSS to adapt hover-only affordances.
    const isTouch =
      'ontouchstart' in window ||
      (navigator.maxTouchPoints ?? 0) > 0
    if (isTouch) html.classList.add('is-touch')

    // iOS detection (iPhone/iPad Safari + PWA standalone). iPadOS 13+
    // pretends to be desktop Mac Safari, so also check maxTouchPoints.
    const ua = navigator.userAgent
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (/Mac/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
    if (isIOS) html.classList.add('is-ios')

    const vv = window.visualViewport
    if (!vv || !isIOS) return

    let raf = 0
    const apply = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // The visual viewport height is the true visible height — it shrinks
        // when the keyboard opens and accounts for the collapsed URL bar.
        const h = Math.round(vv.height)
        html.style.setProperty('--app-height', `${h}px`)

        // Visual viewport can also be scrolled by iOS when the keyboard
        // opens; keep the shell pinned to the top of what's visible.
        html.style.setProperty('--vv-offset-top', `${Math.round(vv.offsetTop)}px`)

        // Keyboard height heuristic: layout viewport minus visual viewport.
        // iOS reports ~150px+ when the keyboard is up; small deltas (<90px)
        // are just the URL bar collapsing and should not count.
        const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
        const kbOpen = kb > 90
        html.style.setProperty('--keyboard-inset', `${kbOpen ? kb : 0}px`)
        html.classList.toggle('keyboard-open', kbOpen)
      })
    }

    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', apply)
    apply()

    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', apply)
    }
  }, [])
}
