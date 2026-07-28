"""TikTok publisher — Content Posting API (direct post).

TikTok only accepts video, and posting is asynchronous: /init returns a
publish_id, we upload the bytes, and TikTok processes them before the post
appears. We poll until it leaves the processing states so a failure surfaces
here rather than silently never appearing on the account.

Uses source=FILE_UPLOAD rather than PULL_FROM_URL: pulling requires the media's
domain to be verified on the developer app, which can't be done when the media
is served from a host we don't own (Supabase, S3). Uploading the bytes sidesteps
verification entirely.
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
    download_media,
)

API = "https://open.tiktokapis.com/v2"

# Time TikTok spends processing the uploaded video before the post appears.
PUBLISH_TIMEOUT_SEC = 180
PUBLISH_POLL_SEC = 5

# TikTok caps the caption; leave room rather than have it truncate mid-hashtag.
CAPTION_LIMIT = 2200

# A single chunk may be up to 64 MB. Larger videos need a multi-chunk upload,
# which isn't implemented — we fail with a clear message instead.
MAX_SINGLE_CHUNK = 64 * 1024 * 1024
UPLOAD_TIMEOUT_SEC = 300


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

        # Fetch the bytes and upload them, rather than handing TikTok a URL.
        # PULL_FROM_URL requires the media's domain to be verified on the
        # developer app, which is impossible when it's served from a host we
        # don't own (Supabase, S3). FILE_UPLOAD has no such requirement.
        fetched = download_media(payload.video_urls[0])
        if fetched is None:
            raise PublishError(
                f"Could not download the video from {payload.video_urls[0]} to send to TikTok."
            )
        video_bytes, content_type = fetched
        size = len(video_bytes)
        if size > MAX_SINGLE_CHUNK:
            raise PublishError(
                f"Video is {size // 1_000_000} MB; TikTok needs multi-chunk upload above "
                f"{MAX_SINGLE_CHUNK // 1_000_000} MB, which isn't supported yet."
            )

        init = self._post(
            f"{API}/post/publish/video/init/",
            headers=headers,
            json={
                "post_info": {
                    "title": payload.text[:CAPTION_LIMIT],
                    "privacy_level": "PUBLIC_TO_EVERYONE",
                },
                # A whole-file upload is one chunk covering the entire video.
                "source_info": {
                    "source": "FILE_UPLOAD",
                    "video_size": size,
                    "chunk_size": size,
                    "total_chunk_count": 1,
                },
            },
        )
        body = init.json()
        if init.status_code >= 400 or (body.get("error") or {}).get("code") not in (None, "ok"):
            raise self._fail(init, "TikTok (init)")

        data = body.get("data") or {}
        publish_id, upload_url = data.get("publish_id"), data.get("upload_url")
        if not publish_id or not upload_url:
            raise PublishError(f"TikTok did not return an upload target: {str(body)[:300]}")

        self._upload(upload_url, video_bytes, content_type)
        self._await_publish(publish_id, headers)
        return PublishResult(external_post_id=publish_id, external_post_url=None)

    def _upload(self, upload_url: str, video_bytes: bytes, content_type: str) -> None:
        """PUT the video to the one-time upload URL from /init."""
        import httpx

        size = len(video_bytes)
        try:
            response = httpx.put(
                upload_url,
                content=video_bytes,
                headers={
                    "Content-Type": content_type or "video/mp4",
                    "Content-Length": str(size),
                    # Whole file in a single range, as TikTok expects.
                    "Content-Range": f"bytes 0-{size - 1}/{size}",
                },
                timeout=UPLOAD_TIMEOUT_SEC,
            )
        except httpx.TransportError as e:
            raise TransientPublishError(f"Network error uploading to TikTok: {e}") from e
        if response.status_code >= 400:
            raise PublishError(
                f"TikTok rejected the upload ({response.status_code}): {response.text[:300]}"
            )

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
                    f"TikTok rejected the video ({reason}). Check the format and length "
                    "meet TikTok's requirements, and that the account can post."
                )
            time.sleep(PUBLISH_POLL_SEC)

        # Still processing — retry rather than discard the post.
        raise TransientPublishError(
            f"TikTok still reports {status} after {PUBLISH_TIMEOUT_SEC}s"
        )
