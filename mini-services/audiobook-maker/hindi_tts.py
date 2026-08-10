"""hindi_tts.py — Hindi TTS synthesis using hi-IN-SwaraNeural.

Synthesizes Hindi text (Devanagari) with the audiobook narration preset:
- rate: -8% (Hindi TTS runs fast, clips consonant clusters)
- pitch: -2Hz
- SSML with <break time="450ms"/> between sentences, <break time="800ms"/> between paragraphs
- Loudness normalization via the existing audio_postprocess.py (-16 LUFS)

Used by /api/chapter/summary, /api/glossary, and /api/explain endpoints.
"""

import asyncio
import os
import tempfile

import edge_tts

from text_preprocess import preprocess_hindi_for_tts, wrap_in_hindi_ssml

HINDI_VOICE = "hi-IN-SwaraNeural"
# Alternate male Hindi voice (not in the active voice list):
# HINDI_VOICE_MALE = "hi-IN-MadhurNeural"


async def _synthesize_hindi(text: str, output_path: str, voice: str = HINDI_VOICE) -> bool:
    """Synthesize Hindi text to an MP3 file using SSML.

    Returns True on success, False on failure.
    """
    if not text or not text.strip():
        return False

    try:
        processed = preprocess_hindi_for_tts(text)
        ssml = wrap_in_hindi_ssml(processed, voice)

        communicate = edge_tts.Communicate(ssml, voice)
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
