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

import logging
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

logger = logging.getLogger(__name__)

API = "https://open.tiktokapis.com/v2"

# "Only me". The single privacy level an unaudited app is permitted to publish.
SELF_ONLY = "SELF_ONLY"

# TikTok's photo endpoint takes JPEG. It accepts the request, fetches the files,
# then fails the post minutes later with file_format_check_failed, so these are
# worth catching before the call.
UNSUPPORTED_PHOTO_EXT = (".png", ".gif", ".bmp", ".tiff", ".svg", ".heic")

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
            # Photos become a slideshow with the workspace's track when it has
            # one, because a photo post published through the API has no sound
            # and no way to gain any. Posting it as video also drops the domain
            # verification that PULL_FROM_URL demands.
            slideshow_bytes = self._slideshow_from_photos(payload)
            if slideshow_bytes is not None:
                logger.info("TikTok: publishing %d photo(s) as a slideshow with audio",
                            len(payload.media_urls))
                return self._publish_video_bytes(headers, payload, slideshow_bytes, "video/mp4")
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
        return self._publish_video_bytes(headers, payload, video_bytes, content_type)

    def _publish_video_bytes(
        self,
        headers: dict[str, str],
        payload: PostPayload,
        video_bytes: bytes,
        content_type: str,
    ) -> PublishResult:
        """Upload video bytes and publish, whether they came from an attachment
        or from a slideshow built here."""
        size = len(video_bytes)
        if size > MAX_SINGLE_CHUNK:
            raise PublishError(
                f"Video is {size // 1_000_000} MB; TikTok needs multi-chunk upload above "
                f"{MAX_SINGLE_CHUNK // 1_000_000} MB, which isn't supported yet."
            )

        # A whole-file upload is one chunk covering the entire video.
        source_info = {
            "source": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": size,
            "total_chunk_count": 1,
        }
        def video_target(drafts: bool) -> tuple[str, dict[str, Any]]:
            if drafts:
                # The inbox has its own endpoint and takes no post_info at all:
                # the caption and privacy are chosen in the app when publishing.
                return f"{API}/post/publish/inbox/video/init/", {"source_info": source_info}
            return f"{API}/post/publish/video/init/", {
                "post_info": {
                    "title": payload.text[:CAPTION_LIMIT],
                    "privacy_level": self._privacy_level(headers),
                },
                "source_info": source_info,
            }

        drafts = self._to_drafts()
        endpoint, init_json = video_target(drafts)
        init = self._post(endpoint, headers=headers, json=init_json)

        # See _publish_photos: drafts need video.upload, direct needs
        # video.publish, and a connection made before we asked for both has only
        # one of them.
        if drafts and self._scope_denied(init):
            logger.info("TikTok drafts unavailable (video.upload not granted); posting directly")
            endpoint, init_json = video_target(False)
            init = self._post(endpoint, headers=headers, json=init_json)
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

    def _slideshow_from_photos(self, payload: PostPayload) -> bytes | None:
        """Render the attached images into a video with the workspace's track.

        TikTok's API has no way to add music to a post, and its own library only
        exists inside the app, so a directly published photo post is silent and
        the alternative is asking a person to finish every post by hand. That is
        not automation. Building the slideshow ourselves gives a post that
        publishes unattended and arrives with sound.

        Returns None when it cannot be done, so the caller falls back to the
        photo carousel rather than dropping the post.
        """
        from ..media import slideshow

        if not payload.music_url:
            return None
        try:
            images = []
            for url in payload.media_urls[:PHOTO_LIMIT]:
                fetched = download_media(url)
                if fetched is None:
                    return None
                images.append(fetched[0])
            music = download_media(payload.music_url)
            if music is None or not images:
                return None
            return slideshow.build_slideshow(images, music[0])
        except Exception as e:  # noqa: BLE001 — a silent post beats no post
            logger.warning("TikTok slideshow build failed, posting photos instead: %s", e)
            return None

    def _publish_photos(self, headers: dict[str, str], payload: PostPayload) -> PublishResult:
        """Post images as a TikTok photo carousel.

        Photos go through a different endpoint to video, and unlike video they
        have no upload option — TikTok will only pull them from a URL, and that
        URL must sit under a domain or prefix verified on the developer app. So
        the media host itself has to be verified; bytes can't be sent instead.
        """
        images = payload.media_urls[:PHOTO_LIMIT]
        # TikTok will accept the init call, fetch the files, and only then fail
        # the whole post with file_format_check_failed. Checking here turns a
        # three-minute round trip into an immediate, specific answer.
        rejected = [u for u in images if u.split("?")[0].lower().endswith(UNSUPPORTED_PHOTO_EXT)]
        if rejected:
            raise PublishError(
                "TikTok's photo endpoint only accepts JPEG, and "
                f"{len(rejected)} of these images are not: {rejected[0].split('/')[-1]}. "
                "Regenerate the image, or attach a JPEG."
            )

        def photo_body(drafts: bool) -> dict[str, Any]:
            body: dict[str, Any] = {
                "source_info": {
                    "source": "PULL_FROM_URL",
                    "photo_cover_index": 0,
                    "photo_images": images,
                },
                "post_mode": "MEDIA_UPLOAD" if drafts else "DIRECT_POST",
                "media_type": "PHOTO",
            }
            # A draft carries no privacy_level: the person sets it in the app
            # when they publish, which is also why an unaudited app may send one.
            body["post_info"] = (
                {"title": (payload.title or payload.text)[:TITLE_LIMIT]}
                if drafts
                else {
                    "title": (payload.title or payload.text)[:TITLE_LIMIT],
                    "description": payload.text[:CAPTION_LIMIT],
                    "privacy_level": self._privacy_level(headers),
                }
            )
            return body

        drafts = self._to_drafts()
        endpoint = f"{API}/post/publish/content/init/"
        init = self._post(endpoint, headers=headers, json=photo_body(drafts))

        # Drafts need video.upload, which is a separate grant from the
        # video.publish that direct posting uses; connections made before we
        # asked for it cannot send one. Publishing directly still works, so fall
        # back rather than failing a post over a scope the person can restore by
        # reconnecting whenever they get round to it.
        if drafts and self._scope_denied(init):
            logger.info("TikTok drafts unavailable (video.upload not granted); posting directly")
            init = self._post(endpoint, headers=headers, json=photo_body(False))
        body = init.json()
        if init.status_code >= 400 or (body.get("error") or {}).get("code") not in (None, "ok"):
            raise self._fail_tiktok(init, "TikTok (photo init)")

        publish_id = (body.get("data") or {}).get("publish_id")
        if not publish_id:
            raise PublishError(f"TikTok did not return a publish_id: {str(body)[:300]}")

        self._await_publish(publish_id, headers, kind="photo")
        return PublishResult(external_post_id=publish_id, external_post_url=None)

    def _to_drafts(self) -> bool:
        """Should this post land in the user's TikTok inbox rather than live?

        Only when asked for. A draft waits for someone to open the app and press
        publish, so on a quiet day nothing is posted at all, which is the
        opposite of what a scheduler is for. It stays available because TikTok's
        music library lives in that editor and nowhere else.

        "auto" used to mean drafts-until-audited and is still honoured for
        anyone who set it, but it is no longer the default: sound now comes from
        the slideshow instead of from a person.
        """
        mode = get_settings().tiktok_post_mode.strip().lower()
        if mode == "drafts":
            return True
        if mode == "auto":
            return not get_settings().tiktok_audited
        return False

    @staticmethod
    def _scope_denied(response) -> bool:
        """Did TikTok refuse this for a scope the token does not carry?"""
        if response.status_code not in (401, 403):
            return False
        try:
            return (response.json().get("error") or {}).get("code") == "scope_not_authorized"
        except ValueError:
            return False

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
        if code == "scope_not_authorized":
            return PublishError(
                f"{stage}: this TikTok connection was authorised before GODEYE "
                "asked for the permissions it now needs. Reconnect TikTok from "
                "Connections and approve both posting permissions; the existing "
                "grant cannot be extended, only replaced."
            )
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

    def _await_publish(
        self, publish_id: str, headers: dict[str, str], kind: str = "video"
    ) -> None:
        """Block until TikTok has fetched and processed the upload.

        ``kind`` only shapes the error text, but a photo post reporting that
        "TikTok rejected the video" sends people to check a file they never
        sent.
        """
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
                if reason == "file_format_check_failed" and kind == "photo":
                    raise PublishError(
                        "TikTok rejected the images (file_format_check_failed). Its "
                        "photo endpoint accepts JPEG and will not take PNG. GODEYE "
                        "now generates JPEG, so an image made before that change "
                        "has to be regenerated before it can go to TikTok."
                    )
                raise PublishError(
                    f"TikTok rejected the {kind} ({reason}). Check the format and length "
                    "meet TikTok's requirements, and that the account can post."
                )
            time.sleep(PUBLISH_POLL_SEC)

        # Still processing — retry rather than discard the post.
        raise TransientPublishError(
            f"TikTok still reports {status} after {PUBLISH_TIMEOUT_SEC}s"
        )
