"""Scheduler. Celery Beat scans due posts; publish tasks push them to platforms."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_, select, update

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
    locked_org_ids,
    utcnow,
)
from ..events import publish_event
from ..metrics_registry import PUBLISH_RESULTS
from ..publishers import PublishError, get_publisher
from ..publishers.base import PostPayload
from ..security import decrypt_credentials
from .products import attach_imported_photo

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
RETRY_DELAY_MINUTES = 2
LOCK_TIMEOUT_MINUTES = 5

# Publishing is bounded far tighter than the 25 minute ceiling every task gets.
# The slowest legitimate path is an Instagram Reel: render the slideshow, store
# it, then wait up to five minutes while Instagram fetches and transcodes it.
# Ten minutes covers that with room; past it the task is not slow, it is gone.
PUBLISH_SOFT_LIMIT_SEC = 8 * 60
PUBLISH_HARD_LIMIT_SEC = 10 * 60

# How long a claimed post may sit before it is treated as abandoned.
#
# This was twelve minutes, sized against the task's own ten minute hard limit,
# on the assumption that a claimed post is a running one. It is not: the row is
# marked PROCESSING when it is claimed, and the worker runs --concurrency=2, so
# a post can wait in the queue behind others for as long as they take. Counting
# that wait as abandonment re-queued live work.
#
# Thirty minutes leaves room for a full queue of slow publishes, an Instagram
# Reel alone can spend five minutes being transcoded. The claim check in
# publish_post is what actually prevents a duplicate; this only decides how
# long a genuinely lost post waits.
STUCK_POST_MINUTES = 30

# How far a claim time may drift and still be the same claim. This exists
# because the database keeps milliseconds and Python hands it microseconds;
# a re-claim is minutes away, so a second is unambiguous.
CLAIM_TOLERANCE_SEC = 1.0

# Networks whose API refuses a post with no media. Everywhere else text alone
# is a legitimate post, so nothing is borrowed for them.
MEDIA_REQUIRED_PLATFORMS = ("TIKTOK", "INSTAGRAM")

# How long a due post waits for an image that is still being made.
#
# Autopilot writes the post and queues its image as two separate jobs, so the
# image can still be in the queue when the slot arrives. Publishing anyway is
# how a marketing post went out as bare text on Facebook and failed outright on
# Instagram, on the same content, minutes apart. Waiting costs a few minutes of
# punctuality and saves the post.
#
# Bounded, because an image that is never coming must not hold a slot forever.
IMAGE_WAIT_MINUTES = 45

# When an org requires approval, a due post only dispatches once its content
# cleared review. SCHEDULED/PUBLISHED imply approval happened earlier (manual
# scheduling is gated in the API; PUBLISHED appears when a sibling post ran first).
APPROVAL_SATISFIED_STATUSES = ("APPROVED", "SCHEDULED", "PUBLISHED")


#: Posts claimed per dispatcher tick, across all workspaces.
DISPATCH_BATCH = 20
#: Posts claimed per WORKSPACE per tick. The fairness knob.
#:
#: Without it, one workspace with 500 due posts takes the whole batch on every
#: tick and everybody else waits behind it — for hours, silently, with their
#: posts still reading PENDING. The old query had no ORDER BY at all, so which
#: workspace won was whatever order Postgres happened to return.
#:
#: 4 of 20 means a single tenant can use at most a fifth of a tick while any
#: other tenant has work, and the whole batch when nobody else does.
PER_ORG_PER_TICK = 4


def due_posts_query(now, stale_lock, batch=DISPATCH_BATCH, per_org=PER_ORG_PER_TICK):
    """Due, unclaimed posts, fairly shared between workspaces.

    A workspace whose trial ran out unpaid publishes nothing. Without that line
    a customer could queue a month of posts during the 24 hours and have them
    go out for free long after the workspace went read-only, the paywall would
    hold in the browser and leak everywhere it actually costs money.

    The ranking is the fairness half. `row_number() OVER (PARTITION BY orgId
    ORDER BY scheduledAt)` numbers each workspace's due posts independently, and
    taking `rn <= per_org` spreads one tick across as many workspaces as have
    work. Oldest-first within a workspace, so nothing starves inside one either.

    The window function sits in a subquery on purpose: Postgres refuses
    FOR UPDATE alongside a window function, and the row-level claim is what
    makes two dispatchers safe. The outer select is a plain lookup by id, so it
    keeps `FOR UPDATE ... SKIP LOCKED`.
    """
    due = (
        select(
            ScheduledPost.c.id.label("id"),
            func.row_number()
            .over(
                partition_by=ScheduledPost.c.orgId,
                order_by=ScheduledPost.c.scheduledAt.asc(),
            )
            .label("rn"),
        )
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
                ScheduledPost.c.orgId.notin_(locked_org_ids(now)),
            )
        )
        .subquery("due")
    )

    fair = (
        select(due.c.id).where(due.c.rn <= per_org).limit(batch).subquery("fair")
    )

    return (
        select(ScheduledPost.c.id)
        .where(ScheduledPost.c.id.in_(select(fair.c.id)))
        .with_for_update(skip_locked=True, of=ScheduledPost)
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
        # The claim time travels with the task. If this post gets re-queued
        # before the task runs, its lockedAt moves and this copy stands down,
        # see publish_post.
        publish_post.delay(post_id, claimed_at=now.isoformat())
    if ids:
        logger.info("Dispatched %d due post(s)", len(ids))
    return len(ids)


@app.task(
    name="godeye_engine.tasks.scheduler.publish_post",
    soft_time_limit=PUBLISH_SOFT_LIMIT_SEC,
    time_limit=PUBLISH_HARD_LIMIT_SEC,
)
def publish_post(scheduled_post_id: str, claimed_at: str | None = None) -> dict:
    with get_session() as session:
        post = session.execute(
            select(ScheduledPost).where(ScheduledPost.c.id == scheduled_post_id)
        ).mappings().first()
        if post is None or post["status"] != "PROCESSING":
            return {"status": "skipped"}

        # Status alone is not enough to know this task still owns the post.
        # PROCESSING is set when the row is claimed, not when a worker picks
        # the task up, so a post can sit in the queue behind others while
        # already marked as being worked on. The reaper reads that wait as
        # abandonment, re-queues it, and then two copies of this task exist,
        # both find PROCESSING and both publish. That is how the same product
        # went out twice, thirteen minutes apart.
        #
        # The claim time makes the copies distinguishable: re-queuing moves
        # lockedAt, so only the task dispatched by the most recent claim
        # matches, and the rest stand down.
        #
        # Compared with a tolerance, not for equality. utcnow() carries
        # microseconds and lockedAt is TIMESTAMP(3), so Postgres truncates the
        # value on the way in: a claim dispatched at .885898 reads back as
        # .885000 and never matches itself. Written as == this refused every
        # task, which stopped publishing altogether. Re-claims are minutes
        # apart, so a second of slack tells them apart with room to spare.
        if claimed_at and post["lockedAt"] is not None:
            drift = abs((post["lockedAt"] - datetime.fromisoformat(claimed_at)).total_seconds())
            if drift > CLAIM_TOLERANCE_SEC:
                logger.info(
                    "Publish %s superseded by a newer claim (%.1fs newer); standing down",
                    scheduled_post_id, drift,
                )
                return {"status": "superseded"}

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
        # Photos are rendered into a slideshow carrying the workspace's track,
        # so a photo post arrives with sound instead of silent. The track is
        # the workspace's; how long the post runs and whether it renders at all
        # belong to the post, chosen when it was written.
        brand_music = session.execute(
            select(BrandKit.c.musicUrl).where(BrandKit.c.orgId == post["orgId"])
        ).scalar()

    if content is None or connection is None:
        _finish(scheduled_post_id, post["orgId"], error="Content or connection no longer exists")
        return {"status": "FAILED"}

    platform = connection["platform"]

    # B-7. Never attempt a publish through a connection the platform will
    # refuse. Attempting produced a generic platform error attributed to the
    # post, which read as "this post failed" rather than "this channel needs
    # reconnecting" — so nobody reconnected, and every subsequent post failed
    # the same way.
    if connection["status"] in ("EXPIRED", "REVOKED", "DISCONNECTED"):
        _finish(
            scheduled_post_id,
            post["orgId"],
            error=(
                f"{platform} connection \"{connection['displayName']}\" needs to be "
                f"reconnected before it can publish (status: {connection['status']})."
            ),
        )
        return {"status": "FAILED", "reason": "connection_not_usable"}
    media_urls = [row.url for row in media if row.kind == "IMAGE"]
    video_urls = [row.url for row in media if row.kind == "VIDEO"]

    # An image that is still being made is worth waiting for.
    #
    # The post and its image are two jobs. When the image is slower than the
    # slot, this published the post without it: bare text on Facebook, and on
    # Instagram an outright failure, from the same content item. Neither is
    # recoverable afterwards, because a published post cannot grow an image and
    # retrying a failed one finds the same nothing.
    #
    # So a due post with no media steps aside while its image is queued or
    # running, and is picked up again on the next tick. Bounded by
    # IMAGE_WAIT_MINUTES, after which it goes out as it is rather than holding
    # the slot forever.
    overdue = utcnow() - post["scheduledAt"]
    if should_wait_for_image(
        has_media=bool(media_urls or video_urls),
        overdue=overdue,
        image_coming=lambda: _image_still_coming(post["contentItemId"]),
    ):
        _release_claim(scheduled_post_id)
        logger.info(
            "Publish %s is waiting for its image (%.0fs overdue); back to PENDING",
            scheduled_post_id, overdue.total_seconds(),
        )
        return {"status": "waiting_for_image"}

    # A post with nothing attached cannot go to these two at all, and retrying
    # it changes nothing, the same content comes back with the same nothing,
    # which is why "reschedule the failed post" kept failing identically. If
    # the workspace imported a catalogue, borrow a photograph from it here,
    # which is the last moment anything can still be done about it.
    if platform in MEDIA_REQUIRED_PLATFORMS and not media_urls and not video_urls:
        if attach_imported_photo(post["orgId"], post["contentItemId"], utcnow()):
            with get_session() as session:
                media_urls = [
                    row.url
                    for row in session.execute(
                        select(MediaAsset.c.url)
                        .where(
                            MediaAsset.c.contentItemId == post["contentItemId"],
                            MediaAsset.c.kind == "IMAGE",
                            MediaAsset.c.url.isnot(None),
                        )
                        .order_by(MediaAsset.c.createdAt.asc())
                    ).fetchall()
                ]
            logger.info(
                "Publish %s had no media; attached one from the catalogue", scheduled_post_id
            )
    payload = _build_payload(
        dict(content), platform, post.get("variantKey"), media_urls, video_urls,
        brand_music,
        content["slideshowSeconds"],
        bool(content["renderAsVideo"]),
        post["orgId"],
    )

    try:
        try:
            credentials = decrypt_credentials(
                connection["encryptedCredentials"], post["orgId"]
            )
        except Exception as e:  # noqa: BLE001
            # AES-GCM raises InvalidTag, whose str() is empty, a failure with no
            # message at all. Almost always TOKEN_ENCRYPTION_KEY differing from
            # the one the API encrypted with, so say that instead of nothing.
            #
            # Undecryptable credentials never recover on their own, so flag the
            # connection rather than leaving it ACTIVE and failing every post.
            _mark_connection_error(connection["id"])
            raise PublishError(
                "Could not decrypt the stored credentials for this connection. "
                "Reconnect the account, it was connected with a different "
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
        # Permanent and transient are different problems: one is a customer who
        # must reconnect, the other is a platform having a bad minute. An alert
        # that cannot tell them apart pages for the wrong thing.
        PUBLISH_RESULTS.labels(
            platform=platform, outcome="failed" if permanent else "retrying"
        ).inc()
        return {"status": "FAILED" if permanent else "RETRYING"}

    _finish(
        scheduled_post_id,
        post["orgId"],
        external_post_id=result.external_post_id,
        external_post_url=result.external_post_url,
        content_item_id=post["contentItemId"],
        connection_id=connection["id"],
    )
    logger.info("Published %s to %s (%s)", scheduled_post_id, platform, result.external_post_id)
    PUBLISH_RESULTS.labels(platform=platform, outcome="published").inc()
    return {"status": "PUBLISHED", "externalPostId": result.external_post_id}


def _build_payload(
    content: dict,
    platform: str,
    variant_key: str | None = None,
    media_urls: list[str] | None = None,
    video_urls: list[str] | None = None,
    music_url: str | None = None,
    slideshow_seconds: int | None = None,
    render_as_video: bool = True,
    org_id: str | None = None,
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
        slideshow_seconds=slideshow_seconds,
        render_as_video=render_as_video,
        org_id=org_id,
    )


def _mark_connection_error(connection_id: str) -> None:
    """Flag a connection as unusable so the UI shows it needs reconnecting.

    Used for failures that can't resolve by retrying, undecryptable
    credentials, for example, where leaving the row ACTIVE would just fail
    every future post silently.
    """
    with get_session() as session:
        session.execute(
            update(SocialConnection)
            .where(SocialConnection.c.id == connection_id)
            .values(status="ERROR")
        )
        session.commit()


# Words that mean "this channel is broken" rather than "this post was wrong".
# Deliberately narrow: a miss leaves a dead channel looking healthy for a
# while, which the next failure corrects, whereas a false positive puts a red
# line on a working channel and that is the complaint this exists to fix.
_CONNECTION_FAULT_SIGNS = (
    "access token",
    "token has expired",
    "session has expired",
    "oauthexception",
    "invalid_grant",
    "invalid credentials",
    "not authorized",
    "unauthorized",
    "permission",
    "re-authenticate",
    "reconnect the account",
    "revoked",
)


def _is_connection_fault(error: str) -> bool:
    text = error.lower()
    return any(sign in text for sign in _CONNECTION_FAULT_SIGNS)


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
            # A failed post is not written onto the channel, ever.
            #
            # Every permanent failure used to stamp its message here, so the
            # text of whatever went wrong sat on the connection card in red
            # until a later post happened to succeed, or, in practice, until
            # the user disconnected and reconnected to be rid of it. The
            # message belongs to the post: ScheduledPost.error above already
            # holds it, and the calendar is where someone looks to find out
            # why a post did not go out.
            #
            # What the card owes the user is whether the channel still works.
            # That is the status, so a credential failure moves it out of
            # ACTIVE and the badge says reconnect. No prose, nothing to
            # accumulate, nothing to dismiss.
            if _is_connection_fault(error):
                session.execute(
                    update(SocialConnection)
                    .where(SocialConnection.c.id == connection_id)
                    .values(status="ERROR", updatedAt=now)
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


def should_wait_for_image(
    has_media: bool,
    overdue: timedelta,
    image_coming: Callable[[], bool],
) -> bool:
    """Whether a due post should step aside and let its image finish.

    Three conditions, and all of them matter. A post that already has media
    goes out now. A post whose image is not actually in flight would wait for
    nothing, so it goes out as it is rather than stalling until the deadline.
    And the wait is bounded, because a slot held open forever is worse than a
    post that went out plain.

    ``image_coming`` is a callable so the database is only asked when the
    cheap checks have already passed.
    """
    if has_media:
        return False
    if overdue >= timedelta(minutes=IMAGE_WAIT_MINUTES):
        return False
    return image_coming()


def _image_still_coming(content_item_id: str) -> bool:
    """Whether an image for this content item is queued or already running.

    Read off AgentRun rather than guessed from timing. QUEUED is written by the
    planner the moment it dispatches generation, and RUNNING by the image task
    when it starts, so between them they cover the whole window where an image
    is on its way but not yet stored.
    """
    with get_session() as session:
        return session.execute(
            select(AgentRun.c.id)
            .where(
                AgentRun.c.agent == "IMAGE",
                AgentRun.c.status.in_(["QUEUED", "RUNNING"]),
                AgentRun.c.input["contentItemId"].astext == content_item_id,
            )
            .limit(1)
        ).first() is not None


def _release_claim(post_id: str) -> None:
    """Put a claimed post back in the pool without spending an attempt.

    Standing aside is not a failure, so attempts is untouched: burning one here
    would exhaust the retry budget on a post that has not been sent anywhere.
    Clearing lockedAt is what makes the next dispatch tick pick it up again.
    """
    with get_session() as session:
        session.execute(
            update(ScheduledPost)
            .where(ScheduledPost.c.id == post_id)
            .values(status="PENDING", lockedAt=None, updatedAt=utcnow())
        )
        session.commit()


def _finish(
    post_id: str,
    org_id: str,
    error: str | None = None,
    external_post_id: str | None = None,
    external_post_url: str | None = None,
    content_item_id: str | None = None,
    connection_id: str | None = None,
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
        if not error and connection_id:
            # A failure stamps the connection with its reason, and nothing used
            # to remove it. So a channel that failed once and published fine
            # ever after still showed the old error on Connections, long after
            # the calendar had gone quiet, which reads as a broken channel.
            #
            # A post going out is proof the connection works, so it is the
            # right moment to clear it. ERROR is lifted for the same reason:
            # whatever the objection was, it no longer holds. EXPIRED and
            # DISCONNECTED are left alone, those say something about the
            # account rather than about this attempt.
            # Two plain statements rather than one with a CASE. status is a
            # Prisma-owned enum, and a bare 'ACTIVE' inside CASE compiles to
            # varchar, which Postgres refuses to match against
            # "ConnectionStatus". The WHERE side casts correctly on its own, so
            # restricting the second update by status says the same thing
            # without needing the literal to carry a type.
            session.execute(
                update(SocialConnection)
                .where(SocialConnection.c.id == connection_id)
                .values(lastError=None, lastErrorAt=None, lastCheckedAt=now, updatedAt=now)
            )
            session.execute(
                update(SocialConnection)
                .where(
                    SocialConnection.c.id == connection_id,
                    SocialConnection.c.status == "ERROR",
                )
                .values(status="ACTIVE", updatedAt=now)
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


@app.task(name="godeye_engine.tasks.scheduler.reap_stuck_posts")
def reap_stuck_posts() -> dict:
    """Re-queue posts whose worker died between claiming them and publishing.

    dispatch_due_posts flips a post to PROCESSING before handing it to a worker.
    If that worker goes away mid-publish, a deploy is the ordinary way, the
    row stays PROCESSING and nothing brings it back. The stale-lock check in
    due_posts_query was meant to, but it is AND-ed with status == PENDING, and
    an abandoned post is never PENDING, so it could not fire. Three posts sat
    for half an hour looking like they were still working.

    Safe to re-queue rather than fail: publish_post refuses to act on anything
    that is not PROCESSING, so when Redis eventually redelivers the abandoned
    message it finds the post PUBLISHED and skips instead of posting twice.
    That ordering is why the window here is comfortably past the task's own
    hard limit, a task still running would otherwise be re-queued underneath
    itself, and then both copies really would publish.
    """
    now = utcnow()
    cutoff = now - timedelta(minutes=STUCK_POST_MINUTES)

    with get_session() as session:
        rows = session.execute(
            select(ScheduledPost.c.id, ScheduledPost.c.orgId).where(
                and_(
                    ScheduledPost.c.status == "PROCESSING",
                    ScheduledPost.c.lockedAt.isnot(None),
                    ScheduledPost.c.lockedAt < cutoff,
                )
            )
        ).mappings().all()

        if rows:
            session.execute(
                update(ScheduledPost)
                .where(ScheduledPost.c.id.in_([r["id"] for r in rows]))
                .values(status="PENDING", lockedAt=None, updatedAt=now)
            )
            session.commit()

    if rows:
        logger.warning(
            "Re-queued %d post(s) abandoned mid-publish: %s",
            len(rows), ", ".join(r["id"] for r in rows),
        )
    return {"requeued": len(rows)}


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
