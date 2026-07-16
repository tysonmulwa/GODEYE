"""Object storage — uploads media to MinIO/S3 and returns a public URL.

In dev the MinIO bucket is created with public download access
(see infra/docker/docker-compose.yml), so the returned URL is directly
viewable. In production, front the bucket with CloudFront or issue presigned
URLs instead.
"""

from __future__ import annotations

import io
from functools import lru_cache

import boto3
from botocore.client import Config

from .config import get_settings


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
    settings = get_settings()
    client = _client()
    try:
        client.head_bucket(Bucket=settings.s3_bucket)
    except Exception:  # noqa: BLE001 — create on first use if missing
        client.create_bucket(Bucket=settings.s3_bucket)


def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return its public URL."""
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
    settings = get_settings()
    response = _client().get_object(Bucket=settings.s3_bucket, Key=key)
    return response["Body"].read()


def public_url(key: str) -> str:
    settings = get_settings()
    base = settings.s3_public_url.rstrip("/")
    return f"{base}/{settings.s3_bucket}/{key}"
