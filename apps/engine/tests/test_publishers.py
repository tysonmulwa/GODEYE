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
        with pytest.raises(PublishError, match="TIKTOK"):
            get_publisher("TIKTOK")


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
    def _capture(monkeypatch):
        """Record the URLs the publisher calls, returning plausible responses."""
        calls: list[str] = []

        class Resp:
            status_code = 200

            def json(self):
                return {"id": "media-1"}

        def fake_post(self, url, **kwargs):
            calls.append(url)
            return Resp()

        monkeypatch.setattr(InstagramPublisher, "_post", fake_post)
        return calls

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
