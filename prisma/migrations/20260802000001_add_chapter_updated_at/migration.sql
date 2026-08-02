-- AlterTable: add updatedAt column to AudiobookChapter
-- The @updatedAt directive in schema.prisma auto-populates this on every write.
-- Default to CURRENT_TIMESTAMP so existing rows don't have NULL updatedAt
-- (which would make the stuck-chapter recovery pass in prep-batch think they're
-- stuck since epoch 0).
ALTER TABLE "AudiobookChapter" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: set existing rows' updatedAt to their createdAt so the
-- stuck-chapter recovery pass (prep-batch.ts:171-185) doesn't immediately
-- reset all existing 'generating' rows to 'pending' on the first poll
-- after deploy.
UPDATE "AudiobookChapter" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
