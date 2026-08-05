/**
 * Transcript timing estimator — splits chapter text into sentences and
 * estimates per-sentence timestamps (start_ms / end_ms) based on the
 * chapter's total audio duration.
 *
 * This is the "Phase 1" approach: no per-word timestamps from the TTS
 * engine, just proportional distribution by character count. Accuracy is
 * ±2-4 seconds per sentence — good enough for sentence-level highlighting
 * + tap-to-seek.
 *
 * The algorithm:
 *   1. Split text into sentences (same regex as the TTS engine uses)
 *   2. Compute each sentence's char count
 *   3. Distribute the chapter's audio duration proportionally
 *   4. Offset by the 3-second silence prefix (CHAPTER_SILENCE_SEC)
 */

/** A single sentence with estimated timing. */
export interface TranscriptSentence {
  /** Start time in milliseconds (relative to chapter start). */
  start_ms: number;
  /** End time in milliseconds (relative to chapter start). */
  end_ms: number;
  /** The sentence text. */
  text: string;
}

/** The 3-second silence prefix prepended to every chapter MP3 by the TTS
 *  engine (CHAPTER_SILENCE_SEC in generation_engine.py). The first sentence
 *  starts at 3000ms, not 0ms. */
const CHAPTER_SILENCE_MS = 3000;

/** Minimum sentence duration — prevents tiny sentences from having
 *  impossibly short timestamps. edge-tts adds ~1.2s minimum per sentence
 *  due to punctuation pauses. */
const MIN_SENTENCE_MS = 1200;

// Sentence boundary regex — same as tts_split.py's _SENT_SPLIT_RE.
// Splits on . ! ? … (Latin) + 。 ！ ？ ｡ (CJK), keeping the punctuation.
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+|(?<=[。！？｡])/g;

/**
 * Split text into sentences, preserving the punctuation.
 * Handles both Latin and CJK sentence boundaries.
 */
function splitIntoSentences(text: string): string[] {
  if (!text || !text.trim()) return [];

  // Normalize whitespace (keep newlines as spaces for splitting)
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  // Split on sentence boundaries
  const parts = normalized.split(SENTENCE_SPLIT_RE);

  // Filter out empty/whitespace-only parts and trim
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Estimate per-sentence timestamps for a chapter.
 *
 * @param text The chapter's full text (sanitized to match what was spoken)
 * @param chapterDurationMs The chapter's total audio duration in milliseconds
 *   (from chapter_mp3s[i].duration_ms, measured by ffprobe)
 * @returns Array of { start_ms, end_ms, text } sentences
 */
export function estimateSentenceTimings(
  text: string,
  chapterDurationMs: number,
): TranscriptSentence[] {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0 || chapterDurationMs <= 0) return [];

  // The audio starts with CHAPTER_SILENCE_MS of silence, then the text begins.
  const audioTextMs = Math.max(0, chapterDurationMs - CHAPTER_SILENCE_MS);

  // Compute char counts (use a floor of 1 to avoid division by zero)
  const charCounts = sentences.map((s) => Math.max(1, s.length));
  const totalChars = charCounts.reduce((a, b) => a + b, 0);

  // Distribute the audio duration proportionally by char count
  const result: TranscriptSentence[] = [];
  let runningMs = CHAPTER_SILENCE_MS; // start after the silence prefix

  for (let i = 0; i < sentences.length; i++) {
    const proportion = charCounts[i] / totalChars;
    const durationMs = Math.max(MIN_SENTENCE_MS, proportion * audioTextMs);
    const startMs = runningMs;
    const endMs = startMs + durationMs;

    result.push({
      start_ms: Math.round(startMs),
      end_ms: Math.round(endMs),
      text: sentences[i],
    });

    runningMs = endMs;
  }

  // Ensure the last sentence ends at the chapter duration (self-correcting)
  if (result.length > 0) {
    result[result.length - 1].end_ms = Math.round(chapterDurationMs);
  }

  return result;
}

/**
 * Find the index of the sentence that's currently active at the given time.
 * Uses binary search for O(log n) performance on long chapters.
 *
 * @param sentences Array of sentences with start_ms/end_ms
 * @param currentTimeMs Current playback time in milliseconds (relative to
 *   chapter start)
 * @returns Index of the active sentence, or -1 if none
 */
export function findActiveSentence(
  sentences: TranscriptSentence[],
  currentTimeMs: number,
): number {
  if (sentences.length === 0) return -1;

  // Before the first sentence (during silence prefix)
  if (currentTimeMs < sentences[0].start_ms) return -1;

  // Binary search for the sentence containing currentTimeMs
  let lo = 0;
  let hi = sentences.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = sentences[mid];
    if (currentTimeMs < s.start_ms) {
      hi = mid - 1;
    } else if (currentTimeMs > s.end_ms) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }

  // Fallback: return the last sentence whose start_ms <= currentTimeMs
  // (handles the gap between sentences)
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].start_ms <= currentTimeMs) return i;
  }

  return -1;
}
