"""Publisher base class, shared retry/backoff and result shape."""

from __future__ import annotations

import logging
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

from ..security import EgressBlocked, safe_fetch

logger = logging.getLogger(__name__)


def download_media(url: str) -> tuple[bytes, str] | None:
    """Fetch media bytes + content-type so a publisher can upload them directly.

    Platforms fetch a passed-in media URL from their own servers, which fails for
    media hosted somewhere they can't reach (e.g. local dev storage on localhost).
    Uploading the bytes avoids that. Returns None if the fetch fails so callers can
    fall back to passing the URL.
    """
    try:
        # S-20: this is a third SSRF sink the audit missed. It is called from
        # five publishers with a URL that reaches it from stored media records,
        # and it followed redirects with no validation at all. 25 MB because a
        # video is legitimately large; the platform caps are stricter.
        response = safe_fetch(url, max_bytes=25 * 1024 * 1024, total_timeout=30)
    except EgressBlocked as e:
        logger.warning("Media fetch refused for %s: %s", url, e.reason)
        return None
    except httpx.HTTPError as e:
        # None is the caller's signal to fall back, but on its own it says
        # nothing about why, which left a failed fetch indistinguishable from
        # media that was never there.
        logger.warning("Media fetch failed for %s: %s: %s", url, type(e).__name__, e)
        return None
    if response.status_code != 200:
        logger.warning("Media fetch for %s returned HTTP %d", url, response.status_code)
        return None
    return response.content, response.headers.get("content-type", "application/octet-stream")


def slideshow_from_payload(
    payload: PostPayload, platform: str, limit: int = 10
) -> bytes | None:
    """Render a photo post into a video carrying the workspace's track.

    None of these APIs can add music to a post after the fact, and each
    network's own catalogue is reachable only from inside its app, so a photo
    post published by an automation is silent unless the audio is already in
    the file. Rendering it here is what makes an unattended post arrive with
    sound.

    Returns None when it cannot be done, so the caller falls back to whatever
    still-image post it would otherwise have made rather than dropping the
    post. Every one of those paths says why: a post that goes out silent is
    otherwise indistinguishable from one that was never meant to have sound.
    """
    from ..media import slideshow

    urls = payload.media_urls or []
    if not payload.music_url:
        logger.info(
            "%s: no brand track set, posting %d photo(s) without sound", platform, len(urls)
        )
        return None
    try:
        images = []
        for url in urls[:limit]:
            fetched = download_media(url)
            if fetched is None:
                logger.warning(
                    "%s: could not fetch image %s, posting photos without sound", platform, url
                )
                return None
            images.append(fetched[0])
        music = download_media(payload.music_url)
        if music is None:
            logger.warning(
                "%s: could not fetch the brand track %s, posting photos without sound",
                platform, payload.music_url,
            )
            return None
        if not images:
            logger.warning("%s: no images to build a slideshow from", platform)
            return None
        length = slideshow.normalise_length(payload.slideshow_seconds)
        logger.info(
            "%s: building a %ds slideshow from %d image(s) and %.1f MB of audio",
            platform, length, len(images), len(music[0]) / 1_048_576,
        )
        return slideshow.build_slideshow(images, music[0], target_sec=length)
    except Exception as e:  # noqa: BLE001, a silent post beats no post
        logger.warning(
            "%s slideshow build failed, posting photos instead: %s: %s",
            platform, type(e).__name__, e,
        )
        return None


def store_rendered_reel(video_bytes: bytes, org_id: str | None, platform: str) -> str | None:
    """Put a rendered Reel somewhere the network can fetch it.

    Only Instagram needs this. Facebook and TikTok both accept the bytes,
    and it is why a render alone is not enough there.

    Returns None rather than raising, so a storage problem costs the sound
    rather than the post.
    """
    from ..db import new_id
    from ..storage import upload_bytes

    try:
        key = f"{org_id or 'shared'}/reels/{new_id()}.mp4"
        return upload_bytes(key, video_bytes, "video/mp4")
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "%s: rendered the Reel but could not store it for fetching (%s: %s), "
            "falling back to a still post",
            platform, type(e).__name__, e,
        )
        return None


class PublishError(Exception):
    """Permanent failure, do not retry (bad credentials, invalid content...)."""


class TransientPublishError(Exception):
    """Temporary failure, safe to retry (rate limit, 5xx, network)."""


@dataclass
class PublishResult:
    external_post_id: str
    external_post_url: str | None = None


@dataclass(frozen=True)
class TikTokPostSettings:
    """What the creator chose, in our UI, before this post was scheduled.

    TikTok's Content Sharing Guidelines, "Required UX Implementation in Your
    App", points 2 to 4. All three are requirements about *who decides*:

      2. Privacy level. Selected by the creator from the options their own
         account offers, with nothing pre-selected -- so there is no default
         here and `privacy_level` is not optional.
      3. Interaction settings. Comment, duet and stitch, each of which the
         creator's account may forbid outright.
      4. Content disclosure. Whether the post promotes the creator's own brand,
         a third party's, or neither.

    GODEYE previously chose the privacy level itself, server-side, at publish
    time -- reading creator_info and taking the most public option available.
    That is the thing the guidelines forbid, and it is why the app was rejected.
    """

    privacy_level: str
    disable_comment: bool = False
    disable_duet: bool = False
    disable_stitch: bool = False
    #: "Your brand" -- the creator promoting their own business.
    brand_organic: bool = False
    #: "Branded content" -- a paid partnership with a third party.
    branded_content: bool = False

    @classmethod
    def from_json(cls, raw: object) -> "TikTokPostSettings | None":
        """Build from the JSON column, or None if the post predates the feature."""
        if not isinstance(raw, dict) or not raw.get("privacyLevel"):
            return None
        return cls(
            privacy_level=str(raw["privacyLevel"]),
            disable_comment=bool(raw.get("disableComment")),
            disable_duet=bool(raw.get("disableDuet")),
            disable_stitch=bool(raw.get("disableStitch")),
            brand_organic=bool(raw.get("brandOrganic")),
            branded_content=bool(raw.get("brandedContent")),
        )

    def post_info(self, title: str) -> dict[str, object]:
        """The `post_info` block TikTok's publish endpoints take."""
        return {
            "title": title,
            "privacy_level": self.privacy_level,
            "disable_comment": self.disable_comment,
            "disable_duet": self.disable_duet,
            "disable_stitch": self.disable_stitch,
            "brand_content_toggle": self.branded_content,
            "brand_organic_toggle": self.brand_organic,
        }



@dataclass
class PostPayload:
    """What a publisher needs to post: final text + optional media + title."""

    text: str
    title: str | None = None
    media_urls: list[str] | None = None  # images
    video_urls: list[str] | None = None  # videos (adapters that can't post video ignore these)
    # The workspace's licensed background track, when it has one. Photos are
    # rendered into a slideshow carrying it, rather than published as a silent
    # still post, none of these APIs offer a way to add music afterwards, and
    # each network's own catalogue is reachable only from inside its app.
    music_url: str | None = None
    # Owning workspace. Instagram will not accept an upload, it fetches the
    # video from a URL, so a rendered Reel has to be stored somewhere public
    # first, under this workspace's prefix.
    org_id: str | None = None
    # How long that slideshow runs, chosen when the post was written.
    slideshow_seconds: int | None = None
    # Whether photos are rendered to video at all. TikTok ignores it: its API
    # takes no still post that can carry audio, so there is nothing to choose.
    # Everywhere else a carousel is a real format, and this is the choice
    # between it and a Reel. Always subject to a track existing, a silent
    # Reel is worse than the carousel it would replace.
    render_as_video: bool = True
    # The creator's own publishing choices for TikTok, made in the composer
    # before the post was scheduled.
    #
    # TikTok's Content Sharing Guidelines require these to be the CREATOR's
    # decisions, taken in our UI, not ours taken on their behalf. Every one is
    # therefore carried from the post rather than inferred here, and a post
    # written before this existed carries None -- which the publisher treats as
    # "no consent recorded" and refuses to publish directly, rather than
    # guessing a visibility for somebody.
    tiktok: "TikTokPostSettings | None" = None


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
            # lint-rules:allow — `url` is built from platform constants by each
            # subclass (GRAPH, TIKTOK_API, discord.com). No part of it comes
            # from a customer, so there is nothing for the egress guard to decide.
            response = httpx.post(url, timeout=self.timeout, **kwargs)
        except httpx.TransportError as e:
            raise TransientPublishError(f"Network error: {e}") from e
        if response.status_code == 429 or response.status_code >= 500:
            raise TransientPublishError(f"HTTP {response.status_code}: {response.text[:300]}")
        return response

    @staticmethod
    def _fail(response: httpx.Response, platform: str) -> PublishError:
        return PublishError(f"{platform} rejected the post ({response.status_code}): {response.text[:300]}")
