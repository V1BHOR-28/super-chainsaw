-- CreateTable: Audiobook
CREATE TABLE "Audiobook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "accent" TEXT NOT NULL DEFAULT '#f59e0b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "progressChapter" INTEGER NOT NULL DEFAULT 0,
    "progressCharOffset" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Audiobook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Audiobook(userId, createdAt)
CREATE INDEX "Audiobook_userId_createdAt_idx" ON "Audiobook"("userId", "createdAt");

-- AddForeignKey: Audiobook.userId → User.id (onDelete: Cascade)
ALTER TABLE "Audiobook" ADD CONSTRAINT "Audiobook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: AudiobookChapter
CREATE TABLE "AudiobookChapter" (
    "id" TEXT NOT NULL,
    "audiobookId" TEXT NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "cleanedText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "audioUrl" TEXT,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudiobookChapter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: AudiobookChapter(audiobookId, chapterIndex) unique
CREATE UNIQUE INDEX "AudiobookChapter_audiobookId_chapterIndex_key" ON "AudiobookChapter"("audiobookId", "chapterIndex");

-- CreateIndex: AudiobookChapter(audiobookId)
CREATE INDEX "AudiobookChapter_audiobookId_idx" ON "AudiobookChapter"("audiobookId");

-- AddForeignKey: AudiobookChapter.audiobookId → Audiobook.id (onDelete: Cascade)
ALTER TABLE "AudiobookChapter" ADD CONSTRAINT "AudiobookChapter_audiobookId_fkey" FOREIGN KEY ("audiobookId") REFERENCES "Audiobook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
