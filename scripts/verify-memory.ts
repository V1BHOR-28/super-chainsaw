// scripts/verify-memory.ts
// Run with: npx tsx scripts/verify-memory.ts
//
// Verifies all memory bug fixes + library/knowledge fixes are in place before deploying.
import fs from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'

type Check = { name: string; pass: boolean; detail?: string }
const results: Check[] = []

/**
 * getFileContent — reads a file relative to the repo root.
 * Prefers the local, already-checked-out copy (correct inside CI — no network
 * call, no CDN lag, always reflects the exact commit being tested). Falls back
 * to fetching from GitHub's raw CDN only if the local read fails, which covers
 * running this script from outside a full repo checkout.
 *
 * URL-encoded path segments (e.g. %5Bid%5D for [id]) are decoded for the local
 * read so they resolve to the actual directory name on disk.
 */
async function getFileContent(relativePath: string): Promise<string> {
  // Decode URL-encoded segments for the local filesystem read (%5Bid%5D → [id])
  const localRelativePath = decodeURIComponent(relativePath)
  try {
    const localPath = path.join(process.cwd(), localRelativePath)
    return await fs.readFile(localPath, 'utf-8')
  } catch {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/V1BHOR-28/super-chainsaw/main/${relativePath}`)
      if (!res.ok) return ''
      return await res.text()
    } catch {
      return ''
    }
  }
}

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
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = !/category === 'personal'.*confidence === 'high'.*confidence: 'medium'/s.test(src)
  results.push({ name: 'no-personal-downgrade', pass, detail: pass ? 'Downgrade rule removed.' : 'Downgrade rule still present in detect/route.ts' })
}

async function checkShortMessageThreshold() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
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

// ─── LIBRARY / KNOWLEDGE FIX CHECKS ───────────────────────────────────────
// These verify the 7 library fixes landed on main. Some read source from
// GitHub raw (so they only pass AFTER a push); others query the DB directly.

async function checkDocumentIdColumnExists() {
  const rows = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Knowledge' AND column_name = 'documentId'
  `
  const pass = rows.length > 0
  results.push({ name: 'documentId-column-exists', pass, detail: pass ? 'Column present.' : 'documentId column missing.' })
}

async function checkDocumentIdActuallyPersisted() {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int as count FROM "Knowledge" WHERE "documentId" IS NOT NULL
  `
  const pass = !!row && row.count > 0
  results.push({ name: 'documentId-persisted', pass, detail: pass ? `${row?.count} rows have a documentId.` : 'No rows have documentId set — it may be generated but never saved.' })
}

async function checkSsrfGuardPresent() {
  const src = await getFileContent('src/app/api/knowledge/route.ts')
  const pass = /isUrlSafe/.test(src)
  results.push({ name: 'ssrf-guard-present', pass, detail: pass ? 'isUrlSafe() found.' : 'No URL validation before fetchUrlContent.' })
}

async function checkTruncationSignaled() {
  const src = await getFileContent('src/app/api/knowledge/route.ts')
  const pass = /truncated/.test(src)
  results.push({ name: 'truncation-signaled', pass, detail: pass ? 'truncated flag found.' : 'No truncation signal.' })
}

async function checkInBookOrderingDeterministic() {
  const src = await getFileContent('src/app/api/chat/route.ts')
  const pass = /distinct:\s*\['title'\][\s\S]{0,80}orderBy:\s*\{\s*title:\s*'asc'\s*\}/.test(src)
  results.push({ name: 'in-book-ordering-deterministic', pass, detail: pass ? 'orderBy present on distinct title query.' : 'No orderBy — result order is non-deterministic.' })
}

async function checkKnowledgePriorityGated() {
  const src = await getFileContent('src/app/api/chat/route.ts')
  const pass = /knowledgeFromSemanticSearch/.test(src)
  results.push({ name: 'knowledge-priority-gated', pass, detail: pass ? 'Semantic-only gate found.' : 'Still cancels web search on any keyword match.' })
}

async function checkDeleteByDocumentId() {
  const src = await getFileContent('src/app/api/knowledge/%5Bid%5D/route.ts')
  const pass = /documentId:\s*id/.test(src) && !/startsWith:\s*`\$\{id\}/.test(src)
  results.push({ name: 'delete-by-documentId', pass, detail: pass ? 'Deletes scoped to documentId, not title string.' : 'Still matching deletes by title string.' })
}

// ─── MEMORY PANEL FIX CHECKS ─────────────────────────────────────────────
// These verify the 6 memory-panel fixes landed on main. Some read source
// from GitHub raw (so they only pass AFTER a push); others query the DB.

async function checkMemoryListPaginated() {
  const src = await getFileContent('src/app/api/memory/route.ts')
  const pass = /nextCursor/.test(src) && /take:\s*limit/.test(src)
  results.push({ name: 'memory-list-paginated', pass, detail: pass ? 'Cursor pagination found.' : 'No pagination — GET still fetches everything.' })
}

async function checkSemanticDedup() {
  const src = await getFileContent('src/app/api/memory/route.ts')
  const pass = /embedding <=>/.test(src) && /distance < 0\.\d+/.test(src)
  results.push({ name: 'semantic-dedup-present', pass, detail: pass ? 'Semantic dedup query found.' : 'Dedup still word-overlap only.' })
}

async function checkDuplicateErrorHandledInUi() {
  const src = await getFileContent('src/components/aria/side-panels.tsx')
  const pass = /status === 409/.test(src)
  results.push({ name: 'duplicate-error-surfaced', pass, detail: pass ? '409 handled distinctly in UI.' : 'Still a generic error on duplicate.' })
}

async function checkEditInPlace() {
  const src = await getFileContent('src/components/aria/side-panels.tsx')
  const pass = /editingId/.test(src)
  results.push({ name: 'edit-in-place-present', pass, detail: pass ? 'Inline edit state found.' : 'No edit UI found.' })
}

async function checkPatchRegeneratesEmbedding() {
  const src = await getFileContent('src/app/api/memory/%5Bid%5D/route.ts')
  const pass = /generateEmbedding/.test(src)
  results.push({ name: 'patch-regenerates-embedding', pass, detail: pass ? 'Embedding regeneration found in PATCH.' : 'PATCH still leaves stale embeddings on content edit.' })
}

async function checkSourceColumnExists() {
  const rows = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Memory' AND column_name = 'source'
  `
  results.push({ name: 'memory-source-column-exists', pass: rows.length > 0, detail: rows.length > 0 ? 'Column present.' : 'source column missing from Memory table.' })
}

// ─── ROLLING CONVERSATION SUMMARY CHECKS ──────────────────────────────────
// These verify the rolling-summary feature landed on main.

async function checkConversationSummaryColumnExists() {
  const rows = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name = 'summary'
  `
  results.push({ name: 'conversation-summary-column-exists', pass: rows.length > 0, detail: rows.length > 0 ? 'Column present.' : 'summary column missing from Conversation table.' })
}

async function checkRecentMessagesWidened() {
  const src = await getFileContent('src/app/api/chat/route.ts')
  const match = src.match(/orderBy:\s*\{\s*createdAt:\s*'desc'\s*\},\s*take:\s*(\d+),/)
  const take = match ? parseInt(match[1], 10) : null
  results.push({ name: 'recent-messages-widened', pass: take !== null && take >= 8, detail: `take is ${take}, expected >= 8` })
}

async function checkSummaryUpdateWired() {
  const src = await getFileContent('src/app/api/chat/route.ts')
  const pass = /updateConversationSummary/.test(src)
  results.push({ name: 'summary-update-wired', pass, detail: pass ? 'updateConversationSummary called.' : 'Not called anywhere in chat/route.ts.' })
}

async function checkSummaryInjectedIntoPrompt() {
  const src = await getFileContent('src/lib/aria.ts')
  const pass = /conversationSummary/.test(src)
  results.push({ name: 'summary-injected-into-prompt', pass, detail: pass ? 'conversationSummary param found in buildAriaSystemPrompt.' : 'Not wired into the system prompt.' })
}

async function checkSummarizationDoesntBlockResponse() {
  const src = await getFileContent('src/app/api/chat/route.ts')
  const pass = /updateConversationSummary\([^)]*\)\.catch/.test(src) && !/await\s+updateConversationSummary/.test(src)
  results.push({ name: 'summary-update-non-blocking', pass, detail: pass ? 'Fire-and-forget, not awaited.' : 'Either missing .catch() or being awaited — check it is not blocking the response.' })
}

// ─── MEMORY DETECTION HARDENING CHECKS ────────────────────────────────────
// These verify the memory-detection hardening landed on main.
// (The structured-json-output-requested check was removed when the detect
// route moved off OpenRouter onto the free llm-fallback helper — Groq/
// Pollinations don't support response_format: json_object. The regex
// extraction in detect/route.ts is now the primary parse path, kept as a
// safety net per the original hardening prompt.)

async function checkDetectionLoggingPresent() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /console\.(error|warn)\(`\[memory\.detect\]/.test(src)
  results.push({ name: 'detection-failure-logging', pass, detail: pass ? 'Distinguishable log lines found.' : 'Failures still silent.' })
}

async function checkDeterministicFallbackPresent() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /extractObviousCandidates/.test(src)
  results.push({ name: 'deterministic-fallback-present', pass, detail: pass ? 'Pattern-match fallback found.' : 'Detection still 100% dependent on one LLM call.' })
}

// ─── DETECT-OFF-OPENROUTER CHECKS ─────────────────────────────────────────
// These verify the detect route moved off OpenRouter (402 credits) onto the
// free llm-fallback helper, and that LLM failures route to the deterministic floor.

async function checkDetectionUsesLlmFallback() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /from '@\/lib\/llm-fallback'/.test(src) && !/openrouter\.ai\/api/.test(src)
  results.push({ name: 'detection-uses-free-fallback', pass, detail: pass ? 'Detect route no longer calls OpenRouter directly.' : 'Still hitting OpenRouter directly, or import missing.' })
}

async function checkDetectionFallsBackToDeterministicOnFailure() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /extractObviousCandidates\(userMessage\)/.test(src)
  const occurrences = (src.match(/extractObviousCandidates\(userMessage\)/g) || []).length
  results.push({ name: 'deterministic-fallback-on-llm-failure', pass: pass && occurrences >= 2, detail: `Found ${occurrences} call(s) — expect at least 2 (normal merge path + failure path).` })
}

// ─── DETECTION QUALITY CHECKS ─────────────────────────────────────────────
// These verify the 4 detection-quality fixes (larger model, Gemini tier,
// specificity rule, widened patterns) landed on main.

async function checkLargerGroqModelForDetection() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /llama-3\.3-70b-versatile/.test(src)
  results.push({ name: 'larger-model-for-detection', pass, detail: pass ? '70B model used for detection.' : 'Still using the small 8B model.' })
}

async function checkGeminiFallbackForDetection() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /callGeminiForExtraction/.test(src)
  results.push({ name: 'gemini-fallback-for-detection', pass, detail: pass ? 'Gemini fallback tier found.' : 'No second-provider fallback before deterministic patterns.' })
}

async function checkSpecificityRuleInPrompt() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const pass = /NEVER generalize/.test(src)
  results.push({ name: 'specificity-rule-present', pass, detail: pass ? 'Specificity rule found in prompt.' : 'Prompt still allows vague generalization.' })
}

async function checkPatternListWidened() {
  const src = await getFileContent('src/app/api/memory/detect/route.ts')
  const count = (src.match(/regex:\s*\//g) || []).length
  results.push({ name: 'pattern-list-widened', pass: count >= 8, detail: `Found ${count} patterns, expected >= 8.` })
}

async function main() {
  await checkConversationOrdering()
  await checkPersonalConfidenceNotDowngraded()
  await checkShortMessageThreshold()
  await checkEnvVarsPresent()
  await checkEmbeddingGenerationWorks()
  await checkNoOrphanedEmbeddings()
  // Library / knowledge fixes
  await checkDocumentIdColumnExists()
  await checkDocumentIdActuallyPersisted()
  await checkSsrfGuardPresent()
  await checkTruncationSignaled()
  await checkInBookOrderingDeterministic()
  await checkKnowledgePriorityGated()
  await checkDeleteByDocumentId()
  // Memory panel fixes
  await checkMemoryListPaginated()
  await checkSemanticDedup()
  await checkDuplicateErrorHandledInUi()
  await checkEditInPlace()
  await checkPatchRegeneratesEmbedding()
  await checkSourceColumnExists()
  // Rolling conversation summary
  await checkConversationSummaryColumnExists()
  await checkRecentMessagesWidened()
  await checkSummaryUpdateWired()
  await checkSummaryInjectedIntoPrompt()
  await checkSummarizationDoesntBlockResponse()
  // Memory detection hardening
  await checkDetectionLoggingPresent()
  await checkDeterministicFallbackPresent()
  // Detect off OpenRouter
  await checkDetectionUsesLlmFallback()
  await checkDetectionFallsBackToDeterministicOnFailure()
  // Detection quality
  await checkLargerGroqModelForDetection()
  await checkGeminiFallbackForDetection()
  await checkSpecificityRuleInPrompt()
  await checkPatternListWidened()

  console.table(results.map((r) => ({ Check: r.name, Result: r.pass ? 'PASS' : 'FAIL', Detail: r.detail })))
  const anyFail = results.some((r) => !r.pass)
  if (anyFail) {
    console.error('\n❌ One or more checks failed. Do not deploy.')
    process.exit(1)
  }
  console.log('\n✅ All checks passed.')
}

main()
