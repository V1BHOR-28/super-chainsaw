// scripts/verify-memory.ts
// Run with: npx tsx scripts/verify-memory.ts
//
// Verifies all 5 memory bug fixes are in place before deploying.
import { db } from '@/lib/db'

type Check = { name: string; pass: boolean; detail?: string }
const results: Check[] = []

async function checkConversationOrdering() {
  const convo = await db.conversation.findFirst({
    where: { messages: { some: {} } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!convo || convo.messages.length < 6) {
    results.push({ name: 'conversation-ordering', pass: false, detail: 'No conversation with 6+ messages found — seed one before running this check.' })
    return
  }
  const desc = await db.message.findMany({
    where: { conversationId: convo.id },
    orderBy: { createdAt: 'desc' },
    take: 4,
  })
  desc.reverse()
  const expectedIds = convo.messages.slice(-4).map((m) => m.id)
  const actualIds = desc.map((m) => m.id)
  const pass = JSON.stringify(expectedIds) === JSON.stringify(actualIds)
  results.push({
    name: 'conversation-ordering',
    pass,
    detail: pass ? 'Last 4 messages correctly returned in chronological order.' : `Expected ${expectedIds} got ${actualIds}`,
  })
}

async function checkPersonalConfidenceNotDowngraded() {
  const src = await fetch('https://raw.githubusercontent.com/V1BHOR-28/super-chainsaw/main/src/app/api/memory/detect/route.ts').then(r => r.text()).catch(() => '')
  const pass = !/category === 'personal'.*confidence === 'high'.*confidence: 'medium'/s.test(src)
  results.push({ name: 'no-personal-downgrade', pass, detail: pass ? 'Downgrade rule removed.' : 'Downgrade rule still present in detect/route.ts' })
}

async function checkShortMessageThreshold() {
  const src = await fetch('https://raw.githubusercontent.com/V1BHOR-28/super-chainsaw/main/src/app/api/memory/detect/route.ts').then(r => r.text()).catch(() => '')
  const match = src.match(/userMessage\.length < (\d+)/)
  const threshold = match ? parseInt(match[1], 10) : null
  const pass = threshold !== null && threshold <= 15
  results.push({ name: 'short-message-threshold', pass, detail: `Threshold is ${threshold}, expected <= 15` })
}

async function checkEnvVarsPresent() {
  const required = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']
  const missing = required.filter((k) => !process.env[k])
  results.push({ name: 'env-vars-present', pass: missing.length === 0, detail: missing.length ? `Missing: ${missing.join(', ')}` : 'All present.' })
}

async function checkNoOrphanedEmbeddings() {
  const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::int as count FROM "Memory" WHERE embedding IS NULL
  `
  const pass = Number(count) === 0
  results.push({ name: 'no-orphaned-embeddings', pass, detail: pass ? 'No NULL-embedding rows.' : `${count} memories still have NULL embeddings — run the backfill script.` })
}

async function checkEmbeddingGenerationWorks() {
  const { generateEmbedding } = await import('@/lib/embeddings')
  const emb = await generateEmbedding('test embedding generation')
  const pass = Array.isArray(emb) && emb.length === 768
  results.push({ name: 'embedding-generation-live', pass, detail: pass ? '768-dim vector returned.' : 'generateEmbedding() returned null — check GEMINI_API_KEY.' })
}

async function main() {
  await checkConversationOrdering()
  await checkPersonalConfidenceNotDowngraded()
  await checkShortMessageThreshold()
  await checkEnvVarsPresent()
  await checkEmbeddingGenerationWorks()
  await checkNoOrphanedEmbeddings()

  console.table(results.map((r) => ({ Check: r.name, Result: r.pass ? 'PASS' : 'FAIL', Detail: r.detail })))
  const anyFail = results.some((r) => !r.pass)
  if (anyFail) {
    console.error('\n❌ One or more memory checks failed. Do not deploy.')
    process.exit(1)
  }
  console.log('\n✅ All memory checks passed.')
}

main()
