"""Scheduler — Celery Beat scans due posts; publish tasks push them to platforms."""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import and_, or_, select, update

from ..celery_app import app
from ..db import (
    ContentItem,
    MediaAsset,
    Organization,
    ScheduledPost,
    SocialConnection,
    get_session,
    utcnow,
)
from ..events import publish_event
from ..publishers import PublishError, get_publisher
from ..publishers.base import PostPayload
from ..security import decrypt_credentials

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
RETRY_DELAY_MINUTES = 2
LOCK_TIMEOUT_MINUTES = 5

# When an org requires approval, a due post only dispatches once its content
# cleared review. SCHEDULED/PUBLISHED imply approval happened earlier (manual
# scheduling is gated in the API; PUBLISHED appears when a sibling post ran first).
APPROVAL_SATISFIED_STATUSES = ("APPROVED", "SCHEDULED", "PUBLISHED")


def due_posts_query(now, stale_lock):
    """Selects due, unclaimed posts — approval-gated orgs only release reviewed content."""
    return (
        select(ScheduledPost.c.id)
        .select_from(
            ScheduledPost.join(
                ContentItem, ContentItem.c.id == ScheduledPost.c.contentItemId
            ).join(Organization, Organization.c.id == ScheduledPost.c.orgId)
        )
        .where(
            and_(
                ScheduledPost.c.status == "PENDING",
                ScheduledPost.c.scheduledAt <= now,
                or_(ScheduledPost.c.lockedAt.is_(None), ScheduledPost.c.lockedAt < stale_lock),
                or_(
                    Organization.c.requireApproval.is_(False),
                    ContentItem.c.status.in_(APPROVAL_SATISFIED_STATUSES),
                ),
            )
        )
        .with_for_update(skip_locked=True, of=ScheduledPost)
        .limit(20)
    )


@app.task(name="godeye_engine.tasks.scheduler.dispatch_due_posts")
def dispatch_due_posts() -> int:
    """Claim due PENDING posts (row-locked, skip-locked) and dispatch publishing."""
    now = utcnow()
    stale_lock = now - timedelta(minutes=LOCK_TIMEOUT_MINUTES)

    with get_session() as session:
        rows = session.execute(due_posts_query(now, stale_lock)).fetchall()

        ids = [r.id for r in rows]
        if ids:
            session.execute(
                update(ScheduledPost)
                .where(ScheduledPost.c.id.in_(ids))
                .values(status="PROCESSING", lockedAt=now, updatedAt=now)
            )
        session.commit()

    for post_id in ids:
        publish_post.delay(post_id)
    if ids:
        logger.info("Dispatched %d due post(s)", len(ids))
    return len(ids)


@app.task(name="godeye_engine.tasks.scheduler.publish_post")
def publish_post(scheduled_post_id: str) -> dict:
    with get_session() as session:
        post = session.execute(
            select(ScheduledPost).where(ScheduledPost.c.id == scheduled_post_id)
        ).mappings().first()
        if post is None or post["status"] != "PROCESSING":
            return {"status": "skipped"}

        content = session.execute(
            select(ContentItem).where(ContentItem.c.id == post["contentItemId"])
        ).mappings().first()
        connection = session.execute(
            select(SocialConnection).where(SocialConnection.c.id == post["connectionId"])
        ).mappings().first()
        media = session.execute(
            select(MediaAsset.c.url, MediaAsset.c.kind)
            .where(
                MediaAsset.c.contentItemId == post["contentItemId"],
                MediaAsset.c.kind.in_(["IMAGE", "VIDEO"]),
                MediaAsset.c.url.isnot(None),
            )
            .order_by(MediaAsset.c.createdAt.asc())
        ).fetchall()

    if content is None or connection is None:
        _finish(scheduled_post_id, post["orgId"], error="Content or connection no longer exists")
        return {"status": "FAILED"}

    platform = connection["platform"]
    media_urls = [row.url for row in media if row.kind == "IMAGE"]
    video_urls = [row.url for row in media if row.kind == "VIDEO"]
    payload = _build_payload(
        dict(content), platform, post.get("variantKey"), media_urls, video_urls
    )

    try:
        try:
            credentials = decrypt_credentials(connection["encryptedCredentials"])
        except Exception as e:  # noqa: BLE001
            # AES-GCM raises InvalidTag, whose str() is empty — a failure with no
            # message at all. Almost always TOKEN_ENCRYPTION_KEY differing from
            # the one the API encrypted with, so say that instead of nothing.
            raise PublishError(
                "Could not decrypt the stored credentials for this connection. "
                "TOKEN_ENCRYPTION_KEY on the engine must match the API's; if it "
                "changed, reconnect the account."
            ) from e
        result = get_publisher(platform).publish(credentials, payload)
    except Exception as e:  # noqa: BLE001
        attempts = post["attempts"] + 1
        permanent = isinstance(e, PublishError) or attempts >= MAX_ATTEMPTS
        # Never store a blank error: some exceptions (InvalidTag) stringify to "".
        detail = str(e).strip() or f"{type(e).__name__} (no message)"
        logger.warning(
            "Publish %s failed (attempt %d, permanent=%s): %s",
            scheduled_post_id, attempts, permanent, detail,
        )
        _record_failure(scheduled_post_id, post["orgId"], connection["id"], detail, attempts, permanent)
        return {"status": "FAILED" if permanent else "RETRYING"}

    _finish(
        scheduled_post_id,
        post["orgId"],
        external_post_id=result.external_post_id,
        external_post_url=result.external_post_url,
        content_item_id=post["contentItemId"],
    )
    logger.info("Published %s to %s (%s)", scheduled_post_id, platform, result.external_post_id)
    return {"status": "PUBLISHED", "externalPostId": result.external_post_id}


def _build_payload(
    content: dict,
    platform: str,
    variant_key: str | None = None,
    media_urls: list[str] | None = None,
    video_urls: list[str] | None = None,
) -> PostPayload:
    """A/B variant wins if assigned; else platform variant; else canonical body."""
    ab_variants = content.get("abVariants") or {}
    if variant_key and variant_key in ab_variants:
        chosen = ab_variants[variant_key]
        body = chosen.get("body") or content["body"]
        hashtags = chosen.get("hashtags", content.get("hashtags") or [])
    else:
        variants = content.get("variants") or {}
        variant = variants.get(platform) or {}
        body = variant.get("body") or content["body"]
        hashtags = variant.get("hashtags", content.get("hashtags") or [])
    if hashtags and platform != "REDDIT":
        body = f"{body}\n\n{' '.join(f'#{t}' for t in hashtags)}"
    return PostPayload(
        text=body,
        title=content.get("title"),
        media_urls=media_urls or None,
        video_urls=video_urls or None,
    )


def _record_failure(
    post_id: str, org_id: str, connection_id: str, error: str, attempts: int, permanent: bool
) -> None:
    now = utcnow()
    with get_session() as session:
        if permanent:
            session.execute(
                update(ScheduledPost)
                .where(ScheduledPost.c.id == post_id)
                .values(status="FAILED", attempts=attempts, error=error[:2000],
                        lockedAt=None, updatedAt=now)
            )
            session.execute(
                update(SocialConnection)
                .where(SocialConnection.c.id == connection_id)
                .values(lastError=error[:500], lastErrorAt=now)
            )
        else:
            session.execute(
                update(ScheduledPost)
                .where(ScheduledPost.c.id == post_id)
                .values(
                    status="PENDING",
                    attempts=attempts,
                    error=error[:2000],
                    lockedAt=None,
                    scheduledAt=now + timedelta(minutes=RETRY_DELAY_MINUTES * attempts),
                    updatedAt=now,
                )
            )
        session.commit()
    publish_event(
        org_id,
        {
            "type": "scheduled_post.updated",
            "scheduledPostId": post_id,
            "status": "FAILED" if permanent else "PENDING",
            "error": error[:300],
        },
    )


def _finish(
    post_id: str,
    org_id: str,
    error: str | None = None,
    external_post_id: str | None = None,
    external_post_url: str | None = None,
    content_item_id: str | None = None,
) -> None:
    now = utcnow()
    status = "FAILED" if error else "PUBLISHED"
    with get_session() as session:
        session.execute(
            update(ScheduledPost)
            .where(ScheduledPost.c.id == post_id)
            .values(
                status=status,
                error=error,
                publishedAt=None if error else now,
                externalPostId=external_post_id,
                externalPostUrl=external_post_url,
                lockedAt=None,
                updatedAt=now,
            )
        )
        if not error and content_item_id:
            session.execute(
                update(ContentItem)
                .where(ContentItem.c.id == content_item_id)
                .values(status="PUBLISHED", updatedAt=now)
            )
        session.commit()
    publish_event(
        org_id,
        {
            "type": "scheduled_post.updated",
            "scheduledPostId": post_id,
            "status": status,
            "error": error,
        },
    )
