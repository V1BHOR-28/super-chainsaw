/**
 * CRITICAL GROUNDING TEST — verify ARIA now reports the EXACT score (2-0)
 * from search and does NOT mention 2022 or any other past tournament.
 */
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
const ariaPassword = 'AriaGroundingFixed123!'
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
await fetch(`${ARIA}/api/auth/onboard`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: JSON.stringify({ name: 'Grounding Tester', persona: 'professional', age: 28, occupation: 'tester' }) })
console.log('✓ authenticated')

const convData = await (await fetch(`${ARIA}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() }, body: JSON.stringify({ title: 'Grounding test' }) })).json()
const conversationId = convData.id || convData.conversation?.id

console.log('\n' + '='.repeat(60))
console.log('TEST: "what do you think about France vs Morocco?"')
console.log('='.repeat(60))

const chatRes = await fetch(`${ARIA}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
  body: JSON.stringify({ conversationId, content: 'what do you think about France vs Morocco?' }),
})
const reader = chatRes.body!.getReader()
const decoder = new TextDecoder()
let buffer = '', fullText = ''
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try { const evt = JSON.parse(line.slice(6)); if (evt.type === 'token') fullText += evt.value } catch {}
  }
}

console.log(`\n--- ARIA RESPONSE ---\n${fullText}\n--- END ---\n`)

const lower = fullText.toLowerCase()
const saysTwoZero = lower.includes('2-0') || lower.includes('2 – 0') || lower.includes('2–0') || lower.includes('2 0')
const saysTwoOne = lower.includes('2-1') || lower.includes('2–1') || lower.includes('2 1')
const mentions2022 = lower.includes('2022')
const mentions2026 = lower.includes('2026')
const mentionsRematch = lower.includes('rematch') || lower.includes('2022 semifinal') || lower.includes('rematch of')

console.log('='.repeat(60))
console.log('VERDICT')
console.log('='.repeat(60))
console.log(`Says 2-0 (CORRECT score):        ${saysTwoZero ? '✓ YES' : '✗ no'}`)
console.log(`Says 2-1 (WRONG — hallucinated): ${saysTwoOne ? '❌ YES (BAD)' : '✓ no'}`)
console.log(`Mentions 2022 (FORBIDDEN):       ${mentions2022 ? '❌ YES (conflation)' : '✓ no'}`)
console.log(`Mentions 2026 (correct year):    ${mentions2026 ? '✓ YES' : '— neutral'}`)
console.log(`Says "rematch"/"2022 semifinal": ${mentionsRematch ? '❌ YES (training bleed)' : '✓ no'}`)

const pass = saysTwoZero && !saysTwoOne && !mentions2022
console.log(`\n${pass ? '✅✅✅ PASS — exact score (2-0), no year conflation. Grounding fixed.' : '❌ FAIL — review above'}`)
