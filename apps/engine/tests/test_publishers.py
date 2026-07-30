"""Publisher adapter tests against mocked HTTP responses."""

from unittest.mock import MagicMock

import pytest

from godeye_engine.publishers import get_publisher
from godeye_engine.publishers.base import PostPayload, PublishError
from godeye_engine.publishers.linkedin import LinkedInPublisher
from godeye_engine.publishers.meta import InstagramPublisher
from godeye_engine.publishers.telegram import TelegramPublisher
from godeye_engine.publishers.x import XPublisher


def http_response(status_code: int, body: dict) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = body
    response.text = str(body)
    return response


class TestRegistry:
    def test_returns_adapter_for_known_platform(self):
        assert isinstance(get_publisher("TELEGRAM"), TelegramPublisher)

    def test_raises_for_unimplemented_platform(self):
        # TIKTOK used to stand in here; it ships now, so assert on one that doesn't.
        with pytest.raises(PublishError, match="PINTEREST"):
            get_publisher("PINTEREST")


class TestTelegram:
    def test_publishes_text(self, monkeypatch):
        captured = {}

        def fake_post(self, url, **kwargs):
            captured["url"] = url
            captured["json"] = kwargs.get("json")
            return http_response(
                200,
                {
                    "ok": True,
                    "result": {"message_id": 42, "chat": {"username": "mychannel"}},
                },
            )

        monkeypatch.setattr(TelegramPublisher, "_post", fake_post)
        result = TelegramPublisher().publish(
            {"botToken": "123:abc", "chatId": "-100999"},
            PostPayload(text="Hello world"),
        )
        assert result.external_post_id == "42"
        assert result.external_post_url == "https://t.me/mychannel/42"
        assert "sendMessage" in captured["url"]
        assert captured["json"]["text"] == "Hello world"

    def test_raises_on_api_error(self, monkeypatch):
        monkeypatch.setattr(
            TelegramPublisher,
            "_post",
            lambda self, url, **kw: http_response(200, {"ok": False, "description": "bad chat"}),
        )
        with pytest.raises(PublishError):
            TelegramPublisher().publish(
                {"botToken": "123:abc", "chatId": "x"}, PostPayload(text="hi")
            )


class TestInstagram:
    def test_requires_media(self):
        with pytest.raises(PublishError, match="requires an image"):
            InstagramPublisher().publish(
                {"igUserId": "1", "pageAccessToken": "t"},
                PostPayload(text="text only"),
            )

    @staticmethod
    def _capture(monkeypatch, status="FINISHED"):
        """Record the URLs the publisher calls, returning plausible responses.

        Also stubs the container status poll, which sits between creating the
        container and publishing it.
        """
        calls: list[str] = []

        class Resp:
            status_code = 200

            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        def fake_post(self, url, **kwargs):
            calls.append(url)
            return Resp({"id": "media-1"})

        def fake_get(url, **kwargs):
            calls.append(url)
            return Resp({"status_code": status})

        import httpx

        monkeypatch.setattr(InstagramPublisher, "_post", fake_post)
        # The publisher imports httpx inside the method, so patch the module.
        monkeypatch.setattr(httpx, "get", fake_get)
        return calls

    def test_waits_for_the_container_before_publishing(self, monkeypatch):
        """Publishing before Instagram finishes ingesting fails with code 9007."""
        calls = self._capture(monkeypatch)
        InstagramPublisher().publish(
            {"igUserId": "1", "accessToken": "t", "authMethod": "instagram_login"},
            PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
        )
        poll_index = next(i for i, u in enumerate(calls) if u.endswith("/media-1"))
        publish_index = next(i for i, u in enumerate(calls) if "/media_publish" in u)
        assert poll_index < publish_index, f"must poll before publishing: {calls}"

    def test_container_error_is_permanent(self, monkeypatch):
        self._capture(monkeypatch, status="ERROR")
        with pytest.raises(PublishError, match="could not process the media"):
            InstagramPublisher().publish(
                {"igUserId": "1", "accessToken": "t", "authMethod": "instagram_login"},
                PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
            )

    def test_facebook_login_uses_facebook_graph(self, monkeypatch):
        calls = self._capture(monkeypatch)
        InstagramPublisher().publish(
            {"igUserId": "1", "pageAccessToken": "t"},
            PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
        )
        assert all("graph.facebook.com" in url for url in calls), calls

    def test_instagram_login_uses_instagram_graph(self, monkeypatch):
        """A Page-less connection must not be sent to the Facebook host."""
        calls = self._capture(monkeypatch)
        InstagramPublisher().publish(
            {"igUserId": "1", "accessToken": "t", "authMethod": "instagram_login"},
            PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
        )
        assert calls, "expected container + publish calls"
        assert all("graph.instagram.com" in url for url in calls), calls
        assert any("/media_publish" in url for url in calls), calls

    def test_legacy_connection_permission_error_says_how_to_fix_it(self, monkeypatch):
        """GODEYE dropped instagram_content_publish, so Facebook-linked
        Instagram connections die once re-authorized. Meta's own wording for a
        missing scope tells the user nothing they can act on."""
        monkeypatch.setattr(
            InstagramPublisher,
            "_post",
            lambda self, url, **kw: http_response(
                403, {"error": {"message": "Requires instagram_content_publish", "code": 200}}
            ),
        )
        with pytest.raises(PublishError, match="Reconnect it from Connections"):
            InstagramPublisher().publish(
                {"igUserId": "1", "pageAccessToken": "t"},
                PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
            )

    def test_instagram_login_errors_are_left_alone(self, monkeypatch):
        """The reconnect advice would be nonsense on a connection that already
        uses Instagram Login — it is the thing being recommended."""
        monkeypatch.setattr(
            InstagramPublisher,
            "_post",
            lambda self, url, **kw: http_response(
                400, {"error": {"message": "Media upload failed", "code": 200}}
            ),
        )
        with pytest.raises(PublishError) as caught:
            InstagramPublisher().publish(
                {"igUserId": "1", "accessToken": "t", "authMethod": "instagram_login"},
                PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
            )
        assert "Reconnect it from Connections" not in str(caught.value)

    def test_a_legacy_non_permission_error_is_not_blamed_on_scopes(self, monkeypatch):
        """A broken image URL is not a permissions problem, and saying so would
        send the user off reconnecting an account that is working fine."""
        monkeypatch.setattr(
            InstagramPublisher,
            "_post",
            lambda self, url, **kw: http_response(
                400, {"error": {"message": "media_url is not reachable", "code": 9004}}
            ),
        )
        with pytest.raises(PublishError) as caught:
            InstagramPublisher().publish(
                {"igUserId": "1", "pageAccessToken": "t"},
                PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
            )
        assert "Reconnect it from Connections" not in str(caught.value)


X_CREDS = {
    "apiKey": "k",
    "apiSecret": "s",
    "accessToken": "t",
    "accessSecret": "ts",
}


class TestX:
    def test_registered(self):
        assert isinstance(get_publisher("X"), XPublisher)

    def test_publishes_tweet(self, monkeypatch):
        captured = {}

        def fake_post(self, url, **kwargs):
            captured["url"] = url
            captured["headers"] = kwargs.get("headers")
            captured["json"] = kwargs.get("json")
            return http_response(201, {"data": {"id": "1789", "text": "hi"}})

        monkeypatch.setattr(XPublisher, "_post", fake_post)
        result = XPublisher().publish(X_CREDS, PostPayload(text="Hello X"))
        assert result.external_post_id == "1789"
        assert "x.com" in result.external_post_url
        assert captured["json"] == {"text": "Hello X"}
        assert captured["headers"]["Authorization"].startswith("OAuth ")

    def test_truncates_to_280(self, monkeypatch):
        captured = {}

        def fake_post(self, url, **kwargs):
            captured["json"] = kwargs.get("json")
            return http_response(201, {"data": {"id": "1", "text": "x"}})

        monkeypatch.setattr(XPublisher, "_post", fake_post)
        XPublisher().publish(X_CREDS, PostPayload(text="a" * 500))
        assert len(captured["json"]["text"]) == 280

    def test_raises_on_error(self, monkeypatch):
        monkeypatch.setattr(
            XPublisher,
            "_post",
            lambda self, url, **kw: http_response(403, {"detail": "not permitted"}),
        )
        with pytest.raises(PublishError):
            XPublisher().publish(X_CREDS, PostPayload(text="hi"))


class TestLinkedIn:
    def test_registered(self):
        assert isinstance(get_publisher("LINKEDIN"), LinkedInPublisher)

    def test_publishes_post(self, monkeypatch):
        def fake_post(self, url, **kwargs):
            response = http_response(201, {})
            response.headers = {"x-restli-id": "urn:li:share:999"}
            return response

        monkeypatch.setattr(LinkedInPublisher, "_post", fake_post)
        result = LinkedInPublisher().publish(
            {"accessToken": "t", "memberUrn": "urn:li:person:abc"},
            PostPayload(text="Hello LinkedIn"),
        )
        assert result.external_post_id == "urn:li:share:999"

    def test_expired_token_is_permanent_error(self, monkeypatch):
        monkeypatch.setattr(
            LinkedInPublisher, "_post", lambda self, url, **kw: http_response(401, {})
        )
        with pytest.raises(PublishError, match="expired"):
            LinkedInPublisher().publish(
                {"accessToken": "t", "memberUrn": "urn:li:person:abc"},
                PostPayload(text="hi"),
            )


class TestTikTok:
    def test_registered(self):
        from godeye_engine.publishers import get_publisher
        from godeye_engine.publishers.tiktok import TikTokPublisher

        assert isinstance(get_publisher("TIKTOK"), TikTokPublisher)

    def test_requires_media(self):
        """TikTok has no text-only post — fail before calling the API."""
        from godeye_engine.publishers.tiktok import TikTokPublisher

        with pytest.raises(PublishError, match="needs media"):
            TikTokPublisher().publish({"accessToken": "t"}, PostPayload(text="hi"))

    def test_photos_use_the_content_endpoint_and_pull_from_url(self, monkeypatch):
        """Photos have no upload path — they must be pulled from their URLs."""
        import httpx

        from godeye_engine.publishers.tiktok import TikTokPublisher

        class Resp:
            status_code = 200

            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        calls = []

        def fake_post(self, url, **kw):
            calls.append((url, kw))
            return Resp({"data": {"publish_id": "pub-1"}, "error": {"code": "ok"}})

        monkeypatch.setattr(TikTokPublisher, "_post", fake_post)
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: Resp({"data": {"status": "PUBLISH_COMPLETE",
                                            "privacy_level_options": ["SELF_ONLY"]}}),
        )
        # Nothing should be uploaded for a photo post.
        def no_put(*a, **kw):
            raise AssertionError("photos must not be uploaded")

        monkeypatch.setattr(httpx, "put", no_put)

        result = TikTokPublisher().publish(
            {"accessToken": "t"},
            PostPayload(text="hi", media_urls=["https://cdn/1.jpg", "https://cdn/2.jpg"]),
        )
        assert result.external_post_id == "pub-1"
        init = next(c for c in calls if "content/init" in c[0])
        body = init[1]["json"]
        assert body["media_type"] == "PHOTO"
        assert body["source_info"]["source"] == "PULL_FROM_URL"
        assert body["source_info"]["photo_images"] == ["https://cdn/1.jpg", "https://cdn/2.jpg"]

    def test_polls_until_complete(self, monkeypatch):
        import httpx

        from godeye_engine.publishers.tiktok import TikTokPublisher

        class Resp:
            status_code = 200

            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: Resp(
                {"data": {"publish_id": "pub-1", "upload_url": "https://up/1"},
                 "error": {"code": "ok"}}
            ),
        )
        monkeypatch.setattr(
            "godeye_engine.publishers.tiktok.download_media",
            lambda u: (b"video-bytes", "video/mp4"),
        )
        put_calls = []
        monkeypatch.setattr(httpx, "put", lambda url, **kw: put_calls.append((url, kw)) or Resp({}))
        statuses = iter(["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"])
        monkeypatch.setattr(httpx, "post", lambda *a, **kw: Resp({"data": {"status": next(statuses)}}))
        monkeypatch.setattr("godeye_engine.publishers.tiktok.PUBLISH_POLL_SEC", 0)

        result = TikTokPublisher().publish(
            {"accessToken": "t"}, PostPayload(text="hi", video_urls=["https://cdn/v.mp4"])
        )
        assert result.external_post_id == "pub-1"
        # The bytes must be PUT to the upload URL — FILE_UPLOAD, not a pull.
        assert len(put_calls) == 1 and put_calls[0][0] == "https://up/1"
        assert put_calls[0][1]["content"] == b"video-bytes"

    def test_failed_status_is_permanent(self, monkeypatch):
        import httpx

        from godeye_engine.publishers.tiktok import TikTokPublisher

        class Resp:
            status_code = 200

            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: Resp(
                {"data": {"publish_id": "pub-1", "upload_url": "https://up/1"},
                 "error": {"code": "ok"}}
            ),
        )
        monkeypatch.setattr(
            "godeye_engine.publishers.tiktok.download_media",
            lambda u: (b"video-bytes", "video/mp4"),
        )
        monkeypatch.setattr(httpx, "put", lambda url, **kw: Resp({}))
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: Resp({"data": {"status": "FAILED", "fail_reason": "video_too_long"}}),
        )
        with pytest.raises(PublishError, match="video_too_long"):
            TikTokPublisher().publish(
                {"accessToken": "t"}, PostPayload(text="hi", video_urls=["https://cdn/v.mp4"])
            )


class TestMultiImage:
    """Two or more images must become one grouped post, not several posts."""

    class Resp:
        status_code = 200

        def __init__(self, body):
            self._body = body

        def json(self):
            return self._body

    def test_telegram_uses_send_media_group(self, monkeypatch):
        calls = []

        def fake_post(self, url, **kw):
            calls.append((url, kw))
            return TestMultiImage.Resp({"ok": True, "result": [{"message_id": 7, "chat": {}}]})

        monkeypatch.setattr(TelegramPublisher, "_post", fake_post)
        monkeypatch.setattr(
            "godeye_engine.publishers.telegram.download_media", lambda u: None
        )
        result = TelegramPublisher().publish(
            {"botToken": "t", "chatId": "-100"},
            PostPayload(text="hi", media_urls=["https://a/1.jpg", "https://a/2.jpg"]),
        )
        assert len(calls) == 1, "an album is one call, not one per photo"
        assert "sendMediaGroup" in calls[0][0]
        import json as _json

        media = _json.loads(calls[0][1]["data"]["media"])
        assert len(media) == 2
        # Caption on the first item only, else it repeats under every photo.
        assert media[0].get("caption") == "hi"
        assert "caption" not in media[1]
        # result is a list for media groups — must still yield an id
        assert result.external_post_id == "7"

    def test_facebook_attaches_unpublished_photos_to_one_post(self, monkeypatch):
        from godeye_engine.publishers.meta import FacebookPublisher

        calls = []

        def fake_post(self, url, **kw):
            calls.append((url, kw))
            return TestMultiImage.Resp({"id": f"m{len(calls)}"})

        monkeypatch.setattr(FacebookPublisher, "_post", fake_post)
        monkeypatch.setattr("godeye_engine.publishers.meta.download_media", lambda u: None)
        FacebookPublisher().publish(
            {"pageId": "p1", "pageAccessToken": "t"},
            PostPayload(text="hi", media_urls=["https://a/1.jpg", "https://a/2.jpg"]),
        )
        uploads = [c for c in calls if c[0].endswith("/photos")]
        feed = [c for c in calls if c[0].endswith("/feed")]
        assert len(uploads) == 2 and len(feed) == 1, calls
        # Unpublished, or each photo becomes its own post.
        assert all(c[1]["data"].get("published") == "false" for c in uploads)
        assert "attached_media[0]" in feed[0][1]["data"]
        assert "attached_media[1]" in feed[0][1]["data"]

    def test_instagram_builds_a_carousel(self, monkeypatch):
        import httpx

        calls = []
        # Children, then the carousel parent, then media_publish — don't run dry.
        ids = iter(["c1", "c2", "parent", "published"])

        def fake_post(self, url, **kw):
            calls.append((url, kw))
            return TestMultiImage.Resp({"id": next(ids)})

        monkeypatch.setattr(InstagramPublisher, "_post", fake_post)
        monkeypatch.setattr(
            httpx, "get", lambda *a, **kw: TestMultiImage.Resp({"status_code": "FINISHED"})
        )
        InstagramPublisher().publish(
            {"igUserId": "1", "accessToken": "t", "authMethod": "instagram_login"},
            PostPayload(text="hi", media_urls=["https://a/1.jpg", "https://a/2.jpg"]),
        )
        children = [c for c in calls if c[1].get("data", {}).get("is_carousel_item") == "true"]
        parent = [c for c in calls if c[1].get("data", {}).get("media_type") == "CAROUSEL"]
        assert len(children) == 2, calls
        assert len(parent) == 1 and parent[0][1]["data"]["children"] == "c1,c2"


class TestTikTokPrivacy:
    """An unaudited TikTok app may only post SELF_ONLY; a hardcoded public
    level fails before approval and stays private after it."""

    class Resp:
        status_code = 200

        def __init__(self, body):
            self._body = body

        def json(self):
            return self._body

    def _levels(self, monkeypatch, options):
        import httpx

        from godeye_engine.publishers.tiktok import TikTokPublisher

        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: TestTikTokPrivacy.Resp({"data": {"privacy_level_options": options}}),
        )
        return TikTokPublisher()._privacy_level({"Authorization": "Bearer t"})

    def test_prefers_public_when_audited(self, monkeypatch):
        assert self._levels(monkeypatch, ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]) == "PUBLIC_TO_EVERYONE"

    def test_falls_back_to_self_only_when_unaudited(self, monkeypatch):
        assert self._levels(monkeypatch, ["SELF_ONLY"]) == "SELF_ONLY"

    def test_self_only_when_the_query_fails(self, monkeypatch):
        import httpx

        from godeye_engine.publishers.tiktok import TikTokPublisher

        def boom(*a, **kw):
            raise httpx.ConnectError("down")

        monkeypatch.setattr(httpx, "post", boom)
        assert TikTokPublisher()._privacy_level({"Authorization": "Bearer t"}) == "SELF_ONLY"
