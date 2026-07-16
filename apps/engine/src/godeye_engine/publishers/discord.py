"""Discord publisher — bot REST API channel messages."""

from __future__ import annotations

from typing import Any

from .base import BasePublisher, PostPayload, PublishResult


class DiscordPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        token = credentials["botToken"]
        channel_id = credentials["channelId"]

        text = payload.text
        # Discord auto-embeds mp4 links appended to the message content
        if payload.video_urls:
            text = f"{text}\n{payload.video_urls[0]}"
        body: dict[str, Any] = {"content": text[:2000]}
        if payload.media_urls:
            body["embeds"] = [{"image": {"url": url}} for url in payload.media_urls[:4]]

        response = self._post(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            headers={"Authorization": f"Bot {token}"},
            json=body,
        )
        if response.status_code >= 400:
            raise self._fail(response, "Discord")

        message = response.json()
        message_id = str(message["id"])
        guild_id = message.get("guild_id")
        url = (
            f"https://discord.com/channels/{guild_id}/{channel_id}/{message_id}"
            if guild_id
            else None
        )
        return PublishResult(external_post_id=message_id, external_post_url=url)

    def get_metrics(self, credentials: dict[str, Any], external_post_id: str) -> float | None:
        import httpx

        response = httpx.get(
            f"https://discord.com/api/v10/channels/{credentials['channelId']}/messages/{external_post_id}",
            headers={"Authorization": f"Bot {credentials['botToken']}"},
            timeout=30,
        )
        if response.status_code != 200:
            return None
        message = response.json()
        reactions = sum(r.get("count", 0) for r in message.get("reactions") or [])
        return float(reactions)
