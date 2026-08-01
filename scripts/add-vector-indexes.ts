// scripts/add-vector-indexes.ts
// Run with: npx tsx scripts/add-vector-indexes.ts
//
// Creates HNSW indexes on the pgvector embedding columns of Knowledge,
// Memory, and Message tables. HNSW (Hierarchical Navigable Small World)
// is the recommended index type for pgvector >= 0.5.0 — it provides
// approximate nearest neighbor search much faster than a sequential scan.
//
// pgvector version confirmed: 0.8.1 (supports HNSW).
//
// This is a one-time migration — Prisma doesn't natively support pgvector
// index types in the schema DSL, so this is a raw SQL script run directly.
// The IF NOT EXISTS clause makes it safe to re-run.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Creating HNSW indexes on embedding columns...')

  // Knowledge — used in per-request semantic knowledge search (chat/route.ts)
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw_idx
    ON "Knowledge" USING hnsw (embedding vector_cosine_ops)
  `)
  console.log('  ✅ Knowledge.embedding HNSW index created')

  // Memory — used in per-request semantic memory search (memory/route.ts)
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS memory_embedding_hnsw_idx
    ON "Memory" USING hnsw (embedding vector_cosine_ops)
  `)
  console.log('  ✅ Memory.embedding HNSW index created')

  // Message — used in per-request semantic conversation search (conversations/search/route.ts)
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS message_embedding_hnsw_idx
    ON "Message" USING hnsw (embedding vector_cosine_ops)
  `)
  console.log('  ✅ Message.embedding HNSW index created')

  console.log('\nAll HNSW indexes created successfully.')
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e)
    prisma.$disconnect()
    process.exit(1)
  })
