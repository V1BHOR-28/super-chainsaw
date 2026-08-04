-- Drop orphaned Audiobook columns that are never read or written in src/
-- (chapterBoundaries, prepChaptersCleaned, progressChapter, progressCharOffset)
-- and the entire AudiobookChapter model (never queried — audiobook generation
-- is handled by the Flask audiobook-maker service).
-- Also drop AudiobookJob.chapterUrls (replaced by chapterIndices).

-- Drop AudiobookChapter table (has FK to Audiobook, must drop first)
DROP TABLE IF EXISTS "AudiobookChapter";

-- Drop orphaned columns from Audiobook
ALTER TABLE "Audiobook" DROP COLUMN IF EXISTS "chapterBoundaries";
ALTER TABLE "Audiobook" DROP COLUMN IF EXISTS "prepChaptersCleaned";
ALTER TABLE "Audiobook" DROP COLUMN IF EXISTS "progressChapter";
ALTER TABLE "Audiobook" DROP COLUMN IF EXISTS "progressCharOffset";

-- Drop orphaned column from AudiobookJob
ALTER TABLE "AudiobookJob" DROP COLUMN IF EXISTS "chapterUrls";
