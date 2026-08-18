"""Payload assembly for the publish task (pure logic, no DB)."""

from godeye_engine.tasks.scheduler import _build_payload

CONTENT = {
    "title": "Launch",
    "body": "Canonical body",
    "hashtags": ["coffee", "launch"],
    "variants": {
        "TELEGRAM": {"body": "Telegram variant", "hashtags": ["tg"]},
        "REDDIT": {"body": "Reddit variant", "hashtags": ["nope"]},
    },
}


def test_uses_platform_variant_and_appends_hashtags():
    payload = _build_payload(CONTENT, "TELEGRAM")
    assert payload.text.startswith("Telegram variant")
    assert "#tg" in payload.text
    assert payload.title == "Launch"


def test_falls_back_to_canonical_body():
    payload = _build_payload(CONTENT, "DISCORD")
    assert payload.text.startswith("Canonical body")
    assert "#coffee" in payload.text and "#launch" in payload.text


def test_reddit_never_gets_hashtags():
    payload = _build_payload(CONTENT, "REDDIT")
    assert payload.text == "Reddit variant"
    assert "#" not in payload.text


def test_handles_missing_variants():
    content = {"title": None, "body": "Plain", "hashtags": [], "variants": None}
    payload = _build_payload(content, "TELEGRAM")
    assert payload.text == "Plain"


AB_CONTENT = {
    "title": "Launch",
    "body": "Canonical",
    "hashtags": ["x"],
    "variants": {"TELEGRAM": {"body": "TG variant", "hashtags": []}},
    "abVariants": {
        "A": {"body": "Angle A", "hashtags": ["a"]},
        "B": {"body": "Angle B", "hashtags": []},
    },
}


def test_ab_variant_key_selects_ab_body():
    payload_a = _build_payload(AB_CONTENT, "TELEGRAM", "A")
    assert payload_a.text.startswith("Angle A")
    assert "#a" in payload_a.text

    payload_b = _build_payload(AB_CONTENT, "TELEGRAM", "B")
    assert payload_b.text.startswith("Angle B")


def test_no_variant_key_falls_back_to_platform_variant():
    payload = _build_payload(AB_CONTENT, "TELEGRAM", None)
    assert payload.text.startswith("TG variant")


def test_unknown_variant_key_falls_back():
    payload = _build_payload(AB_CONTENT, "TELEGRAM", "C")
    assert payload.text.startswith("TG variant")


def test_media_urls_passed_through():
    payload = _build_payload(
        CONTENT, "TELEGRAM", None, ["http://minio/godeye-media/x.png"]
    )
    assert payload.media_urls == ["http://minio/godeye-media/x.png"]


def test_no_media_urls_is_none():
    payload = _build_payload(CONTENT, "TELEGRAM", None, [])
    assert payload.media_urls is None


def test_video_urls_passed_separately():
    payload = _build_payload(CONTENT, "TELEGRAM", None, ["img.png"], ["vid.mp4"])
    assert payload.media_urls == ["img.png"]
    assert payload.video_urls == ["vid.mp4"]
