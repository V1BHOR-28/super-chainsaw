// scripts/backfill-memory-embeddings.ts
// Run with: npx tsx scripts/backfill-memory-embeddings.ts
//
// One-time backfill: finds all Memory rows with NULL embeddings (created
// during the period when embeddings were broken — wrong Gemini model name)
// and generates embeddings for them using the now-fixed Gemini API.
import { db } from '@/lib/db'
import { generateEmbedding, embeddingToPgVector } from '@/lib/embeddings'

async function main() {
  const orphaned = await db.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT id, content FROM "Memory" WHERE embedding IS NULL
  `
  console.log(`Found ${orphaned.length} memories with no embedding.`)

  if (orphaned.length === 0) {
    console.log('Nothing to backfill. All memories have embeddings.')
    process.exit(0)
  }

  let success = 0
  let failed = 0

  for (const m of orphaned) {
    const emb = await generateEmbedding(m.content)
    if (!emb) {
      console.warn(`  Skipped ${m.id} — embedding generation failed`)
      failed++
      continue
    }
    await db.$executeRaw`
      UPDATE "Memory" SET embedding = ${embeddingToPgVector(emb)}::vector WHERE id = ${m.id}
    `
    console.log(`  Backfilled ${m.id}`)
    success++
  }

  console.log(`\nDone. ${success} backfilled, ${failed} failed.`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
