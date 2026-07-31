"""Strip the punctuation that reads as "written by a robot".

The em dash is the clearest tell. Readers have learned to spot it, and a post
that trips that reflex costs the business credibility before its first line is
read — which is the opposite of what GODEYE is for.

Asking the model not to use them is not enough on its own. Instructions to avoid
a specific character are among the least reliably followed, because the habit
lives in the model's writing style rather than in anything it reasons about. So
the charter asks, and this cleans up whatever comes through anyway.

Applied to text that reaches an audience: post bodies, A/B variants, meta titles
and descriptions, video scripts. Not to internal fields nobody reads.
"""

from __future__ import annotations

import re

# Em dash, en dash, horizontal bar, figure dash, minus sign. All render as a long
# stroke and all read the same way to someone scanning for the tell.
DASHES = "—–―‒−"

# A dash opening a line is a bullet, not a break in a sentence. Keep the bullet.
_LINE_BULLET = re.compile(rf"^([ \t]*)[{DASHES}][ \t]*", re.MULTILINE)

# Ranges: "9–5", "10–20%", "2024–2026". A comma here would change the meaning.
_NUMERIC_RANGE = re.compile(rf"(?<=\d)\s*[{DASHES}]\s*(?=\d)")

# Everything else: a parenthetical or a break, which a comma covers in the
# conversational register these posts are written in.
_SENTENCE_BREAK = re.compile(rf"\s*[{DASHES}]\s*")

# Artefacts the substitution can leave behind, e.g. "word — , next" -> "word , , next".
_FIXUPS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\s+,"), ","),
    (re.compile(r",\s*,+"), ","),
    (re.compile(r",\s*([.!?;:])"), r"\1"),
    (re.compile(r"([.!?;:])\s*,"), r"\1"),
    (re.compile(r"[ \t]{2,}"), " "),
    (re.compile(r",\s*$", re.MULTILINE), ""),
)


def dedash(text: str) -> str:
    """Replace long dashes with punctuation a person would have typed.

    Order matters: bullets and numeric ranges are recognised before the general
    case, because both would otherwise become commas and read as nonsense
    ("9, 5" for opening hours).
    """
    if not text:
        return text
    out = _LINE_BULLET.sub(r"\1- ", text)
    out = _NUMERIC_RANGE.sub("-", out)
    out = _SENTENCE_BREAK.sub(", ", out)
    for pattern, replacement in _FIXUPS:
        out = pattern.sub(replacement, out)
    return out.strip()


def clean_fields(data: dict, keys: tuple[str, ...]) -> dict:
    """dedash the named string fields of a dict, in place, and return it."""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str):
            data[key] = dedash(value)
    return data
