// Check usage + retry the chat with a small delay (in case it's rate limiting)
const ARIA = 'https://ariav2-seven.vercel.app'
const MAILTM = 'https://api.mail.tm'
const cookieJar = new Map<string, string>()
const captureCookies = (r: Response) => {
  for (const sc of r.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}
const cookieHeader = () => Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = (await (await fetch(`${MAILTM}/domains`)).json())['hydra:member'][0].domain
const emailAddr = `aria-test-${Date.now()}@${domain}`
const emailPass = `AriaTest${Date.now()}!`
const ariaPassword = 'AriaRetryTest123!'
await fetch(`${MAILTM}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: emailAddr, password: emailPass }) })
const mailToken = (await (await fetch(`${MAILTM}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: emailAddr, password: emailPass }) })).json()).token
await fetch(`${ARIA}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailAddr, password: ariaPassword }) })
let code: string | null = null
for (let i = 0; i < 30; i++) {
  await sleep(3000)
  const msgs = (await (await fetch(`${MAILTM}/messages`, { headers: { Authorization: `Bearer ${mailToken}` } })).json())['hydra:member'] || []
  if (msgs.length > 0) {
    const msg = await (await fetch(`${MAILTM}/messages/${msgs[0].id}`, { headers: { Authorization: `Bearer ${mailToken}` } })).json()
    const m = (msg.text || msg.html || '').match(/\b(\d{6})\b/)
    if (m) { code = m[1]; break }
  }
}
await fetch(`${ARIA}/api/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailAddr, code }) })
const csrfRes = await fetch(`${ARIA}/api/auth/csrf`)
captureCookies(csrfRes)
const csrf = (await csrfRes.json()).csrfToken
const authRes = await fetch(`${ARIA}/api/auth/callback/credentials`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
  body: new URLSearchParams({ email: emailAddr, password: ariaPassword, csrfToken: csrf, callbackUrl: `${ARIA}/`, json: 'true' }).toString(),
  redirect: 'manual',
})
captureCookies(authRes)
await fetch(`${ARIA}/api/auth/onboard`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: JSON.stringify({ name: 'Retry Test', persona: 'professional', age: 28, occupation: 't' }) })

// Check usage first
console.log('=== Usage check ===')
const usageRes = await fetch(`${ARIA}/api/usage`, { headers: { Cookie: cookieHeader() } })
console.log('Usage:', await usageRes.text())

const convData = await (await fetch(`${ARIA}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: JSON.stringify({ title: 'retry' }) })).json()
const conversationId = convData.id || convData.conversation?.id

// Wait 30s for any rate limit to clear, then retry
console.log('\nWaiting 30s for rate limit to clear...')
await sleep(30000)

console.log('\n=== Retry: France vs Morocco ===')
const res = await fetch(`${ARIA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: JSON.stringify({ conversationId, content: 'what do you think about France vs Morocco?' }) })
let txt = '', eventType = ''
if (res.body) {
  const r = res.body.getReader()
  const d = new TextDecoder()
  let b = ''
  while (true) {
    const { done, value } = await r.read()
    if (done) break
    b += d.decode(value, { stream: true })
    const lines = b.split('\n')
    b = lines.pop() || ''
    for (const l of lines) {
      if (l.startsWith('data: ')) {
        try {
          const e = JSON.parse(l.slice(6))
          if (e.type === 'token') txt += e.value
          else if (e.type === 'error') { txt = '[ERROR] ' + e.message; eventType = 'error' }
          else if (e.type === 'limit') { txt = '[LIMIT] ' + e.message; eventType = 'limit' }
          else if (e.type === 'done') eventType = 'done'
        } catch {}
      }
    }
  }
}
console.log('Event type:', eventType)
console.log('Response:', txt.slice(0, 500))
