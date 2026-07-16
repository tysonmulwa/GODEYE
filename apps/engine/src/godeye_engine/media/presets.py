"""Image size presets — mirror of packages/shared/src/image-presets.ts."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    width: int
    height: int
    aspect: str


PRESETS: dict[str, Preset] = {
    "SQUARE": Preset("SQUARE", "Square (feed)", 1080, 1080, "1:1"),
    "INSTAGRAM_FEED": Preset("INSTAGRAM_FEED", "Instagram feed", 1080, 1080, "1:1"),
    "INSTAGRAM_PORTRAIT": Preset("INSTAGRAM_PORTRAIT", "Instagram portrait", 1080, 1350, "4:5"),
    "STORY": Preset("STORY", "Story / Reel", 1080, 1920, "9:16"),
    "FACEBOOK_FEED": Preset("FACEBOOK_FEED", "Facebook feed", 1200, 630, "1.91:1"),
    "LINKEDIN_FEED": Preset("LINKEDIN_FEED", "LinkedIn feed", 1200, 627, "1.91:1"),
    "X_FEED": Preset("X_FEED", "X post", 1600, 900, "16:9"),
    "PINTEREST_PIN": Preset("PINTEREST_PIN", "Pinterest pin", 1000, 1500, "2:3"),
    "BLOG_BANNER": Preset("BLOG_BANNER", "Blog / hero banner", 1600, 900, "16:9"),
}

PLATFORM_DEFAULT_PRESET: dict[str, str] = {
    "INSTAGRAM": "INSTAGRAM_FEED",
    "FACEBOOK": "FACEBOOK_FEED",
    "LINKEDIN": "LINKEDIN_FEED",
    "X": "X_FEED",
    "PINTEREST": "PINTEREST_PIN",
    "TELEGRAM": "SQUARE",
    "DISCORD": "SQUARE",
}


def get_preset(preset_id: str) -> Preset:
    return PRESETS.get(preset_id, PRESETS["SQUARE"])


def closest_provider_size(width: int, height: int) -> str:
    """Map an arbitrary target to the nearest size the image API supports.

    gpt-image-1 supports 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape).
    We generate at the closest aspect then resize/crop to the exact preset.
    """
    ratio = width / height
    if ratio > 1.2:
        return "1536x1024"
    if ratio < 0.83:
        return "1024x1536"
    return "1024x1024"
