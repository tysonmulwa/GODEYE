"""TikTok publisher — Content Posting API (direct post).

TikTok takes video or a photo carousel, and posting is asynchronous: /init returns a
publish_id, we upload the bytes, and TikTok processes them before the post
appears. We poll until it leaves the processing states so a failure surfaces
here rather than silently never appearing on the account.

Video uses source=FILE_UPLOAD, which needs no domain verification. Photos have
no upload option — TikTok will only pull them from a URL — so a photo post
requires the media host to be a verified domain or URL prefix on the app.
"""

from __future__ import annotations

import time
from typing import Any

from ..config import get_settings
from .base import (
    BasePublisher,
    PostPayload,
    PublishError,
    PublishResult,
    TransientPublishError,
    download_media,
)

API = "https://open.tiktokapis.com/v2"

# "Only me". The single privacy level an unaudited app is permitted to publish.
SELF_ONLY = "SELF_ONLY"

# TikTok's wording blames the account, which is not where the problem is.
UNAUDITED_CODE = "unaudited_client_can_only_post_to_private_accounts"
UNAUDITED_HELP = (
    "TikTok refused because this app has not passed its Content Posting audit. "
    "Despite the wording, your account's privacy setting is not the cause: an "
    "unaudited app may only publish at SELF_ONLY, and the request asked for "
    "something more visible. GODEYE now sends SELF_ONLY until you set "
    "TIKTOK_AUDITED=true on the worker, which you should do once TikTok "
    "approves the app. Until then posts land on your account visible to you "
    "alone."
)

# Time TikTok spends processing the uploaded video before the post appears.
PUBLISH_TIMEOUT_SEC = 180
PUBLISH_POLL_SEC = 5

# TikTok caps the caption; leave room rather than have it truncate mid-hashtag.
CAPTION_LIMIT = 2200

# TikTok shows a short title above a photo carousel, separate from the caption.
TITLE_LIMIT = 90
# TikTok allows up to 35 images per photo post; GODEYE caps a post at 4.
PHOTO_LIMIT = 35

# A single chunk may be up to 64 MB. Larger videos need a multi-chunk upload,
# which isn't implemented — we fail with a clear message instead.
MAX_SINGLE_CHUNK = 64 * 1024 * 1024
UPLOAD_TIMEOUT_SEC = 300


class TikTokPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        if not payload.video_urls and not payload.media_urls:
            raise PublishError(
                "TikTok needs media — attach a video or photos to this post "
                "(text-only posts aren't supported by the API)"
            )
        token = credentials["accessToken"]
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        }

        if not payload.video_urls:
            return self._publish_photos(headers, payload)

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
                    "privacy_level": self._privacy_level(headers),
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
            raise self._fail_tiktok(init, "TikTok (init)")

        data = body.get("data") or {}
        publish_id, upload_url = data.get("publish_id"), data.get("upload_url")
        if not publish_id or not upload_url:
            raise PublishError(f"TikTok did not return an upload target: {str(body)[:300]}")

        self._upload(upload_url, video_bytes, content_type)
        self._await_publish(publish_id, headers)
        return PublishResult(external_post_id=publish_id, external_post_url=None)

    def _publish_photos(self, headers: dict[str, str], payload: PostPayload) -> PublishResult:
        """Post images as a TikTok photo carousel.

        Photos go through a different endpoint to video, and unlike video they
        have no upload option — TikTok will only pull them from a URL, and that
        URL must sit under a domain or prefix verified on the developer app. So
        the media host itself has to be verified; bytes can't be sent instead.
        """
        init = self._post(
            f"{API}/post/publish/content/init/",
            headers=headers,
            json={
                "post_info": {
                    "title": (payload.title or payload.text)[:TITLE_LIMIT],
                    "description": payload.text[:CAPTION_LIMIT],
                    "privacy_level": self._privacy_level(headers),
                },
                "source_info": {
                    "source": "PULL_FROM_URL",
                    "photo_cover_index": 0,
                    "photo_images": payload.media_urls[:PHOTO_LIMIT],
                },
                "post_mode": "DIRECT_POST",
                "media_type": "PHOTO",
            },
        )
        body = init.json()
        if init.status_code >= 400 or (body.get("error") or {}).get("code") not in (None, "ok"):
            raise self._fail_tiktok(init, "TikTok (photo init)")

        publish_id = (body.get("data") or {}).get("publish_id")
        if not publish_id:
            raise PublishError(f"TikTok did not return a publish_id: {str(body)[:300]}")

        self._await_publish(publish_id, headers)
        return PublishResult(external_post_id=publish_id, external_post_url=None)

    def _fail_tiktok(self, response, stage: str) -> PublishError:
        """TikTok's own message for the audit error points at the wrong thing.

        Left as-is it sends people to change their account's privacy setting,
        which cannot fix it, because the account was never what was refused.
        """
        error = self._fail(response, stage)
        try:
            code = (response.json().get("error") or {}).get("code")
        except ValueError:
            return error
        if code == UNAUDITED_CODE:
            return PublishError(f"{stage}: {UNAUDITED_HELP}")
        return error

    def _privacy_level(self, headers: dict[str, str]) -> str:
        """The visibility to request for this post.

        This used to ask creator_info for the account's options and take the
        most public one, which is wrong and rejected every post. creator_info
        reports what the *creator's account* permits; it says nothing about what
        an *unaudited app* may publish, and those are different limits. An app
        that has not passed TikTok's Content Posting audit may only ever send
        SELF_ONLY, whatever the account allows.

        The error for getting this wrong reads
        "unaudited_client_can_only_post_to_private_accounts", which sounds like
        the account is at fault and sends people off making it private. It is
        not: the account is irrelevant, the privacy_level in the request is the
        whole of it.
        """
        if not get_settings().tiktok_audited:
            return SELF_ONLY

        import httpx

        try:
            response = httpx.post(
                f"{API}/post/publish/creator_info/query/",
                headers=headers,
                timeout=self.timeout,
            )
            options = ((response.json().get("data") or {}).get("privacy_level_options")) or []
        except (httpx.HTTPError, ValueError):
            options = []

        for preferred in ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"):
            if preferred in options:
                return preferred
        # SELF_ONLY is always permitted, so it stays the safe fallback when the
        # query fails or the account itself offers nothing more public.
        return SELF_ONLY

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
