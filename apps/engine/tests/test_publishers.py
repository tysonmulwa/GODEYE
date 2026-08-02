"""Publisher adapter tests against mocked HTTP responses."""

from unittest.mock import MagicMock

import httpx

import pytest

from godeye_engine.publishers import get_publisher
from godeye_engine.publishers.base import PostPayload, PublishError
from godeye_engine.publishers.linkedin import LinkedInPublisher
from godeye_engine.publishers.meta import InstagramPublisher
from godeye_engine.publishers.telegram import TelegramPublisher
from godeye_engine.publishers.x import XPublisher
from godeye_engine.publishers import tiktok as tiktok_mod
from godeye_engine.publishers.tiktok import TikTokPublisher
from godeye_engine.config import get_settings


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


class TestTikTokPrivacyLevel:
    """Every post was rejected with
    unaudited_client_can_only_post_to_private_accounts while the account was
    already private, because the account was never what TikTok was refusing."""

    HEADERS = {"Authorization": "Bearer t"}

    def test_an_unaudited_app_always_asks_for_self_only(self, monkeypatch):
        """creator_info describes what the creator's account allows. It says
        nothing about what an unaudited app may publish, and taking its most
        public option is what caused the rejection."""
        monkeypatch.setenv("TIKTOK_AUDITED", "false")
        get_settings.cache_clear()
        called = []
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: called.append(a) or http_response(200, {}),
        )
        assert TikTokPublisher()._privacy_level(self.HEADERS) == "SELF_ONLY"
        assert not called, "an unaudited app need not ask; the answer cannot change"
        get_settings.cache_clear()

    def test_an_audited_app_takes_the_most_public_option(self, monkeypatch):
        monkeypatch.setenv("TIKTOK_AUDITED", "true")
        get_settings.cache_clear()
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: http_response(
                200,
                {"data": {"privacy_level_options": ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]}},
            ),
        )
        assert TikTokPublisher()._privacy_level(self.HEADERS) == "PUBLIC_TO_EVERYONE"
        get_settings.cache_clear()

    def test_an_audited_app_falls_back_when_the_account_offers_nothing_public(
        self, monkeypatch
    ):
        monkeypatch.setenv("TIKTOK_AUDITED", "true")
        get_settings.cache_clear()
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: http_response(200, {"data": {"privacy_level_options": ["SELF_ONLY"]}}),
        )
        assert TikTokPublisher()._privacy_level(self.HEADERS) == "SELF_ONLY"
        get_settings.cache_clear()

    def test_the_audit_error_explains_itself(self):
        """TikTok's wording blames the account and sends people to change a
        setting that cannot help."""
        response = http_response(
            403, {"error": {"code": "unaudited_client_can_only_post_to_private_accounts"}}
        )
        detail = str(TikTokPublisher()._fail_tiktok(response, "TikTok (photo init)"))
        # The error name is literal: an unaudited app posts only to an account
        # that is itself Private, and a Business account cannot be one.
        assert "set to Private" in detail
        assert "Business accounts" in detail
        assert "already sends the post as SELF_ONLY" in detail

    def test_other_errors_are_left_alone(self):
        response = http_response(400, {"error": {"code": "invalid_param"}})
        detail = str(TikTokPublisher()._fail_tiktok(response, "TikTok (init)"))
        assert "invalid_param" in detail
        assert "Content Posting audit" not in detail


class TestFacebookRevokedPermissions:
    """A Page that had been publishing for days stopped mid-afternoon. Its token
    predated a change to the app's permissions in the Meta dashboard, and tokens
    issued before such a change lose what was removed. A Page reconnected after
    the change kept working, which is what identified it."""

    from godeye_engine.publishers.meta import FacebookPublisher as _FB

    REVOKED = {
        "error": {
            "message": (
                "Any of the pages_read_engagement, pages_manage_metadata, "
                "pages_read_user_content, pages_manage_ads, pages_show_list or "
                "pages_messaging permission(s) must be granted before "
                "impersonating a user's page."
            ),
            "type": "OAuthException",
            "code": 190,
        }
    }

    def test_the_fix_is_named_instead_of_the_six_permissions(self):
        detail = str(self._FB()._fail_page(http_response(400, self.REVOKED), "Facebook"))
        assert "Reconnect this Page from Connections" in detail
        assert "cannot be repaired" in detail

    def test_a_real_content_rejection_is_left_alone(self):
        """Blaming the token for a bad image URL would send someone to redo an
        OAuth flow that was never the problem."""
        response = http_response(
            400, {"error": {"message": "The image is too large", "code": 324}}
        )
        detail = str(self._FB()._fail_page(response, "Facebook"))
        assert "image is too large" in detail
        assert "Reconnect this Page" not in detail


class TestTikTokPhotoFormat:
    """A generated PNG was accepted at init, fetched, and only then failed the
    whole post with file_format_check_failed. TikTok's photo endpoint takes
    JPEG."""

    CREDS = {"accessToken": "t"}

    def test_a_png_is_refused_before_the_api_call(self, monkeypatch):
        called = []
        monkeypatch.setattr(
            TikTokPublisher, "_post", lambda self, *a, **kw: called.append(a)
        )
        with pytest.raises(PublishError, match="only accepts JPEG"):
            TikTokPublisher().publish(
                self.CREDS,
                PostPayload(text="hi", media_urls=["https://cdn/generated/x.png"]),
            )
        assert not called, "should not spend a request to be told what we know"

    def test_a_signed_url_is_judged_on_its_path(self):
        """Storage URLs carry query strings; the extension is before the "?"."""
        with pytest.raises(PublishError, match="only accepts JPEG"):
            TikTokPublisher().publish(
                self.CREDS,
                PostPayload(text="hi", media_urls=["https://cdn/x.png?token=abc&v=2"]),
            )

    def test_jpeg_is_allowed_through(self, monkeypatch):
        reached = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, *a, **kw: reached.append(1) or http_response(200, {"data": {}}),
        )
        monkeypatch.setattr(TikTokPublisher, "_privacy_level", lambda self, h: "SELF_ONLY")
        with pytest.raises(PublishError, match="did not return a publish_id"):
            TikTokPublisher().publish(
                self.CREDS,
                PostPayload(text="hi", media_urls=["https://cdn/x.jpg"]),
            )
        assert reached, "a JPEG must reach the API"

    def test_the_photo_failure_does_not_talk_about_video(self, monkeypatch):
        """"TikTok rejected the video" on a photo post sends people to check a
        file they never sent."""
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: http_response(
                200,
                {"data": {"status": "FAILED", "fail_reason": "file_format_check_failed"}},
            ),
        )
        with pytest.raises(PublishError) as caught:
            TikTokPublisher()._await_publish(
                "pid", {"Authorization": "Bearer t"}, kind="photo"
            )
        detail = str(caught.value)
        assert "video" not in detail
        assert "JPEG" in detail

    def test_a_video_failure_still_says_video(self, monkeypatch):
        monkeypatch.setattr(
            httpx, "post",
            lambda *a, **kw: http_response(
                200, {"data": {"status": "FAILED", "fail_reason": "duration_check_failed"}}
            ),
        )
        with pytest.raises(PublishError, match="rejected the video"):
            TikTokPublisher()._await_publish("pid", {"Authorization": "Bearer t"})


class TestTikTokDraftMode:
    """TikTok's music catalogue only exists inside their editor, so the
    suggested song appears when a person opens the post there. A draft is what
    puts them in it. It also carries no privacy_level, so an unaudited app can
    send one and the person publishes it publicly themselves."""

    CREDS = {"accessToken": "t"}

    def _mode(self, monkeypatch, post_mode: str, audited: str = "false") -> bool:
        monkeypatch.setenv("TIKTOK_POST_MODE", post_mode)
        monkeypatch.setenv("TIKTOK_AUDITED", audited)
        get_settings.cache_clear()
        try:
            return TikTokPublisher()._to_drafts()
        finally:
            get_settings.cache_clear()

    def test_auto_uses_drafts_until_the_app_is_audited(self, monkeypatch):
        assert self._mode(monkeypatch, "auto", audited="false") is True

    def test_auto_publishes_directly_once_audited(self, monkeypatch):
        assert self._mode(monkeypatch, "auto", audited="true") is False

    def test_explicit_settings_win_over_audit_state(self, monkeypatch):
        assert self._mode(monkeypatch, "direct", audited="false") is False
        assert self._mode(monkeypatch, "drafts", audited="true") is True

    def test_a_photo_draft_sends_no_privacy_level(self, monkeypatch):
        """privacy_level is what an unaudited app is not allowed to raise. A
        draft has none, which is why it gets past the restriction."""
        captured = {}
        monkeypatch.setenv("TIKTOK_POST_MODE", "drafts")
        get_settings.cache_clear()
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: captured.update(url=url, json=kw.get("json"))
            or http_response(200, {"data": {"publish_id": "p1"}}),
        )
        monkeypatch.setattr(TikTokPublisher, "_await_publish", lambda *a, **kw: None)
        TikTokPublisher().publish(
            self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
        )
        assert captured["json"]["post_mode"] == "MEDIA_UPLOAD"
        assert "privacy_level" not in captured["json"]["post_info"]
        get_settings.cache_clear()

    def test_a_direct_photo_post_still_carries_privacy_level(self, monkeypatch):
        captured = {}
        monkeypatch.setenv("TIKTOK_POST_MODE", "direct")
        get_settings.cache_clear()
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: captured.update(json=kw.get("json"))
            or http_response(200, {"data": {"publish_id": "p1"}}),
        )
        monkeypatch.setattr(TikTokPublisher, "_privacy_level", lambda self, h: "SELF_ONLY")
        monkeypatch.setattr(TikTokPublisher, "_await_publish", lambda *a, **kw: None)
        TikTokPublisher().publish(
            self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
        )
        assert captured["json"]["post_mode"] == "DIRECT_POST"
        assert captured["json"]["post_info"]["privacy_level"] == "SELF_ONLY"
        get_settings.cache_clear()


class TestTikTokScopeFallback:
    """Drafts need video.upload; direct posting needs video.publish. They are
    separate grants, not a hierarchy. Switching the default to drafts broke
    accounts connected before video.upload was ever requested, which had been
    publishing fine the day before."""

    CREDS = {"accessToken": "t"}
    DENIED = {"error": {"code": "scope_not_authorized", "message": "not authorized"}}

    def _run(self, monkeypatch, responses: list):
        monkeypatch.setenv("TIKTOK_POST_MODE", "drafts")
        get_settings.cache_clear()
        sent = []

        def fake_post(self, url, **kw):
            sent.append(kw.get("json") or {})
            return responses[len(sent) - 1]

        monkeypatch.setattr(TikTokPublisher, "_post", fake_post)
        monkeypatch.setattr(TikTokPublisher, "_privacy_level", lambda self, h: "SELF_ONLY")
        monkeypatch.setattr(TikTokPublisher, "_await_publish", lambda *a, **kw: None)
        try:
            TikTokPublisher().publish(
                self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
            )
        finally:
            get_settings.cache_clear()
        return sent

    def test_a_denied_draft_falls_back_to_publishing_directly(self, monkeypatch):
        """The post still goes out. Losing the suggested song beats losing the
        post over a permission the person can restore later."""
        sent = self._run(
            monkeypatch,
            [
                http_response(401, self.DENIED),
                http_response(200, {"data": {"publish_id": "p1"}}),
            ],
        )
        assert len(sent) == 2, "expected a retry"
        assert sent[0]["post_mode"] == "MEDIA_UPLOAD"
        assert sent[1]["post_mode"] == "DIRECT_POST"
        assert sent[1]["post_info"]["privacy_level"] == "SELF_ONLY"

    def test_a_working_draft_is_not_retried(self, monkeypatch):
        sent = self._run(monkeypatch, [http_response(200, {"data": {"publish_id": "p1"}})])
        assert len(sent) == 1
        assert sent[0]["post_mode"] == "MEDIA_UPLOAD"

    def test_other_failures_do_not_trigger_the_fallback(self, monkeypatch):
        """Retrying a rejected image as a direct post would just fail twice."""
        monkeypatch.setenv("TIKTOK_POST_MODE", "drafts")
        get_settings.cache_clear()
        sent = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: sent.append(1)
            or http_response(400, {"error": {"code": "invalid_param"}}),
        )
        with pytest.raises(PublishError):
            TikTokPublisher().publish(
                self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
            )
        assert len(sent) == 1
        get_settings.cache_clear()

    def test_the_scope_error_says_to_reconnect(self):
        detail = str(
            TikTokPublisher()._fail_tiktok(
                http_response(401, self.DENIED), "TikTok (photo init)"
            )
        )
        assert "Reconnect TikTok from" in detail
        assert "cannot be extended, only replaced" in detail


class TestTikTokSlideshow:
    """TikTok's API cannot add music to a post and its library only exists in
    the app, so a direct photo post is silent and a draft needs a person. For an
    automation product neither works, so the slideshow is built here: photos
    become a video that already carries the workspace's track."""

    CREDS = {"accessToken": "t"}
    PHOTOS = ["https://cdn/a.jpg", "https://cdn/b.jpg"]

    def _publisher(self, monkeypatch, built: bytes | None = b"MP4BYTES"):
        import godeye_engine.media.slideshow as ss

        monkeypatch.setattr(
            tiktok_mod, "download_media", lambda url: (b"raw", "image/jpeg")
        )
        if built is None:
            monkeypatch.setattr(
                ss, "build_slideshow",
                lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("ffmpeg missing")),
            )
        else:
            monkeypatch.setattr(ss, "build_slideshow", lambda *a, **kw: built)
        monkeypatch.setattr(TikTokPublisher, "_privacy_level", lambda self, h: "SELF_ONLY")
        monkeypatch.setattr(TikTokPublisher, "_upload", lambda *a, **kw: None)
        monkeypatch.setattr(TikTokPublisher, "_await_publish", lambda *a, **kw: None)

    def test_photos_with_a_track_are_posted_as_video(self, monkeypatch):
        """The whole point: unattended, and it has sound."""
        self._publisher(monkeypatch)
        seen = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: seen.append(url)
            or http_response(200, {"data": {"publish_id": "p1", "upload_url": "https://up"}}),
        )
        TikTokPublisher().publish(
            self.CREDS,
            PostPayload(text="hi", media_urls=self.PHOTOS, music_url="https://cdn/track.mp3"),
        )
        assert any("video/init" in u for u in seen), seen
        assert not any("content/init" in u for u in seen), "should not be a photo post"

    def test_without_a_track_it_stays_a_photo_post(self, monkeypatch):
        """No music means a slideshow would be silent too, and a photo carousel
        is the better-looking silent post."""
        self._publisher(monkeypatch)
        seen = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: seen.append(url)
            or http_response(200, {"data": {"publish_id": "p1"}}),
        )
        TikTokPublisher().publish(self.CREDS, PostPayload(text="hi", media_urls=self.PHOTOS))
        assert any("content/init" in u for u in seen), seen

    def test_a_failed_render_falls_back_rather_than_losing_the_post(self, monkeypatch):
        """ffmpeg missing on the worker must cost the sound, not the post."""
        self._publisher(monkeypatch, built=None)
        seen = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: seen.append(url)
            or http_response(200, {"data": {"publish_id": "p1"}}),
        )
        TikTokPublisher().publish(
            self.CREDS,
            PostPayload(text="hi", media_urls=self.PHOTOS, music_url="https://cdn/track.mp3"),
        )
        assert any("content/init" in u for u in seen), "expected the photo fallback"

    def test_every_fallback_to_silence_says_why(self, monkeypatch, caplog):
        """A post that goes out silent is indistinguishable from one that was
        never meant to have sound. Two paths — a failed image fetch and a failed
        track fetch — abandoned the slideshow without logging anything, which is
        what made this take hours to see."""
        import logging

        for broken, expected in [("https://cdn/a.jpg", "image"), ("https://cdn/track.mp3", "track")]:
            self._publisher(monkeypatch)
            monkeypatch.setattr(
                tiktok_mod,
                "download_media",
                lambda url, _b=broken: None if url == _b else (b"raw", "image/jpeg"),
            )
            monkeypatch.setattr(
                TikTokPublisher, "_post",
                lambda self, url, **kw: http_response(200, {"data": {"publish_id": "p1"}}),
            )
            caplog.clear()
            with caplog.at_level(logging.WARNING):
                TikTokPublisher().publish(
                    self.CREDS,
                    PostPayload(
                        text="hi", media_urls=self.PHOTOS, music_url="https://cdn/track.mp3"
                    ),
                )
            assert any(expected in r.getMessage() for r in caplog.records), (
                f"a failed {expected} fetch fell back to a silent post without saying so"
            )

    def test_direct_is_the_default_so_posts_go_out_unattended(self, monkeypatch):
        monkeypatch.delenv("TIKTOK_POST_MODE", raising=False)
        monkeypatch.delenv("TIKTOK_AUDITED", raising=False)
        get_settings.cache_clear()
        try:
            assert TikTokPublisher()._to_drafts() is False
        finally:
            get_settings.cache_clear()


class TestTikTokUnauditedRetry:
    """TIKTOK_AUDITED is a claim about the outside world that nothing here can
    verify. Set to true before approval lands, every post failed, and the error
    blamed the account. TikTok is the one that decides, so its refusal is
    treated as the answer."""

    CREDS = {"accessToken": "t"}
    UNAUDITED = {
        "error": {"code": "unaudited_client_can_only_post_to_private_accounts"}
    }

    def _run(self, monkeypatch, responses, audited="true"):
        monkeypatch.setenv("TIKTOK_POST_MODE", "direct")
        monkeypatch.setenv("TIKTOK_AUDITED", audited)
        get_settings.cache_clear()
        sent = []

        def fake_post(self, url, **kw):
            sent.append(kw.get("json") or {})
            return responses[min(len(sent) - 1, len(responses) - 1)]

        monkeypatch.setattr(TikTokPublisher, "_post", fake_post)
        monkeypatch.setattr(
            TikTokPublisher, "_privacy_level", lambda self, h: "PUBLIC_TO_EVERYONE"
        )
        monkeypatch.setattr(TikTokPublisher, "_await_publish", lambda *a, **kw: None)
        try:
            TikTokPublisher().publish(
                self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
            )
        finally:
            get_settings.cache_clear()
        return sent

    def test_a_refused_public_post_is_retried_privately(self, monkeypatch):
        sent = self._run(
            monkeypatch,
            [
                http_response(403, self.UNAUDITED),
                http_response(200, {"data": {"publish_id": "p1"}}),
            ],
        )
        assert len(sent) == 2, "expected a retry"
        assert sent[0]["post_info"]["privacy_level"] == "PUBLIC_TO_EVERYONE"
        assert sent[1]["post_info"]["privacy_level"] == "SELF_ONLY"

    def test_a_post_that_is_accepted_is_not_retried(self, monkeypatch):
        sent = self._run(monkeypatch, [http_response(200, {"data": {"publish_id": "p1"}})])
        assert len(sent) == 1

    def test_other_refusals_do_not_trigger_it(self, monkeypatch):
        """Downgrading privacy would not fix a bad image, and would quietly make
        a post private for the wrong reason."""
        monkeypatch.setenv("TIKTOK_POST_MODE", "direct")
        get_settings.cache_clear()
        sent = []
        monkeypatch.setattr(
            TikTokPublisher, "_post",
            lambda self, url, **kw: sent.append(1)
            or http_response(400, {"error": {"code": "invalid_param"}}),
        )
        monkeypatch.setattr(TikTokPublisher, "_privacy_level", lambda self, h: "SELF_ONLY")
        with pytest.raises(PublishError):
            TikTokPublisher().publish(
                self.CREDS, PostPayload(text="hi", media_urls=["https://cdn/x.jpg"])
            )
        assert len(sent) == 1
        get_settings.cache_clear()
