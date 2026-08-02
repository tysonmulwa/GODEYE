"""Scheduler — Celery Beat scans due posts; publish tasks push them to platforms."""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import and_, or_, select, update

from ..celery_app import app
from ..db import (
    AgentRun,
    BrandKit,
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
        # TikTok builds a slideshow from images when the workspace has a track,
        # so a photo post arrives with sound instead of silent.
        brand_music = session.execute(
            select(BrandKit.c.musicUrl).where(BrandKit.c.orgId == post["orgId"])
        ).scalar()

    if content is None or connection is None:
        _finish(scheduled_post_id, post["orgId"], error="Content or connection no longer exists")
        return {"status": "FAILED"}

    platform = connection["platform"]
    media_urls = [row.url for row in media if row.kind == "IMAGE"]
    video_urls = [row.url for row in media if row.kind == "VIDEO"]
    payload = _build_payload(
        dict(content), platform, post.get("variantKey"), media_urls, video_urls, brand_music
    )

    try:
        try:
            credentials = decrypt_credentials(connection["encryptedCredentials"])
        except Exception as e:  # noqa: BLE001
            # AES-GCM raises InvalidTag, whose str() is empty — a failure with no
            # message at all. Almost always TOKEN_ENCRYPTION_KEY differing from
            # the one the API encrypted with, so say that instead of nothing.
            #
            # Undecryptable credentials never recover on their own, so flag the
            # connection rather than leaving it ACTIVE and failing every post.
            _mark_connection_error(connection["id"])
            raise PublishError(
                "Could not decrypt the stored credentials for this connection. "
                "Reconnect the account — it was connected with a different "
                "TOKEN_ENCRYPTION_KEY than this server uses."
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
    music_url: str | None = None,
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
        music_url=music_url,
    )


def _mark_connection_error(connection_id: str) -> None:
    """Flag a connection as unusable so the UI shows it needs reconnecting.

    Used for failures that can't resolve by retrying — undecryptable
    credentials, for example — where leaving the row ACTIVE would just fail
    every future post silently.
    """
    with get_session() as session:
        session.execute(
            update(SocialConnection)
            .where(SocialConnection.c.id == connection_id)
            .values(status="ERROR")
        )
        session.commit()


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


# An AgentRun is set to RUNNING by the task itself, and only the task can clear
# it. If the worker process dies mid-task (an out-of-memory kill is the usual
# way) no handler runs, no time limit fires, and the row stays RUNNING forever
# while the UI spins on it. Nothing inside a dead process can fix that, so this
# sweeps up from the outside.
#
# Thresholds sit above each task's own hard time limit, so a run only lands here
# when the task genuinely never returned rather than merely being slow.
STALE_RUN_MINUTES: dict[str, int] = {
    "IMAGE": 10,   # hard limit 6m
    "VIDEO": 30,   # slowest legitimate task
    "CONTENT": 15,
    "SEO": 30,
}
DEFAULT_STALE_RUN_MINUTES = 30

STALE_RUN_ERROR = (
    "The worker stopped without finishing this run. That usually means the "
    "process was killed rather than the task failing, most often by running out "
    "of memory. Try again, and check the worker service's memory if it repeats."
)


def is_stale_run(agent: str, created_at, now) -> bool:
    """Has this RUNNING row outlived any chance its task is still working?

    Split out from the task so the thresholds can be tested without a database;
    getting this wrong in the impatient direction would fail runs that are
    merely slow.
    """
    if created_at is None:
        return False
    limit = STALE_RUN_MINUTES.get(agent, DEFAULT_STALE_RUN_MINUTES)
    return now - created_at > timedelta(minutes=limit)


@app.task(name="godeye_engine.tasks.scheduler.reap_stale_runs")
def reap_stale_runs() -> dict:
    """Fail out AgentRuns whose worker died before it could report anything."""
    now = utcnow()
    reaped: dict[str, int] = {}

    with get_session() as session:
        rows = session.execute(
            select(AgentRun.c.id, AgentRun.c.agent, AgentRun.c.orgId, AgentRun.c.createdAt)
            .where(AgentRun.c.status == "RUNNING")
        ).mappings().all()

        stale = [row for row in rows if is_stale_run(row["agent"], row["createdAt"], now)]
        for row in stale:
            session.execute(
                update(AgentRun)
                .where(AgentRun.c.id == row["id"])
                .values(status="FAILED", error=STALE_RUN_ERROR, completedAt=now)
            )
            reaped[row["agent"]] = reaped.get(row["agent"], 0) + 1
        if stale:
            session.commit()

    # Tell the browser, or it keeps showing a spinner until the page is reloaded.
    for row in stale:
        publish_event(
            row["orgId"],
            {"type": "agent_run.completed", "agentRunId": row["id"], "status": "FAILED"},
        )

    if reaped:
        logger.warning("Reaped stale agent runs: %s", reaped)
    return {"reaped": sum(reaped.values()), "byAgent": reaped}
