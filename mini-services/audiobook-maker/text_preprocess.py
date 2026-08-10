"""Text preprocessing for audiobook TTS — normalizes text before SSML wrapping.

Expands abbreviations, converts years to spoken form, and cleans up whitespace.
Does NOT escape words that are part of the transcript cue system — the cues
are built from the SAME preprocessed text, so they stay aligned.
"""

import re

# Abbreviation expansions (case-insensitive, word-boundary matched)
_ABBREVIATIONS = {
    r"\bDr\.\s": "Doctor ",
    r"\bMr\.\s": "Mister ",
    r"\bMrs\.\s": "Misses ",
    r"\bMs\.\s": "Miss ",
    r"\bSt\.\s": "Saint ",
    r"\bU\.S\.\s": "United States ",
    r"\bU\.K\.\s": "United Kingdom ",
    r"\bU\.S\.A\.\s": "United States of America ",
    r"\betc\.\s": "etcetera ",
    r"\bvs\.\s": "versus ",
    r"\be\.g\.\s": "for example ",
    r"\bi\.e\.\s": "that is ",
    r"\bMr\s": "Mister ",
    r"\bMrs\s": "Misses ",
    r"\bDr\s": "Doctor ",
}


def _expand_abbreviations(text: str) -> str:
    for pattern, replacement in _ABBREVIATIONS.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text


def _years_to_spoken(text: str) -> str:
    """Convert standalone 4-digit years (1000-2099) to spoken form.

    1821 → eighteen twenty-one
    1900 → nineteen hundred
    2005 → two thousand five
    """
    def _year_replacer(m):
        year = int(m.group(0))
        if year < 1100 or year > 2099:
            return m.group(0)

        if year < 2000:
            century = year // 100
            rest = year % 100
            centuries = {
                11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
                15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
                19: "nineteen",
            }
            tens = {
                0: "", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
                6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
                11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
                15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
                19: "nineteen", 20: "twenty", 21: "twenty-one", 22: "twenty-two",
                23: "twenty-three", 24: "twenty-four", 25: "twenty-five",
                26: "twenty-six", 27: "twenty-seven", 28: "twenty-eight",
                29: "twenty-nine", 30: "thirty", 31: "thirty-one",
                32: "thirty-two", 33: "thirty-three", 34: "thirty-four",
                35: "thirty-five", 36: "thirty-six", 37: "thirty-seven",
                38: "thirty-eight", 39: "thirty-nine", 40: "forty",
                41: "forty-one", 42: "forty-two", 43: "forty-three",
                44: "forty-four", 45: "forty-five", 46: "forty-six",
                47: "forty-seven", 48: "forty-eight", 49: "forty-nine",
                50: "fifty", 51: "fifty-one", 52: "fifty-two",
                53: "fifty-three", 54: "fifty-four", 55: "fifty-five",
                56: "fifty-six", 57: "fifty-seven", 58: "fifty-eight",
                59: "fifty-nine", 60: "sixty", 61: "sixty-one",
                62: "sixty-two", 63: "sixty-three", 64: "sixty-four",
                65: "sixty-five", 66: "sixty-six", 67: "sixty-seven",
                68: "sixty-eight", 69: "sixty-nine", 70: "seventy",
                71: "seventy-one", 72: "seventy-two", 73: "seventy-three",
                74: "seventy-four", 75: "seventy-five", 76: "seventy-six",
                77: "seventy-seven", 78: "seventy-eight", 79: "seventy-nine",
                80: "eighty", 81: "eighty-one", 82: "eighty-two",
                83: "eighty-three", 84: "eighty-four", 85: "eighty-five",
                86: "eighty-six", 87: "eighty-seven", 88: "eighty-eight",
                89: "eighty-nine", 90: "ninety", 91: "ninety-one",
                92: "ninety-two", 93: "ninety-three", 94: "ninety-four",
                95: "ninety-five", 96: "ninety-six", 97: "ninety-seven",
                98: "ninety-eight", 99: "ninety-nine",
            }
            cent_str = centuries.get(century, str(century))
            if rest == 0:
                return f"{cent_str} hundred"
            return f"{cent_str} {tens.get(rest, str(rest))}"
        else:
            # 2000-2099
            rest = year % 100
            _ones = ["", "one", "two", "three", "four", "five", "six", "seven",
                     "eight", "nine"]
            if rest == 0:
                return "two thousand"
            if rest < 10:
                return f"two thousand {_ones[rest]}"
            return f"two thousand {tens.get(rest, str(rest))}"

    # Match standalone 4-digit years (not part of longer numbers)
    return re.sub(r'(?<!\d)(1[1-9]\d{2}|20\d{2})(?!\d)', _year_replacer, text)


def preprocess_for_tts(text: str) -> str:
    """Normalize text before SSML wrapping.

    1. Expand abbreviations (Dr. → Doctor, Mr. → Mister, etc.)
    2. Convert 4-digit years to spoken form (1821 → eighteen twenty-one)
    3. Clean up double spaces and line breaks

    Does NOT escape words — the transcript cue system uses the same
    preprocessed text, so cues stay aligned with the audio.
    """
    if not text:
        return text

    # 1. Expand abbreviations
    text = _expand_abbreviations(text)

    # 2. Convert years to spoken form
    text = _years_to_spoken(text)

    # 3. Clean up whitespace
    # Replace multiple spaces with single space
    text = re.sub(r'[ \t]+', ' ', text)
    # Replace 3+ newlines with double newline (paragraph break)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Strip leading/trailing whitespace
    text = text.strip()

    return text


# ── Devanagari detection ──
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")

def is_hindi_text(text: str) -> bool:
    """True if text contains Devanagari characters (Hindi/Marathi/etc)."""
    return bool(_DEVANAGARI_RE.search(text or ""))


def preprocess_hindi_for_tts(text: str) -> str:
    """Devanagari-safe text prep for Hindi TTS.

    Does NOT run the English abbreviation expander (mangles Devanagari).
    Strips markdown, leaves numerals as-is (Edge TTS reads
    Devanagari/Arabic numerals correctly in hi-IN).
    Does NOT escape &<> (we pass plain text to edge_tts, not SSML).
    """
    if not text:
        return text
    # Strip markdown: **bold**, *italic*, # headings, [text](url), `code`
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'^#+\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Strip bullet points
    text = re.sub(r'^[\s]*[-•·]\s+', '', text, flags=re.MULTILINE)
    # Clean up whitespace
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def plain_text_for_tts(text: str) -> str:
    """Final safety pass: never let markup or URLs reach the TTS engine.

    Run AFTER preprocess_hindi_for_tts(). Reverses XML entity escaping
    (which is no longer needed since we pass plain text, not SSML),
    strips residual tags, URLs, and ensures sentence-ending punctuation
    for natural Edge TTS pauses.
    """
    if not text:
        return ""
    # Un-escape XML entities (preprocess_hindi_for_tts used to escape these
    # for SSML — we no longer emit SSML, so reverse it)
    text = (text.replace("&amp;", " और ")
                .replace("&lt;", " ")
                .replace("&gt;", " "))
    # Strip any residual tags (SSML, HTML)
    text = re.sub(r"<[^>]+>", " ", text)
    # Strip URLs and bare domains — the voice should never read these
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"www\.\S+", " ", text)
    text = re.sub(r"\b\S+\.(com|org|net|in|io)\b", " ", text)
    # Drop stray XML-ish leftovers
    text = re.sub(r"[<>{}]", " ", text)
    # Ensure sentence-ending punctuation for natural pauses:
    # Convert paragraph breaks (double newlines) into danda + space
    text = re.sub(r"\n{2,}", " । ", text)
    # Convert remaining single newlines to spaces (inline)
    text = re.sub(r"\n", " ", text)
    # If the text doesn't end with sentence punctuation, add a danda
    text = text.rstrip()
    if text and text[-1] not in ".!?।":
        text += " ।"
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def wrap_in_hindi_ssml(text: str, voice_name: str) -> str:
    """DEPRECATED — DO NOT pass to edge_tts.Communicate.

    edge-tts treats the first argument as plain text, NOT SSML. Passing
    this string to Communicate causes the voice to read XML tags aloud
    ("break time 450 ms", "prosody rate minus 8 percent", etc).

    This function is kept for reference only. Use plain_text_for_tts()
    + Communicate(text=..., rate="-8%", pitch="-2Hz") instead.
    """
    # Split into sentences and paragraphs, insert breaks
    # Sentence boundaries: . ! ? । (Devanagari danda)  followed by whitespace
    sentences = re.split(r'(?<=[.!?।])\s+', text)
    parts = []
    for i, sent in enumerate(sentences):
        parts.append(sent)
        # Check if this sentence ends a paragraph (next sentence starts a new line)
        # or if it's the last sentence
        if i < len(sentences) - 1:
            # If the sentence ends with a double-newline or the next starts on a new line,
            # use a paragraph break; otherwise sentence break.
            if '\n' in sent[-5:]:
                parts.append('<break time="800ms"/>')
            else:
                parts.append('<break time="450ms"/>')
        else:
            parts.append('<break time="400ms"/>')

    body = ' '.join(parts)

    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xmlns:mstts="https://www.w3.org/2001/mstts">'
        f'<voice name="{voice_name}">'
        '<mstts:express-as style="narration" styledegree="1.2">'
        '<prosody rate="-8%" pitch="-2Hz">'
        '<break time="300ms"/>'
        f'{body}'
        '</prosody>'
        '</mstts:express-as>'
        '</voice>'
        '</speak>'
    )


def wrap_in_ssml(text: str, voice_name: str) -> str:
    """Wrap text in an audiobook-style SSML template.

    The template uses:
    - <mstts:express-as style="narration" styledegree="1.2"> for audiobook pacing
    - <prosody rate="-10%" pitch="-2%"> for slower, warmer delivery
    - <break time="300ms"/> before the text (opening pause)
    - <break time="400ms"/> after the text (closing pause)
    """
    # Escape XML special characters in the text (but NOT the SSML tags)
    escaped = text
    escaped = escaped.replace("&", "&amp;")
    escaped = escaped.replace("<", "&lt;")
    escaped = escaped.replace(">", "&gt;")
    # Don't escape quotes — edge-tts handles them fine in SSML

    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xmlns:mstts="https://www.w3.org/2001/mstts">'
        f'<voice name="{voice_name}">'
        '<mstts:express-as style="narration" styledegree="1.2">'
        '<prosody rate="-10%" pitch="-2%">'
        '<break time="300ms"/>'
        f'{escaped}'
        '<break time="400ms"/>'
        '</prosody>'
        '</mstts:express-as>'
        '</voice>'
        '</speak>'
    )
