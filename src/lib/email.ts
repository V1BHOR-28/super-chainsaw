import nodemailer from 'nodemailer'

// Gmail credentials — set these in Vercel dashboard
// GMAIL_USER: your Gmail address (e.g. you@gmail.com)
// GMAIL_APP_PASSWORD: a 16-char app password from Google (NOT your regular password)
//   Create at: https://myaccount.google.com/apppasswords
const GMAIL_USER = process.env.GMAIL_USER || ''
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || ''

let transporter: nodemailer.Transporter | null = null

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
      },
    })
  }
  return transporter
}

/**
 * Send a 6-digit verification code to the user's email via Gmail SMTP.
 * Gmail allows sending to ANY email address (up to 500/day for free).
 *
 * Returns { success: boolean, error?: string } so the caller can show
 * the actual error message to the user.
 */
export async function sendVerificationEmail(
  email: string,
  code: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return {
        success: false,
        error: 'Email service not configured. Contact support.',
      }
    }

    const transport = getTransporter()

    await transport.sendMail({
      from: `"ARIA" <${GMAIL_USER}>`,
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

    return { success: true }
  } catch (err) {
    console.error('[email.send]', err)
    const message = err instanceof Error ? err.message : 'Email delivery failed'
    return { success: false, error: message }
  }
}
