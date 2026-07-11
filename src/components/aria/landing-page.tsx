'use client'

import { useEffect, useRef } from 'react'

/**
 * LandingPage — renders the intern's exact 1439-line landing HTML (served
 * verbatim from /public/aria-landing.html) inside a full-bleed iframe.
 *
 * The HTML is preserved line-for-line with zero modifications. Sign-in is
 * bridged via postMessage: when the user clicks any sign-in action inside the
 * iframe (Sign in, Start talking, OAuth buttons, form submit), the iframe
 * sends a postMessage to the parent. The parent calls `onOpenAuth()` to show
 * the real React auth modal.
 *
 * After successful auth, the parent component (page.tsx) re-checks the session
 * and renders the app — the landing page unmounts automatically.
 */
export function LandingPage({ onOpenAuth }: { onOpenAuth: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const openAuthRef = useRef(onOpenAuth)

  // Keep the ref in sync with the latest callback (in an effect, not during render)
  useEffect(() => {
    openAuthRef.current = onOpenAuth
  }, [onOpenAuth])

  // Listen for sign-in messages from the iframe
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'aria-open-auth') {
        openAuthRef.current()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // After the iframe loads, inject the sign-in bridge WITHOUT modifying the
  // source HTML file. All auth actions inside the iframe trigger postMessage.
  const handleLoad = () => {
    const iframe = iframeRef.current
    if (!iframe) return
    try {
      const doc = iframe.contentDocument
      if (!doc) return
      const bridge = doc.createElement('script')
      bridge.textContent = `
        // Bridge: notify parent to open the real auth modal.
        function ariaOpenAuth() { parent.postMessage({ type: 'aria-open-auth' }, '*'); }
        // Neutralize alert so the original handleAuthSubmit doesn't block
        window.alert = function() {};
        // Suppress the iframe's own auth modal — we handle auth in the parent React layer
        window.openModal = function() { ariaOpenAuth(); };
        window.closeModal = function() {};
        // Hide the iframe's auth modal element entirely so it never shows
        var iframeAuthModal = document.getElementById('authModal');
        if (iframeAuthModal) iframeAuthModal.style.display = 'none';
        // Override the email-submit handler
        window.handleAuthSubmit = function() { ariaOpenAuth(); };
        // Also intercept the form submit directly as a backup
        var form = document.querySelector('form');
        if (form) {
          form.addEventListener('submit', function(e) { e.preventDefault(); ariaOpenAuth(); }, true);
        }
        // Wire OAuth buttons (Google / GitHub) — prevent default and open parent modal
        document.querySelectorAll('.oauth-btn').forEach(function(b) {
          b.addEventListener('click', function(e) { e.preventDefault(); ariaOpenAuth(); });
        });
        // Wire "Sign in" buttons in the nav and hero
        document.querySelectorAll('button').forEach(function(b) {
          var text = b.textContent.toLowerCase();
          if (text.includes('sign in') || text.includes('start talking')) {
            b.addEventListener('click', function(e) { e.preventDefault(); ariaOpenAuth(); });
          }
        });
        // Wire the "Create an account" link
        document.querySelectorAll('.modal-card a').forEach(function(a) {
          if (a.textContent.toLowerCase().includes('create')) {
            a.addEventListener('click', function(e) { e.preventDefault(); ariaOpenAuth(); });
          }
        });
      `
      doc.body.appendChild(bridge)
    } catch {
      // Cross-origin — shouldn't happen for same-origin /public files
    }
  }

  return (
    <iframe
      ref={iframeRef}
      src="/aria-landing.html"
      onLoad={handleLoad}
      title="ARIA — Not a chatbot. A partner."
      className="fixed inset-0 w-full h-full border-0"
      style={{ background: '#0c0a08' }}
    />
  )
}

export default LandingPage
