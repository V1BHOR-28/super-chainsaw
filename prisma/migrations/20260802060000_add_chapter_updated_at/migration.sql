-- AlterTable: add updatedAt column to AudiobookChapter
ALTER TABLE "AudiobookChapter" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows with their createdAt value
UPDATE "AudiobookChapter" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
