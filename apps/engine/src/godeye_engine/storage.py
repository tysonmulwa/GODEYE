"""Object storage — stores media and returns a public URL.

Two backends, chosen by ``STORAGE_BACKEND``:

* ``s3``    — MinIO in dev, S3 in production. The dev bucket is download-public
              (see infra/docker/docker-compose.yml); in production front it with
              CloudFront or presigned URLs.
* ``local`` — the filesystem, served back by the engine at ``/media/<key>``.
              Lets media work in dev without Docker/MinIO. The URL is only
              reachable locally, so external platforms can't fetch it — use S3
              (or Supabase Storage) for real publishing.
"""

from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

import boto3
from botocore.client import Config

from .config import get_settings


def _is_local() -> bool:
    return get_settings().storage_backend.lower() == "local"


def local_media_dir() -> Path:
    """Directory backing the local storage backend (created on first use)."""
    settings = get_settings()
    base = (
        Path(settings.media_dir)
        if settings.media_dir
        else Path(__file__).resolve().parents[3] / ".media"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def local_path(key: str) -> Path:
    return local_media_dir() / key


@lru_cache
def _client():
    settings = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket() -> None:
    if _is_local():
        local_media_dir()
        return
    settings = get_settings()
    client = _client()
    try:
        client.head_bucket(Bucket=settings.s3_bucket)
    except Exception:  # noqa: BLE001 — create on first use if missing
        client.create_bucket(Bucket=settings.s3_bucket)


def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return its public URL."""
    if _is_local():
        path = local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return public_url(key)

    settings = get_settings()
    _client().put_object(
        Bucket=settings.s3_bucket,
        Key=key,
        Body=io.BytesIO(data),
        ContentType=content_type,
        ContentLength=len(data),
    )
    return public_url(key)


def download_bytes(key: str) -> bytes:
    if _is_local():
        return local_path(key).read_bytes()
    settings = get_settings()
    response = _client().get_object(Bucket=settings.s3_bucket, Key=key)
    return response["Body"].read()


def public_url(key: str) -> str:
    settings = get_settings()
    if _is_local():
        base = settings.engine_public_url.rstrip("/")
        return f"{base}/media/{key}"
    base = settings.s3_public_url.rstrip("/")
    return f"{base}/{settings.s3_bucket}/{key}"
