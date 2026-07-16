"""X (Twitter) publisher — API v2 with OAuth 1.0a user context."""

from __future__ import annotations

from typing import Any

import httpx

from . import oauth1
from .base import BasePublisher, PostPayload, PublishResult, TransientPublishError

TWEETS_URL = "https://api.twitter.com/2/tweets"
ME_URL = "https://api.twitter.com/2/users/me"


def _auth_header(credentials: dict[str, Any], method: str, url: str) -> str:
    return oauth1.sign(
        method,
        url,
        consumer_key=credentials["apiKey"],
        consumer_secret=credentials["apiSecret"],
        token=credentials["accessToken"],
        token_secret=credentials["accessSecret"],
    )


def verify_credentials(credentials: dict[str, Any]) -> dict[str, str]:
    """Used at connect time — returns the account's username/name or raises."""
    response = httpx.get(
        ME_URL,
        headers={"Authorization": _auth_header(credentials, "GET", ME_URL)},
        timeout=30,
    )
    body = response.json()
    if response.status_code != 200 or "data" not in body:
        detail = body.get("detail") or body.get("title") or response.text[:200]
        raise ValueError(f"X rejected the credentials: {detail}")
    return {
        "id": body["data"]["id"],
        "username": body["data"]["username"],
        "name": body["data"].get("name", body["data"]["username"]),
    }


class XPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        response = self._post(
            TWEETS_URL,
            headers={
                "Authorization": _auth_header(credentials, "POST", TWEETS_URL),
                "Content-Type": "application/json",
            },
            json={"text": payload.text[:280]},
        )
        body = response.json()
        if response.status_code >= 400 or "data" not in body:
            raise self._fail(response, "X")
        tweet_id = str(body["data"]["id"])
        return PublishResult(
            external_post_id=tweet_id,
            external_post_url=f"https://x.com/i/web/status/{tweet_id}",
        )

    def get_metrics(self, credentials: dict[str, Any], external_post_id: str) -> float | None:
        url = f"https://api.twitter.com/2/tweets/{external_post_id}?tweet.fields=public_metrics"
        try:
            response = httpx.get(
                url,
                headers={"Authorization": _auth_header(credentials, "GET", url)},
                timeout=30,
            )
        except httpx.TransportError as e:
            raise TransientPublishError(str(e)) from e
        body = response.json()
        metrics = (body.get("data") or {}).get("public_metrics")
        if not metrics:
            return None
        return float(
            metrics.get("like_count", 0)
            + metrics.get("retweet_count", 0) * 2
            + metrics.get("reply_count", 0) * 2
            + metrics.get("quote_count", 0) * 2
        )
