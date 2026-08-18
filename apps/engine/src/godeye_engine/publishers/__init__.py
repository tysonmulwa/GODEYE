"""Publisher registry, maps a Platform enum value to its adapter."""

from __future__ import annotations

from .base import BasePublisher, PublishError, PublishResult
from .discord import DiscordPublisher
from .linkedin import LinkedInPublisher
from .meta import FacebookPublisher, InstagramPublisher
from .reddit import RedditPublisher
from .telegram import TelegramPublisher
from .tiktok import TikTokPublisher
from .x import XPublisher

_PUBLISHERS: dict[str, type[BasePublisher]] = {
    "TELEGRAM": TelegramPublisher,
    "DISCORD": DiscordPublisher,
    "REDDIT": RedditPublisher,
    "FACEBOOK": FacebookPublisher,
    "INSTAGRAM": InstagramPublisher,
    "X": XPublisher,
    "LINKEDIN": LinkedInPublisher,
    "TIKTOK": TikTokPublisher,
}


def get_publisher(platform: str) -> BasePublisher:
    cls = _PUBLISHERS.get(platform)
    if cls is None:
        raise PublishError(f"No publisher implemented for platform {platform}")
    return cls()


__all__ = ["get_publisher", "BasePublisher", "PublishError", "PublishResult"]
