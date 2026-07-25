"""Storage URL construction (no network)."""

import pytest

from godeye_engine import storage
from godeye_engine.config import get_settings


@pytest.fixture(autouse=True)
def storage_settings(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "s3")  # pin: the repo .env may set local
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


def test_local_backend_serves_via_engine(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("ENGINE_PUBLIC_URL", "http://localhost:8000")
    get_settings.cache_clear()
    url = storage.public_url("org1/uploads/pic.png")
    assert url == "http://localhost:8000/media/org1/uploads/pic.png"


def test_local_backend_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("MEDIA_DIR", str(tmp_path))
    get_settings.cache_clear()
    storage.upload_bytes("org1/uploads/x.txt", b"hello", "text/plain")
    assert storage.download_bytes("org1/uploads/x.txt") == b"hello"
    assert (tmp_path / "org1" / "uploads" / "x.txt").read_bytes() == b"hello"
