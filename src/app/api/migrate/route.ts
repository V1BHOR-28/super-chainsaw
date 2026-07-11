import { NextResponse } from 'next/server'
export const runtime = "nodejs"
import { db } from '@/lib/db'

/**
 * GET /api/migrate — one-time migration to change pgvector columns from
 * vector(1536) to vector(768) for Gemini text-embedding-004 compatibility.
 *
 * Since embeddings never worked before (OpenAI key had 0 credits + region block),
 * there are NO existing embeddings in the database — so dropping and recreating
 * the columns is safe. No data loss.
 *
 * After running this, new uploads will get Gemini embeddings (768 dims).
 */
export async function GET() {
  const results: string[] = []

  try {
    // Knowledge table — drop old column, add new one
    await db.$executeRawUnsafe(`ALTER TABLE "Knowledge" DROP COLUMN IF EXISTS embedding;`)
    await db.$executeRawUnsafe(`ALTER TABLE "Knowledge" ADD COLUMN IF NOT EXISTS embedding vector(768);`)
    results.push('✅ Knowledge.embedding: vector(1536) → vector(768)')

    // Memory table — same
    await db.$executeRawUnsafe(`ALTER TABLE "Memory" DROP COLUMN IF EXISTS embedding;`)
    await db.$executeRawUnsafe(`ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS embedding vector(768);`)
    results.push('✅ Memory.embedding: vector(1536) → vector(768)')

    // Create indexes for faster vector search
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS knowledge_embedding_idx ON "Knowledge" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`)
    results.push('✅ Knowledge embedding index created')

    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS memory_embedding_idx ON "Memory" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`)
    results.push('✅ Memory embedding index created')

    return NextResponse.json({
      ok: true,
      message: 'Migration complete. pgvector columns changed from 1536 to 768 dims.',
      details: results,
    })
  } catch (err) {
    console.error('[migrate]', err)
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Migration failed',
      details: results,
    }, { status: 500 })
  }
}
