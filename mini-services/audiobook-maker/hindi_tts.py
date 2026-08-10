"""hindi_tts.py — Hindi TTS synthesis using hi-IN-SwaraNeural.

Synthesizes Hindi text (Devanagari) with the audiobook narration preset:
- rate: -8% (Hindi TTS runs fast, clips consonant clusters)
- pitch: -2Hz
- Pauses come from punctuation (। . ! ?), NOT SSML <break> tags.
  edge-tts treats its first argument as PLAIN TEXT, not SSML. Passing
  SSML causes the voice to read XML tags aloud.
- Loudness normalization via the existing audio_postprocess.py (-16 LUFS)

Used by /api/chapter/summary, /api/glossary, and /api/explain endpoints.
"""

import asyncio
import os

import edge_tts

from text_preprocess import preprocess_hindi_for_tts, plain_text_for_tts

HINDI_VOICE = "hi-IN-SwaraNeural"
# Alternate male Hindi voice (not in the active voice list):
# HINDI_VOICE_MALE = "hi-IN-MadhurNeural"


async def _synthesize_hindi(text: str, output_path: str, voice: str = HINDI_VOICE) -> bool:
    """Synthesize Hindi text to an MP3 file using plain text + prosody kwargs.

    NEVER passes SSML to edge_tts.Communicate — that causes the voice to
    read XML tags aloud. Instead, uses native rate=/pitch= kwargs and
    relies on punctuation (।) for natural pauses.

    Returns True on success, False on failure.
    """
    if not text or not text.strip():
        return False

    try:
        # Step 1: strip markdown, clean whitespace (no XML escaping)
        processed = preprocess_hindi_for_tts(text)
        # Step 2: final safety — strip any residual markup/URLs, ensure
        # sentence-ending punctuation for natural Edge TTS pauses
        processed = plain_text_for_tts(processed)

        if not processed.strip():
            return False

        # Pass plain text + native prosody kwargs (NOT SSML)
        communicate = edge_tts.Communicate(
            processed,
            voice,
            rate="-8%",
            pitch="-2Hz",
        )
        await asyncio.wait_for(
            communicate.save(output_path),
            timeout=60
        )

        if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
            return False

        # Apply the same loudness normalization as English voices
        from audio_postprocess import post_process_audio
        post_process_audio(output_path)

        return True
    except Exception as e:
        print(f"[hindi-tts] synthesis failed: {e}")
        return False


def synthesize_hindi(text: str, output_path: str, voice: str = HINDI_VOICE) -> bool:
    """Synchronous wrapper for _synthesize_hindi."""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(_synthesize_hindi(text, output_path, voice))
        finally:
            loop.close()
    except Exception as e:
        print(f"[hindi-tts] sync wrapper failed: {e}")
        return False
