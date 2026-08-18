"""Telegram publisher. Bot API sendMessage / sendPhoto."""

from __future__ import annotations

from typing import Any

from .base import BasePublisher, PostPayload, PublishResult, download_media

# Telegram allows 2-10 items in an album; GODEYE caps posts at 4 images.
ALBUM_LIMIT = 10


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
        elif payload.media_urls and len(payload.media_urls) > 1:
            response = self._send_album(token, chat_id, payload)
        elif payload.media_urls:
            # Upload the image bytes when we can fetch them, so it works even when
            # the media is on a host Telegram can't reach (e.g. local dev storage).
            fetched = download_media(payload.media_urls[0])
            if fetched is not None:
                image_bytes, content_type = fetched
                response = self._post(
                    f"https://api.telegram.org/bot{token}/sendPhoto",
                    data={"chat_id": chat_id, "caption": payload.text[:1024]},
                    files={"photo": ("photo", image_bytes, content_type)},
                )
            else:
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

        # sendMediaGroup returns a list of messages; the others return one.
        result = body["result"]
        message = result[0] if isinstance(result, list) else result
        message_id = str(message["message_id"])
        username = (message.get("chat") or {}).get("username")
        url = f"https://t.me/{username}/{message_id}" if username else None
        return PublishResult(external_post_id=message_id, external_post_url=url)

    def _send_album(self, token: str, chat_id: str, payload: PostPayload):
        """Post 2+ photos as a single album via sendMediaGroup.

        Telegram accepts 2-10 items. The caption belongs on the first item only,
        otherwise it repeats under every photo. Bytes are uploaded via multipart
        and referenced as attach://<field>, matching the single-photo path so
        media on a host Telegram can't reach still works.
        """
        import json

        media: list[dict[str, Any]] = []
        files: dict[str, tuple[str, bytes, str]] = {}

        for index, url in enumerate(payload.media_urls[:ALBUM_LIMIT]):
            item: dict[str, Any] = {"type": "photo"}
            fetched = download_media(url)
            if fetched is not None:
                image_bytes, content_type = fetched
                field = f"photo{index}"
                files[field] = (field, image_bytes, content_type)
                item["media"] = f"attach://{field}"
            else:
                item["media"] = url
            if index == 0 and payload.text:
                item["caption"] = payload.text[:1024]
            media.append(item)

        return self._post(
            f"https://api.telegram.org/bot{token}/sendMediaGroup",
            data={"chat_id": chat_id, "media": json.dumps(media)},
            files=files or None,
        )
