"""Telegram publisher — Bot API sendMessage / sendPhoto."""

from __future__ import annotations

from typing import Any

from .base import BasePublisher, PostPayload, PublishResult


class TelegramPublisher(BasePublisher):
    def _publish(self, credentials: dict[str, Any], payload: PostPayload) -> PublishResult:
        token = credentials["botToken"]
        chat_id = credentials["chatId"]

        if payload.video_urls:
            response = self._post(
                f"https://api.telegram.org/bot{token}/sendVideo",
                json={
                    "chat_id": chat_id,
                    "video": payload.video_urls[0],
                    "caption": payload.text[:1024],
                },
            )
        elif payload.media_urls:
            response = self._post(
                f"https://api.telegram.org/bot{token}/sendPhoto",
                json={
                    "chat_id": chat_id,
                    "photo": payload.media_urls[0],
                    "caption": payload.text[:1024],
                },
            )
        else:
            response = self._post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": payload.text[:4096]},
            )

        body = response.json()
        if not body.get("ok"):
            raise self._fail(response, "Telegram")

        message = body["result"]
        message_id = str(message["message_id"])
        username = (message.get("chat") or {}).get("username")
        url = f"https://t.me/{username}/{message_id}" if username else None
        return PublishResult(external_post_id=message_id, external_post_url=url)
