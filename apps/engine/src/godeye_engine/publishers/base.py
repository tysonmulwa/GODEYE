"""Publisher base class — shared retry/backoff and result shape."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


class PublishError(Exception):
    """Permanent failure — do not retry (bad credentials, invalid content...)."""


class TransientPublishError(Exception):
    """Temporary failure — safe to retry (rate limit, 5xx, network)."""


@dataclass
class PublishResult:
    external_post_id: str
    external_post_url: str | None = None


@dataclass
class PostPayload:
    """What a publisher needs to post: final text + optional media + title."""

    text: str
    title: str | None = None
    media_urls: list[str] | None = None  # images
    video_urls: list[str] | None = None  # videos (adapters that can't post video ignore these)


class BasePublisher(ABC):
    """Adapters implement _publish; publish() wraps it with retry on transients."""

    timeout = 30.0

    @abstractmethod
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult: ...

    @retry(
        retry=retry_if_exception_type(TransientPublishError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        reraise=True,
    )
    def publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        return self._publish(credentials, payload)

    def get_metrics(self, credentials: dict[str, Any], external_post_id: str) -> float | None:
        """Engagement score for a published post; None = platform can't report it."""
        return None

    # ---------- shared HTTP helpers ----------

    def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        try:
            response = httpx.post(url, timeout=self.timeout, **kwargs)
        except httpx.TransportError as e:
            raise TransientPublishError(f"Network error: {e}") from e
        if response.status_code == 429 or response.status_code >= 500:
            raise TransientPublishError(f"HTTP {response.status_code}: {response.text[:300]}")
        return response

    @staticmethod
    def _fail(response: httpx.Response, platform: str) -> PublishError:
        return PublishError(f"{platform} rejected the post ({response.status_code}): {response.text[:300]}")
