"""SRT subtitle generation from scene narrations + measured audio durations."""

from __future__ import annotations

MAX_CHARS_PER_CUE = 42  # readable on a phone screen


def format_timestamp(seconds: float) -> str:
    """SRT timestamp: HH:MM:SS,mmm"""
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def split_narration(text: str, max_chars: int = MAX_CHARS_PER_CUE) -> list[str]:
    """Split narration into short cues on word boundaries."""
    words = text.split()
    cues: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > max_chars and current:
            cues.append(current)
            current = word
        else:
            current = candidate
    if current:
        cues.append(current)
    return cues


def build_srt(scenes: list[tuple[str, float]]) -> str:
    """Build an SRT file from (narration, duration_seconds) pairs.

    Each scene's narration is split into readable cues, spread proportionally
    across that scene's audio duration.
    """
    entries: list[str] = []
    index = 1
    clock = 0.0
    for narration, duration in scenes:
        cues = split_narration(narration)
        if not cues or duration <= 0:
            clock += max(duration, 0)
            continue
        total_chars = sum(len(c) for c in cues)
        cue_start = clock
        for cue in cues:
            share = len(cue) / total_chars if total_chars else 1 / len(cues)
            cue_end = min(cue_start + duration * share, clock + duration)
            entries.append(
                f"{index}\n{format_timestamp(cue_start)} --> {format_timestamp(cue_end)}\n{cue}\n"
            )
            index += 1
            cue_start = cue_end
        clock += duration
    return "\n".join(entries) + ("\n" if entries else "")
