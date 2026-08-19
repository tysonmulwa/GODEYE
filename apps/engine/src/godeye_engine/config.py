"""Engine configuration, reads the repo-root .env (shared with the Node apps)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def find_root_env() -> Path | None:
    """Walk up from this file and from cwd looking for the repo-root .env."""
    for start in (Path(__file__).resolve(), Path.cwd()):
        node = start if start.is_dir() else start.parent
        for _ in range(8):
            candidate = node / ".env"
            if candidate.is_file():
                return candidate
            if node.parent == node:
                break
            node = node.parent
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=find_root_env(), env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = "postgresql://godeye:godeye_dev_password@localhost:5432/godeye"
    redis_url: str = "redis://localhost:6379/0"
    # No literal default. Both sides of this channel used to default to the same
    # repository-published string, so a service that forgot the variable was
    # "authenticated" by a value anyone can read on GitHub (S-5). Blank means
    # unconfigured, and every reader refuses rather than proceeding.
    engine_internal_secret: str = ""
    # Blank, not 64 zeros. The old default was format-valid on both sides, so a
    # workspace started from .env.example encrypted every platform credential
    # and every TOTP secret with a key in the repository (S-6).
    token_encryption_key: str = ""
    # Comma-separated keys being retired. Present only during a rotation.
    token_encryption_key_previous: str = ""
    # Seeds the *public* IndexNow key published on the customer's own website.
    # Separate from token_encryption_key on purpose: one secret must not both
    # encrypt credentials at rest and seed a value we hand out (S-6b).
    indexnow_key_secret: str = ""

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    openai_api_key: str = ""
    # Gemini (Google) can generate content text too, same GOOGLE_API_KEY as images
    gemini_model: str = "gemini-2.0-flash"

    # Image generation
    image_provider: str = "openai"  # openai | google
    # The OpenAI SDK defaults to a 600s timeout and 2 retries, so one unlucky
    # request can hold a worker slot for half an hour. The worker runs with
    # --concurrency=2, so two of those stall publishing as well as images.
    image_timeout_sec: float = 120.0
    # gpt-image-2 is the current flagship and undercuts both gpt-image-1 and
    # gpt-image-1.5 on price, so those two are never the right pick. The image
    # is the product here, it goes straight onto a customer's feed, so this
    # defaults to quality. Set OPENAI_IMAGE_MODEL=gpt-image-1-mini to cut cost
    # roughly 6x if volume ever outweighs fidelity.
    openai_image_model: str = "gpt-image-2"
    google_api_key: str = ""
    google_image_model: str = "imagen-3.0-generate-002"

    # Video generation
    openai_tts_model: str = "tts-1"
    ffmpeg_path: str = ""  # blank = find on PATH

    # Object storage. "s3" = MinIO/S3; "local" = filesystem served by the engine
    # (handy for dev without Docker/MinIO). Uploaded media persists either way.
    storage_backend: str = "s3"  # s3 | local
    media_dir: str = ""  # local backend dir (blank = <repo>/.media)
    engine_public_url: str = "http://localhost:8000"  # base for locally-served media
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "godeye"
    s3_secret_key: str = "godeye_dev_secret"
    s3_bucket: str = "godeye-media"
    s3_region: str = "us-east-1"
    # Public base URL for stored objects (MinIO bucket is download-public in dev)
    s3_public_url: str = "http://localhost:9000"

    # TikTok only lets an *audited* app publish anything more visible than
    # "Only me". Until the Content Posting API audit is approved this must stay
    # false, or every post is rejected with
    # unaudited_client_can_only_post_to_private_accounts. Flip it after approval
    # and posts go out at the most public level the creator allows.
    tiktok_audited: bool = False

    # Where a TikTok post lands.
    #   direct  publish straight to the profile, unattended
    #   drafts  send to the user's TikTok inbox to finish in the app
    #
    # Direct is the default because this is an automation product and drafts
    # require a person to open the app and press publish on every post; if
    # nobody is around, nothing goes out at all. Sound no longer depends on
    # that: photos are rendered into a slideshow carrying the workspace's own
    # track, so a direct post arrives with audio.
    #
    # Drafts remain worth choosing for one reason. TikTok's own music library
    # exists only inside their editor, so trending audio needs a person there.
    # It also avoids the unaudited SELF_ONLY limit, since the person publishes
    # rather than the app.
    tiktok_post_mode: str = "direct"  # direct | drafts

    # Reading a storefront that builds its catalogue in the browser needs a
    # browser. Deliberately not this container: the worker was killed for
    # memory encoding a five second video, and Chromium is heavier than
    # ffmpeg. Point this at a Browserless-compatible /content endpoint, one
    # container, self-hostable, and the hosted services speak it too.
    browser_render_url: str = ""
    browser_render_token: str = ""
    # "playwright" runs it in-process instead, for anyone who accepts the cost.
    browser_render_provider: str = ""

    # Needed by the hourly token-refresh sweep (B-7). TikTok access tokens live
    # 24 hours and TikTok rotates the refresh token on every use, so renewing one
    # needs the app credentials, not just the stored connection.
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""

    reddit_client_id: str = ""
    reddit_client_secret: str = ""
    reddit_user_agent: str = "godeye/0.1"

    engine_port: int = 8000

    # Railway sets this on every deploy. Reported by /health so "which build is
    # actually running" is one request rather than an inference from the shape
    # of the data it produced.
    railway_git_commit_sha: str = ""

    @property
    def sqlalchemy_url(self) -> str:
        # SQLAlchemy + psycopg3 needs the postgresql+psycopg:// scheme; strip
        # Prisma-style query params like ?schema=public that psycopg rejects.
        url = self.database_url.split("?")[0]
        return url.replace("postgresql://", "postgresql+psycopg://", 1)


    def require(self, field: str) -> str:
        """Read a secret, refusing blanks and values published in this repo.

        Lazy rather than a boot-time validator on the Settings class itself,
        because the engine imports config from tasks that legitimately need none
        of these (image rendering, for one). validate_config() below is the
        startup gate that makes a misconfiguration a failed boot instead of a
        failed request at 3am.
        """
        value = str(getattr(self, field, "") or "").strip()
        env_name = field.upper()
        if not value:
            raise InsecureConfigError(f"{env_name} is not set")
        if value in PUBLISHED_DEFAULTS and not allow_insecure_dev_defaults():
            raise InsecureConfigError(
                f"{env_name} is set to a value published in this repository"
            )
        if len(value) < 32 and not allow_insecure_dev_defaults():
            raise InsecureConfigError(f"{env_name} is shorter than 32 characters")
        return value


class InsecureConfigError(RuntimeError):
    """Configuration that would produce a working but publicly-known system."""


#: Values that appear in this repository, its .env.example, or its docs. A
#: published string can be perfectly random and still be public, so these are
#: refused by name rather than by entropy.
PUBLISHED_DEFAULTS = frozenset(
    {
        "dev-engine-secret",
        "godeye-verify",
        "godeye_dev_password",
        "godeye_dev_secret",
        "change-me",
        "changeme",
        "REPLACE_ME",
        "secret",
        "password",
    }
)


def allow_insecure_dev_defaults() -> bool:
    return (
        os.environ.get("NODE_ENV", "development") == "development"
        and os.environ.get("ALLOW_INSECURE_DEV_DEFAULTS") == "true"
    )


def validate_config() -> None:
    """Refuse to start on a missing, published, or entropy-free secret.

    Called from run.py and celery_app.py. Reads every secret once so a bad
    deploy fails its boot rather than passing a health check and failing hours
    later on the one endpoint that happened to need the value.
    """
    from .security import assert_strong_key  # local: security imports config

    settings = get_settings()
    problems: list[str] = []
    for field in ("engine_internal_secret", "indexnow_key_secret"):
        try:
            settings.require(field)
        except InsecureConfigError as e:
            problems.append(f"  - {e}")
    try:
        key = bytes.fromhex(settings.require("token_encryption_key"))
        if len(key) != 32:
            raise InsecureConfigError("TOKEN_ENCRYPTION_KEY must be 64 hex characters")
        assert_strong_key("TOKEN_ENCRYPTION_KEY", key)
    except (InsecureConfigError, ValueError) as e:
        problems.append(f"  - {e}")

    if settings.indexnow_key_secret and settings.indexnow_key_secret == settings.token_encryption_key:
        problems.append(
            "  - INDEXNOW_KEY_SECRET must not equal TOKEN_ENCRYPTION_KEY: the IndexNow "
            "key is published on the customer's website (S-6b)"
        )

    if problems:
        joined = ("\n").join(problems)
        raise InsecureConfigError(
            f"Refusing to start: {len(problems)} configuration problem(s)\n"
            f"{joined}\n\nSee docs/CONFIGURATION.md."
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
