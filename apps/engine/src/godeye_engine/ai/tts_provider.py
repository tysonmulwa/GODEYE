"""Text-to-speech. OpenAI TTS (voiceovers for generated videos)."""

from __future__ import annotations

from dataclasses import dataclass

from ..config import get_settings

# USD per 1M characters.
TTS_PRICES: dict[str, float] = {
    "tts-1": 15.0,
    "tts-1-hd": 30.0,
    "gpt-4o-mini-tts": 12.0,
}
DEFAULT_TTS_PRICE = 15.0

VALID_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}


@dataclass
class TtsResult:
    data: bytes  # mp3
    model: str
    characters: int

    @property
    def cost_usd(self) -> float:
        price = TTS_PRICES.get(self.model, DEFAULT_TTS_PRICE)
        return self.characters * price / 1_000_000


def synthesize(text: str, voice: str = "nova") -> TtsResult:
    """Render narration to MP3. Raises RuntimeError when TTS is unconfigured."""
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError(
            "Voiceover needs OPENAI_API_KEY in .env (OpenAI TTS renders the narration)"
        )
    if voice not in VALID_VOICES:
        voice = "nova"

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key)
    response = client.audio.speech.create(
        model=settings.openai_tts_model,
        voice=voice,
        input=text,
        response_format="mp3",
    )
    return TtsResult(
        data=response.content,
        model=settings.openai_tts_model,
        characters=len(text),
    )
