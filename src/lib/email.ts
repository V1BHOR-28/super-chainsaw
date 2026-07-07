import { Resend } from 'resend'

// All secrets read from environment variables — set these in Vercel dashboard
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev'

/**
 * Resend email client — used for sending 6-digit verification codes.
 * Singleton pattern so we don't create a new client on every request.
 */
let resendInstance: Resend | null = null

export function getResend(): Resend {
  if (!resendInstance) {
    resendInstance = new Resend(RESEND_API_KEY)
  }
  return resendInstance
}

/**
 * Send a 6-digit verification code to the user's email.
 * Uses Resend's default sender address (onboarding@resend.dev) on the free tier.
 *
 * Returns { success: boolean, error?: string } so the caller can show
 * the actual error message to the user (instead of swallowing it).
 */
export async function sendVerificationEmail(
  email: string,
  code: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const resend = getResend()
    const from = EMAIL_FROM

    const { error } = await resend.emails.send({
      from,
      to: email,
      subject: 'Your ARIA verification code',
      html: `
        <div style="font-family: 'Space Grotesk', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0c0a08; color: #f5f1eb; border-radius: 16px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: radial-gradient(circle at 30% 30%, #fcd34d, #fbbf24 50%, #92400e 100%); margin: 0 auto 16px; box-shadow: 0 0 20px rgba(245, 158, 11, 0.5);"></div>
            <h1 style="font-family: 'Instrument Serif', serif; font-size: 28px; margin: 0; color: #f5f1eb;">ARIA</h1>
          </div>
          <p style="color: #a89888; font-size: 14px; text-align: center; margin-bottom: 24px;">Here's your verification code:</p>
          <div style="text-align: center; padding: 24px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(252, 211, 77, 0.15); border-radius: 12px; margin-bottom: 24px;">
            <span style="font-family: 'JetBrains Mono', monospace; font-size: 36px; letter-spacing: 0.3em; color: #fcd34d; font-weight: 500;">${code}</span>
          </div>
          <p style="color: #5a4d40; font-size: 12px; text-align: center; margin: 0;">This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
      text: `Your ARIA verification code is: ${code}\n\nThis code expires in 15 minutes. If you didn't request this, you can safely ignore this email.`,
    })

    if (error) {
      console.error('[email.send] Resend API error:', error)
      // Resend returns a specific error when the recipient isn't allowed on free tier
      if (error.message?.includes('restricted') || error.message?.includes('not verified')) {
        return {
          success: false,
          error: 'Email delivery is restricted on the free plan. Only the account owner email can receive codes until a custom domain is verified in Resend.',
        }
      }
      return { success: false, error: error.message || 'Email delivery failed' }
    }

    return { success: true }
  } catch (err) {
    console.error('[email.send]', err)
    const message = err instanceof Error ? err.message : 'Email delivery failed'
    return { success: false, error: message }
  }
}
