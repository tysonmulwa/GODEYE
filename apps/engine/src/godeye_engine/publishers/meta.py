"""Meta publishers — Facebook Page feed + Instagram Business (Graph API)."""

from __future__ import annotations

from typing import Any

from .base import BasePublisher, PostPayload, PublishError, PublishResult, download_media

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
            raise self._fail(response, "Facebook")

        post_id = str(body.get("id") or body.get("post_id") or "")
        return PublishResult(
            external_post_id=post_id,
            external_post_url=f"https://www.facebook.com/{post_id}" if post_id else None,
        )

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


class InstagramPublisher(BasePublisher):
    """IG content publishing is a 2-step flow and REQUIRES media.

    Two connection shapes exist:
      * Facebook Login  — a page token, called against the Facebook Graph host.
      * Instagram Login — the account's own token and graph.instagram.com, used
        when there is no linked Facebook Page.
    `authMethod` on the stored credentials picks between them.
    """

    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        if not payload.media_urls:
            raise PublishError(
                "Instagram requires an image or video — attach media to this post"
            )
        ig_user_id = credentials["igUserId"]
        if credentials.get("authMethod") == "instagram_login":
            base, token = IG_GRAPH, credentials["accessToken"]
        else:
            base, token = GRAPH, credentials["pageAccessToken"]

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
            raise self._fail(container, "Instagram (container)")

        publish = self._post(
            f"{base}/{ig_user_id}/media_publish",
            data={"creation_id": container_body["id"], "access_token": token},
        )
        publish_body = publish.json()
        if publish.status_code >= 400 or "error" in publish_body:
            raise self._fail(publish, "Instagram (publish)")

        media_id = str(publish_body.get("id") or "")
        return PublishResult(external_post_id=media_id, external_post_url=None)
