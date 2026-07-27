"""TikTok publisher — Content Posting API (direct post).

TikTok only accepts video, and posting is asynchronous: /init hands back a
publish_id and TikTok then downloads the file from the URL we supply
(source=PULL_FROM_URL) before the post appears. We poll until it leaves the
processing states so a failure surfaces here rather than silently never
appearing on the account.

The pulled URL must be https, must not redirect, and its domain must be
verified on the TikTok developer app — otherwise /init is rejected outright.
"""

from __future__ import annotations

import time
from typing import Any

from .base import (
    BasePublisher,
    PostPayload,
    PublishError,
    PublishResult,
    TransientPublishError,
)

API = "https://open.tiktokapis.com/v2"

# TikTok downloads the video itself, so this waits on their fetch, not an upload.
PUBLISH_TIMEOUT_SEC = 180
PUBLISH_POLL_SEC = 5

# TikTok caps the caption; leave room rather than have it truncate mid-hashtag.
CAPTION_LIMIT = 2200


class TikTokPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        if not payload.video_urls:
            raise PublishError(
                "TikTok posts must be video — attach a video to this post "
                "(images and text-only posts aren't supported by the API)"
            )
        token = credentials["accessToken"]
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        }

        init = self._post(
            f"{API}/post/publish/video/init/",
            headers=headers,
            json={
                "post_info": {
                    "title": payload.text[:CAPTION_LIMIT],
                    "privacy_level": "PUBLIC_TO_EVERYONE",
                },
                "source_info": {
                    "source": "PULL_FROM_URL",
                    "video_url": payload.video_urls[0],
                },
            },
        )
        body = init.json()
        if init.status_code >= 400 or (body.get("error") or {}).get("code") not in (None, "ok"):
            raise self._fail(init, "TikTok (init)")

        publish_id = (body.get("data") or {}).get("publish_id")
        if not publish_id:
            raise PublishError(f"TikTok did not return a publish_id: {str(body)[:300]}")

        self._await_publish(publish_id, headers)
        return PublishResult(external_post_id=publish_id, external_post_url=None)

    def _await_publish(self, publish_id: str, headers: dict[str, str]) -> None:
        """Block until TikTok has fetched and processed the video."""
        import httpx

        deadline = time.monotonic() + PUBLISH_TIMEOUT_SEC
        status = "PROCESSING_UPLOAD"
        while time.monotonic() < deadline:
            try:
                response = httpx.post(
                    f"{API}/post/publish/status/fetch/",
                    headers=headers,
                    json={"publish_id": publish_id},
                    timeout=self.timeout,
                )
            except httpx.TransportError as e:
                raise TransientPublishError(f"Network error polling TikTok: {e}") from e

            data = (response.json().get("data") or {})
            status = data.get("status") or status
            if status in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX"):
                return
            if status == "FAILED":
                reason = data.get("fail_reason") or "no reason given"
                raise PublishError(
                    f"TikTok rejected the video ({reason}). Check the URL is public https "
                    "with no redirect, and that its domain is verified on your TikTok app."
                )
            time.sleep(PUBLISH_POLL_SEC)

        # Still downloading — retry rather than discard the post.
        raise TransientPublishError(
            f"TikTok still reports {status} after {PUBLISH_TIMEOUT_SEC}s"
        )
