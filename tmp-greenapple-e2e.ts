/**
 * END-TO-END GREEN APPLE TEST — runs against the LIVE Vercel deployment.
 *
 * Flow:
 *   1. Get CSRF token from NextAuth
 *   2. Authenticate as test@aria.dev via credentials provider
 *   3. Create a conversation
 *   4. POST "/green apple what do you think about France vs Morocco?" to /api/chat
 *   5. Capture the full SSE-streamed response
 *   6. Verify it surfaces the REAL result (France won 2-0), not a hypothetical preview
 *
 * Usage: bun tmp-greenapple-e2e.ts <password>
 */
const BASE = 'https://ariav2-seven.vercel.app'
const EMAIL = 'test@aria.dev'
const PASSWORD = process.argv[2]

if (!PASSWORD) {
  console.error('ERROR: password required as first argument')
  console.error('Usage: bun tmp-greenapple-e2e.ts <test@aria.dev password>')
  process.exit(1)
}

const cookieJar = new Map<string, string>()

function captureCookies(response: Response) {
  const setCookies = response.headers.getSetCookie?.() ?? []
  for (const sc of setCookies) {
    const [pair] = sc.split(';')
    const [name, value] = pair.split('=')
    if (name && value) cookieJar.set(name.trim(), value.trim())
  }
}

function cookieHeader(): string {
  return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n${'='.repeat(60)}\nSTEP: ${name}\n${'='.repeat(60)}`)
  await fn()
}

// ─── 1. CSRF ──────────────────────────────────────────────────────────────
await step('Get CSRF token', async () => {
  const r = await fetch(`${BASE}/api/auth/csrf`, { headers: { 'accept': 'application/json' } })
  captureCookies(r)
  const data = await r.json()
  console.log(`HTTP ${r.status}`)
  console.log(`csrfToken: ${data.csrfToken?.slice(0, 16)}...`)
  console.log(`cookies so far: ${[...cookieJar.keys()].join(', ')}`)
  ;(globalThis as any).__csrf = data.csrfToken
})

// ─── 2. AUTHENTICATE ──────────────────────────────────────────────────────
await step(`Authenticate as ${EMAIL}`, async () => {
  const csrf = (globalThis as any).__csrf
  const body = new URLSearchParams({
    email: EMAIL,
    password: PASSWORD,
    csrfToken: csrf,
    callbackUrl: `${BASE}/`,
    json: 'true',
  })
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(),
    },
    body: body.toString(),
    redirect: 'manual',
  })
  captureCookies(r)
  console.log(`HTTP ${r.status} (307/200 = success, 401 = bad credentials)`)
  console.log(`cookies after auth: ${[...cookieJar.keys()].join(', ')}`)
  const sessionCookie = cookieJar.get('next-auth.session-token')
  console.log(`session token present: ${!!sessionCookie}`)
  if (!sessionCookie) {
    console.log('AUTH FAILED — cannot continue. Check password.')
    process.exit(1)
  }
})

// ─── 3. VERIFY SESSION ────────────────────────────────────────────────────
await step('Verify session is authenticated', async () => {
  const r = await fetch(`${BASE}/api/auth/session`, { headers: { 'Cookie': cookieHeader() } })
  const data = await r.json()
  console.log(`HTTP ${r.status}`)
  console.log(`session: ${JSON.stringify(data).slice(0, 200)}`)
  if (!data.authenticated && !data.user) {
    console.log('Session not authenticated — aborting.')
    process.exit(1)
  }
})

// ─── 4. CREATE CONVERSATION ───────────────────────────────────────────────
let conversationId: string
await step('Create a conversation', async () => {
  const r = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader() },
    body: JSON.stringify({ title: 'Green Apple Test — France vs Morocco' }),
  })
  const data = await r.json()
  console.log(`HTTP ${r.status}`)
  console.log(`response: ${JSON.stringify(data).slice(0, 200)}`)
  conversationId = data.id || data.conversationId
  if (!conversationId) {
    console.log('No conversation ID returned — aborting.')
    process.exit(1)
  }
  console.log(`conversationId: ${conversationId}`)
})

// ─── 5. GREEN APPLE CHAT ──────────────────────────────────────────────────
await step('POST /green apple France vs Morocco to /api/chat (SSE)', async () => {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader() },
    body: JSON.stringify({
      conversationId,
      content: '/green apple what do you think about France vs Morocco?',
    }),
  })
  console.log(`HTTP ${r.status}`)
  console.log(`content-type: ${r.headers.get('content-type')}`)

  if (!r.ok || !r.body) {
    console.log(`ERROR body: ${(await r.text()).slice(0, 500)}`)
    process.exit(1)
  }

  // Parse SSE stream
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let toolEvents = 0
  let imageEvents = 0
  let doneEvent: any = null
  let errorEvent: any = null
  let limitEvent: any = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const evt = JSON.parse(line.slice(6))
        if (evt.type === 'token') fullText += evt.value
        else if (evt.type === 'tool') { toolEvents++; console.log(`[tool event] ${JSON.stringify(evt).slice(0, 150)}`) }
        else if (evt.type === 'image') { imageEvents++; console.log(`[image event] ${evt.url?.slice(0, 80)}`) }
        else if (evt.type === 'done') { doneEvent = evt; console.log(`[done] messageId=${evt.messageId}, usage=${JSON.stringify(evt.usage)}`) }
        else if (evt.type === 'error') { errorEvent = evt; console.log(`[ERROR event] ${evt.message}`) }
        else if (evt.type === 'limit') { limitEvent = evt; console.log(`[LIMIT event] ${evt.message}`) }
      } catch {}
    }
  }

  console.log(`\n--- ARIA'S FULL RESPONSE ---\n${fullText}\n--- END ---`)
  console.log(`\nEvents: tokens streamed, ${toolEvents} tool, ${imageEvents} image, done=${!!doneEvent}, error=${!!errorEvent}, limit=${!!limitEvent}`)

  // ─── 6. VERDICT ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60))
  console.log('VERDICT')
  console.log('='.repeat(60))
  const lower = fullText.toLowerCase()
  const mentionsFranceWon = lower.includes('france won') || lower.includes('france 2') || (lower.includes('france') && (lower.includes('2-0') || lower.includes('2 0')))
  const mentionsHypothetical = lower.includes('will be') || lower.includes('going to be') || lower.includes('could be') || lower.includes('would be') || lower.includes('if they play')
  const mentionsFinalScore = lower.includes('full time') || lower.includes('final score') || lower.includes('2-0') || lower.includes('finished')

  console.log(`Mentions France won / score 2-0: ${mentionsFranceWon ? '✓ YES' : '✗ NO'}`)
  console.log(`Mentions final score / full time: ${mentionsFinalScore ? '✓ YES' : '✗ NO'}`)
  console.log(`Uses hypothetical future tense:   ${mentionsHypothetical ? '⚠ YES (bad)' : '✓ NO'}`)

  if (mentionsFranceWon && !mentionsHypothetical) {
    console.log('\n✅ PASS — ARIA surfaced the REAL match result. Fix is working on Vercel.')
  } else if (mentionsHypothetical && !mentionsFranceWon) {
    console.log('\n❌ FAIL — ARIA still treats it as a hypothetical/future match. Fix may not be live yet.')
  } else {
    console.log('\n⚠ AMBIGUOUS — review the full response above to judge.')
  }
})
