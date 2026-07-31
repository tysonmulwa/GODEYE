"""Image Agent — turns a business profile + brief into a strong image prompt.

Uses the text LLM to expand a short brief into a detailed, on-brand image
generation prompt, then hands that to the image provider.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import mission, provider

PROMPT_SYSTEM = mission.charter("image") + "\n\n" + (
    "Return ONLY the image prompt text, with no preamble, no quotes. Describe subject, "
    "setting, lighting, composition, and style. Never include text, words, logos, "
    "or watermarks in the image (branding is added separately). Under 80 words."
)


@dataclass
class ImagePromptRequest:
    brief: str
    style: str | None = None


def build_image_prompt(profile: dict[str, Any], request: ImagePromptRequest) -> str:
    """Expand a short brief into a detailed image prompt via the text LLM."""
    context = [
        f"Business: {profile.get('businessName')} ({profile.get('industry')}).",
        f"What they do: {profile.get('description')}",
    ]
    if profile.get("brandVoice"):
        context.append(f"Brand feel: {profile['brandVoice']}")
    style = request.style or "clean, professional, photorealistic"
    user = (
        "\n".join(context)
        + f"\n\nImage brief: {request.brief}\nVisual style: {style}\n\n"
        "Write the image generation prompt now."
    )
    result = provider.complete(PROMPT_SYSTEM, user, max_tokens=300)
    return result.text.strip().strip('"')


def fallback_prompt(profile: dict[str, Any], request: ImagePromptRequest) -> str:
    """Deterministic prompt when no text LLM is available."""
    style = request.style or "clean, professional, photorealistic"
    industry = profile.get("industry", "business")
    return (
        f"{request.brief}. {style} image for a {industry} brand, "
        "high quality, no text or logos, balanced composition, natural lighting."
    )
