"""Object storage, stores media and returns a public URL.

Two backends, chosen by ``STORAGE_BACKEND``:

* ``s3``   . MinIO in dev, S3 in production. The dev bucket is download-public
              (see infra/docker/docker-compose.yml); in production front it with
              CloudFront or presigned URLs.
* ``local``, the filesystem, served back by the engine at ``/media/<key>``.
              Lets media work in dev without Docker/MinIO. The URL is only
              reachable locally, so external platforms can't fetch it, use S3
              (or Supabase Storage) for real publishing.
"""

from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

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
    except Exception:  # noqa: BLE001, create on first use if missing
        client.create_bucket(Bucket=settings.s3_bucket)


def describe_upload_failure(e: Exception) -> str:
    """Turn a boto3 failure into something that names the misconfiguration.

    botocore prints an unrecognised response as "An error occurred () ... : "
    with the code and message empty, which says nothing. The HTTP status does
    say something, and the two cases are opposites, so this reads the status
    rather than the emptiness. Verified against a real Supabase project:

      403 + empty code  the endpoint is right and the credentials were refused
      404 + code "404"  the request never reached the S3 API, so the endpoint
                        is missing its /storage/v1/s3 path

    Guessing that empty meant "wrong endpoint" would have sent someone to
    change the one setting that was already correct.

    Endpoint and bucket are named here; credentials never are.
    """
    settings = get_settings()
    endpoint = settings.s3_endpoint.rstrip("/")
    detail = str(e)
    status = None
    code = None
    if isinstance(e, ClientError):
        code = (e.response.get("Error") or {}).get("Code") or None
        status = (e.response.get("ResponseMetadata") or {}).get("HTTPStatusCode")

    lines = [
        f"Upload to {endpoint} (bucket {settings.s3_bucket!r}) failed",
        f"  HTTP status: {status if status is not None else 'unknown'}",
        f"  S3 error code: {code or '(none returned)'}",
        f"  raw: {detail[:200]}",
    ]

    # Specific codes first: NoSuchBucket also arrives as a 404, and the generic
    # endpoint advice below would otherwise shadow it.
    if code == "NoSuchBucket":
        lines += ["", f"Create the bucket {settings.s3_bucket!r}, or correct S3_BUCKET."]
    elif status == 403 or code in ("SignatureDoesNotMatch", "InvalidAccessKeyId", "AccessDenied"):
        lines += [
            "",
            "403 means the endpoint is correct and the credentials were refused.",
            "S3 access keys are a separate credential from the project API keys:",
            "in Supabase they come from Storage settings, not from the anon or",
            "service-role keys. S3_REGION must also match the project's region,",
            "or the request signature will not verify.",
            "The engine API uploads successfully, so copy S3_ACCESS_KEY,",
            "S3_SECRET_KEY and S3_REGION from that service to this one.",
        ]
    elif status == 404:
        lines += [
            "",
            "404 means the request never reached an S3 API, so the endpoint is",
            "missing its API path. Supabase Storage expects",
            "https://<project-ref>.supabase.co/storage/v1/s3 rather than the",
            "bare project URL.",
        ]
    elif code == "NoSuchBucket":
        lines += ["", f"Create the bucket {settings.s3_bucket!r}, or correct S3_BUCKET."]

    return "\n".join(lines)


def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return its public URL."""
    if _is_local():
        path = local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return public_url(key)

    settings = get_settings()
    try:
        _client().put_object(
            Bucket=settings.s3_bucket,
            Key=key,
            Body=io.BytesIO(data),
            ContentType=content_type,
            ContentLength=len(data),
        )
    except Exception as e:  # noqa: BLE001, re-raised with the detail botocore drops
        raise RuntimeError(describe_upload_failure(e)) from e
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
