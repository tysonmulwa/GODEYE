"""LinkedIn publisher, member posts via the versioned REST API."""

from __future__ import annotations

from typing import Any

from .base import BasePublisher, PostPayload, PublishError, PublishResult

POSTS_URL = "https://api.linkedin.com/rest/posts"
LINKEDIN_VERSION = "202401"


class LinkedInPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        token = credentials["accessToken"]
        author = credentials["memberUrn"]  # e.g. "urn:li:person:AbC123"

        response = self._post(
            POSTS_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "LinkedIn-Version": LINKEDIN_VERSION,
                "X-Restli-Protocol-Version": "2.0.0",
                "Content-Type": "application/json",
            },
            json={
                "author": author,
                "commentary": payload.text[:3000],
                "visibility": "PUBLIC",
                "distribution": {
                    "feedDistribution": "MAIN_FEED",
                    "targetEntities": [],
                    "thirdPartyDistributionChannels": [],
                },
                "lifecycleState": "PUBLISHED",
                "isReshareDisabledByAuthor": False,
            },
        )
        if response.status_code == 401:
            raise PublishError(
                "LinkedIn token expired, reconnect the LinkedIn account (tokens last ~60 days)"
            )
        if response.status_code >= 400:
            raise self._fail(response, "LinkedIn")

        post_urn = response.headers.get("x-restli-id", "")
        return PublishResult(
            external_post_id=post_urn,
            external_post_url=(
                f"https://www.linkedin.com/feed/update/{post_urn}" if post_urn else None
            ),
        )
