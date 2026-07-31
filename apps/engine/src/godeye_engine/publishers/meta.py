"""Meta publishers — Facebook Page feed + Instagram Business (Graph API)."""

from __future__ import annotations

from typing import Any

from .base import (
    BasePublisher,
    PostPayload,
    PublishError,
    PublishResult,
    TransientPublishError,
    download_media,
)

GRAPH = "https://graph.facebook.com/v21.0"


class FacebookPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        page_id = credentials["pageId"]
        token = credentials["pageAccessToken"]

        if payload.video_urls:
            response = self._post(
                f"{GRAPH}/{page_id}/videos",
                data={
                    "file_url": payload.video_urls[0],
                    "description": payload.text,
                    "access_token": token,
                },
            )
        elif payload.media_urls and len(payload.media_urls) > 1:
            response = self._post_photo_album(page_id, token, payload)
        elif payload.media_urls:
            # Upload the image bytes when we can fetch them, so it works even when
            # the media is on a host Facebook can't reach (e.g. local dev storage).
            fetched = download_media(payload.media_urls[0])
            if fetched is not None:
                image_bytes, content_type = fetched
                response = self._post(
                    f"{GRAPH}/{page_id}/photos",
                    data={"caption": payload.text, "access_token": token},
                    files={"source": ("image", image_bytes, content_type)},
                )
            else:
                response = self._post(
                    f"{GRAPH}/{page_id}/photos",
                    data={
                        "url": payload.media_urls[0],
                        "caption": payload.text,
                        "access_token": token,
                    },
                )
        else:
            response = self._post(
                f"{GRAPH}/{page_id}/feed",
                data={"message": payload.text, "access_token": token},
            )

        body = response.json()
        if response.status_code >= 400 or "error" in body:
            raise self._fail_page(response, "Facebook")

        post_id = str(body.get("id") or body.get("post_id") or "")
        return PublishResult(
            external_post_id=post_id,
            external_post_url=f"https://www.facebook.com/{post_id}" if post_id else None,
        )

    # Meta answers a token that has lost its Page permissions with a list of six
    # permission names and the phrase "before impersonating a user's page",
    # which reads as a code problem and is not one.
    _PAGE_PERMISSION_HELP = (
        "This Page's saved login no longer carries permission to post. That "
        "happens when the app's permissions change in the Meta dashboard: "
        "tokens issued beforehand lose what was removed, and they cannot be "
        "repaired, only replaced. Reconnect this Page from Connections and the "
        "new token will carry the current permissions."
    )

    def _fail_page(self, response, stage: str) -> PublishError:
        """Translate a revoked-permission rejection into the one useful action."""
        error = self._fail(response, stage)
        try:
            err = response.json().get("error") or {}
        except ValueError:
            return error
        message = str(err.get("message") or "")
        # Code 190 is Meta's catch-all for a token that is no longer good for
        # what it is being used for; the wording is what identifies this case.
        if err.get("code") == 190 or "must be granted" in message:
            return PublishError(f"{stage}: {self._PAGE_PERMISSION_HELP}")
        return error

    def _post_photo_album(self, page_id: str, token: str, payload: PostPayload):
        """Publish several photos as one feed post.

        Facebook has no multi-photo endpoint: each image is uploaded to /photos
        with published=false, then their ids are attached to a single /feed post.
        Uploading published photos instead would produce a separate post per
        image.
        """
        media_ids: list[str] = []
        for url in payload.media_urls:
            fetched = download_media(url)
            if fetched is not None:
                image_bytes, content_type = fetched
                upload = self._post(
                    f"{GRAPH}/{page_id}/photos",
                    data={"published": "false", "access_token": token},
                    files={"source": ("image", image_bytes, content_type)},
                )
            else:
                upload = self._post(
                    f"{GRAPH}/{page_id}/photos",
                    data={"url": url, "published": "false", "access_token": token},
                )
            body = upload.json()
            if upload.status_code >= 400 or "error" in body:
                raise self._fail(upload, "Facebook (photo upload)")
            media_ids.append(body["id"])

        data: dict[str, Any] = {"message": payload.text, "access_token": token}
        for index, media_id in enumerate(media_ids):
            data[f"attached_media[{index}]"] = f'{{"media_fbid":"{media_id}"}}'
        return self._post(f"{GRAPH}/{page_id}/feed", data=data)

    def get_metrics(self, credentials: dict[str, Any], external_post_id: str) -> float | None:
        import httpx

        response = httpx.get(
            f"{GRAPH}/{external_post_id}",
            params={
                "fields": "likes.summary(true),comments.summary(true),shares",
                "access_token": credentials["pageAccessToken"],
            },
            timeout=30,
        )
        if response.status_code != 200:
            return None
        body = response.json()
        likes = ((body.get("likes") or {}).get("summary") or {}).get("total_count", 0)
        comments = ((body.get("comments") or {}).get("summary") or {}).get("total_count", 0)
        shares = (body.get("shares") or {}).get("count", 0)
        return float(likes + comments * 2 + shares * 3)


IG_GRAPH = "https://graph.instagram.com/v21.0"

# How long to wait for Instagram to ingest the media before giving up, and how
# often to ask. Images usually finish in a few seconds; video takes longer.
CONTAINER_TIMEOUT_SEC = 60
CONTAINER_POLL_SEC = 3

# Instagram allows 2-10 images in a carousel; GODEYE caps posts at 4.
CAROUSEL_LIMIT = 10


class InstagramPublisher(BasePublisher):
    """IG content publishing is a 2-step flow and REQUIRES media.

    Two connection shapes exist:
      * Facebook Login  — a page token, called against the Facebook Graph host.
        Legacy: GODEYE no longer requests instagram_content_publish, so no new
        connections take this shape and existing ones stop working once the
        token is re-authorized. Kept so they keep publishing until then.
      * Instagram Login — the account's own token and graph.instagram.com, and
        the only route offered now.
    `authMethod` on the stored credentials picks between them.
    """

    # Meta error codes that mean "this token isn't allowed to do that": 10 and
    # 200 are permission errors, 190 is an invalid/expired token, and subcode 33
    # arrives as a bogus "Unsupported get request" when a scope is absent.
    _PERMISSION_HINT = (
        "This Instagram account was connected through Facebook, which GODEYE no "
        "longer has permission to publish with. Reconnect it from Connections "
        "using the Instagram button — it takes a few seconds and needs no "
        "Facebook Page."
    )

    def _fail_ig(self, response, stage: str, legacy: bool) -> PublishError:
        """Meta's own wording for a missing scope is unactionable, so when a
        legacy Facebook-linked connection hits one, say what to do about it."""
        error = self._fail(response, stage)
        if not legacy:
            return error
        try:
            body = response.json().get("error", {})
            code, subcode = body.get("code"), body.get("error_subcode")
        except Exception:  # noqa: BLE001 — a non-JSON body just isn't a scope error
            return error
        if code in (10, 190, 200) or subcode == 33:
            return PublishError(f"{error}. {self._PERMISSION_HINT}")
        return error

    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        if not payload.media_urls:
            raise PublishError(
                "Instagram requires an image or video — attach media to this post"
            )
        ig_user_id = credentials["igUserId"]
        legacy = credentials.get("authMethod") != "instagram_login"
        if legacy:
            base, token = GRAPH, credentials["pageAccessToken"]
        else:
            base, token = IG_GRAPH, credentials["accessToken"]

        if len(payload.media_urls) > 1:
            container = self._create_carousel(base, ig_user_id, token, payload)
        else:
            container = self._post(
                f"{base}/{ig_user_id}/media",
                data={
                    "image_url": payload.media_urls[0],
                    "caption": payload.text[:2200],
                    "access_token": token,
                },
            )
        container_body = container.json()
        if container.status_code >= 400 or "error" in container_body:
            raise self._fail_ig(container, "Instagram (container)", legacy)

        creation_id = container_body["id"]
        self._await_container(base, creation_id, token)

        publish = self._post(
            f"{base}/{ig_user_id}/media_publish",
            data={"creation_id": creation_id, "access_token": token},
        )
        publish_body = publish.json()
        if publish.status_code >= 400 or "error" in publish_body:
            raise self._fail_ig(publish, "Instagram (publish)", legacy)

        media_id = str(publish_body.get("id") or "")
        return PublishResult(external_post_id=media_id, external_post_url=None)

    def _create_carousel(self, base: str, ig_user_id: str, token: str, payload: PostPayload):
        """Build a multi-image carousel container.

        Instagram needs each image uploaded as its own container flagged
        is_carousel_item, and then a CAROUSEL container referencing them. Each
        child must finish ingesting before the parent is created, hence the wait
        per child — the same "Media ID is not available" trap as a single post.
        """
        child_ids: list[str] = []
        for url in payload.media_urls[:CAROUSEL_LIMIT]:
            child = self._post(
                f"{base}/{ig_user_id}/media",
                data={"image_url": url, "is_carousel_item": "true", "access_token": token},
            )
            body = child.json()
            if child.status_code >= 400 or "error" in body:
                raise self._fail(child, "Instagram (carousel item)")
            child_id = body["id"]
            self._await_container(base, child_id, token)
            child_ids.append(child_id)

        return self._post(
            f"{base}/{ig_user_id}/media",
            data={
                "media_type": "CAROUSEL",
                "children": ",".join(child_ids),
                "caption": payload.text[:2200],
                "access_token": token,
            },
        )

    def _await_container(self, base: str, creation_id: str, token: str) -> None:
        """Block until Instagram has finished ingesting the media.

        Container creation is asynchronous: Instagram downloads and processes the
        image before it can be published. Publishing too early fails with
        "Media ID is not available" (code 9007) — flagged is_transient: false
        even though it resolves on its own, so it must be waited out rather than
        retried as a whole post.
        """
        import time

        import httpx

        deadline = time.monotonic() + CONTAINER_TIMEOUT_SEC
        last_status = "UNKNOWN"
        while time.monotonic() < deadline:
            try:
                response = httpx.get(
                    f"{base}/{creation_id}",
                    params={"fields": "status_code,status", "access_token": token},
                    timeout=self.timeout,
                )
            except httpx.TransportError as e:
                raise TransientPublishError(f"Network error polling container: {e}") from e

            body = response.json()
            last_status = body.get("status_code") or "UNKNOWN"
            if last_status == "FINISHED":
                return
            if last_status in ("ERROR", "EXPIRED"):
                raise PublishError(
                    f"Instagram could not process the media ({last_status}): "
                    f"{body.get('status') or 'no detail'}. Check the image URL is "
                    "publicly reachable and is JPEG under 8 MB."
                )
            time.sleep(CONTAINER_POLL_SEC)

        # Still processing — worth another attempt rather than failing the post.
        raise TransientPublishError(
            f"Instagram media still {last_status} after {CONTAINER_TIMEOUT_SEC}s"
        )
