"""Engine configuration — reads the repo-root .env (shared with the Node apps)."""

from __future__ import annotations

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
    engine_internal_secret: str = "dev-engine-secret"
    token_encryption_key: str = "0" * 64

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    openai_api_key: str = ""
    # Gemini (Google) can generate content text too — same GOOGLE_API_KEY as images
    gemini_model: str = "gemini-2.0-flash"

    # Image generation
    image_provider: str = "openai"  # openai | google
    # The OpenAI SDK defaults to a 600s timeout and 2 retries, so one unlucky
    # request can hold a worker slot for half an hour. The worker runs with
    # --concurrency=2, so two of those stall publishing as well as images.
    image_timeout_sec: float = 120.0
    # gpt-image-2 is the current flagship and undercuts both gpt-image-1 and
    # gpt-image-1.5 on price, so those two are never the right pick. The image
    # is the product here — it goes straight onto a customer's feed — so this
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
