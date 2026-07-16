"""Reddit publisher — script-app password grant + /api/submit."""

from __future__ import annotations

from typing import Any

from ..config import get_settings
from .base import BasePublisher, PostPayload, PublishError, PublishResult


class RedditPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        settings = get_settings()
        if not settings.reddit_client_id or not settings.reddit_client_secret:
            raise PublishError("Reddit app credentials missing on the server (.env)")

        token_response = self._post(
            "https://www.reddit.com/api/v1/access_token",
            auth=(settings.reddit_client_id, settings.reddit_client_secret),
            headers={"User-Agent": settings.reddit_user_agent},
            data={
                "grant_type": "password",
                "username": credentials["username"],
                "password": credentials["password"],
            },
        )
        token = token_response.json().get("access_token")
        if not token:
            raise self._fail(token_response, "Reddit (auth)")

        title = (payload.title or payload.text.split("\n")[0])[:290]
        response = self._post(
            "https://oauth.reddit.com/api/submit",
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": settings.reddit_user_agent,
            },
            data={
                "sr": credentials["subreddit"],
                "kind": "self",
                "title": title,
                "text": payload.text[:40000],
                "api_type": "json",
            },
        )
        body = response.json()
        errors = (body.get("json") or {}).get("errors") or []
        if response.status_code >= 400 or errors:
            raise PublishError(f"Reddit rejected the post: {errors or response.text[:300]}")

        data = (body.get("json") or {}).get("data") or {}
        return PublishResult(
            external_post_id=str(data.get("id") or data.get("name") or ""),
            external_post_url=data.get("url"),
        )

    def get_metrics(self, credentials: dict[str, Any], external_post_id: str) -> float | None:
        import httpx

        settings = get_settings()
        fullname = (
            external_post_id if external_post_id.startswith("t3_") else f"t3_{external_post_id}"
        )
        response = httpx.get(
            f"https://www.reddit.com/api/info.json?id={fullname}",
            headers={"User-Agent": settings.reddit_user_agent},
            timeout=30,
        )
        if response.status_code != 200:
            return None
        children = (response.json().get("data") or {}).get("children") or []
        if not children:
            return None
        post = children[0].get("data") or {}
        return float(post.get("score", 0) + post.get("num_comments", 0) * 2)
