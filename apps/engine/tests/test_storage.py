"""Storage URL construction (no network)."""

import pytest

from godeye_engine import storage
from godeye_engine.config import get_settings


@pytest.fixture(autouse=True)
def storage_settings(monkeypatch):
    monkeypatch.setenv("S3_PUBLIC_URL", "http://localhost:9000")
    monkeypatch.setenv("S3_BUCKET", "godeye-media")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_public_url_format():
    url = storage.public_url("org1/generated/abc.png")
    assert url == "http://localhost:9000/godeye-media/org1/generated/abc.png"


def test_public_url_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("S3_PUBLIC_URL", "https://cdn.example.com/")
    get_settings.cache_clear()
    url = storage.public_url("k.png")
    assert url == "https://cdn.example.com/godeye-media/k.png"
