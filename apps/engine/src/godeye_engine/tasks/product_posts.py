"""Turn imported products into scheduled posts.

Runs for workspaces that turned auto-post on and chose destinations. It picks
one product at a time rather than emptying the catalogue into a feed: a shop
that imports forty products should not publish forty posts in an hour, and the
choosing is what makes this useful rather than a bulk uploader.

What gets picked, in order:
  never posted, newest first   a new arrival is the thing worth announcing
  then least recently posted    so the catalogue rotates instead of repeating

Out-of-stock products are skipped. Sending people to something they cannot buy
wastes the post and annoys the reader.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import and_, or_, select, update

from ..ai import product_agent
from ..celery_app import app
from ..db import (
    BusinessProfile,
    ContentItem,
    MediaAsset,
    Organization,
    Product,
    ScheduledPost,
    SocialConnection,
    get_session,
    locked_org_ids,
    new_id,
    utcnow,
)

logger = logging.getLogger(__name__)

# How long a product waits before it may be posted about again. Long enough
# that a small catalogue does not feel like a loop.
REPOST_AFTER_DAYS = 30

# How far ahead the post is scheduled. Not immediate: it gives the workspace a
# window to see it on the calendar and cancel before it goes out.
SCHEDULE_AHEAD_MINUTES = 30

POST_SOFT_LIMIT_SEC = 4 * 60
POST_HARD_LIMIT_SEC = 5 * 60


@app.task(name="godeye_engine.tasks.product_posts.plan_product_posts")
def plan_product_posts() -> dict:
    """One post per workspace that has auto-post on — and is still paying."""
    with get_session() as session:
        rows = session.execute(
            select(
                BusinessProfile.c.orgId,
                BusinessProfile.c.productPostPlatforms,
            ).where(
                BusinessProfile.c.productAutoPost.is_(True),
                BusinessProfile.c.productImportConsentAt.isnot(None),
                BusinessProfile.c.orgId.notin_(locked_org_ids(utcnow())),
            )
        ).mappings().all()

    planned = 0
    for row in rows:
        platforms = row["productPostPlatforms"] or []
        if not platforms:
            # The settings refuse this, but a row could predate them.
            logger.info("Auto-post on for %s with no destinations; skipping", row["orgId"])
            continue
        if create_product_post.delay(row["orgId"], list(platforms)):
            planned += 1
    return {"workspaces": planned}


@app.task(
    name="godeye_engine.tasks.product_posts.create_product_post",
    soft_time_limit=POST_SOFT_LIMIT_SEC,
    time_limit=POST_HARD_LIMIT_SEC,
)
def create_product_post(org_id: str, platforms: list[str]) -> dict:
    """Write and schedule one post about one product."""
    now = utcnow()
    cutoff = now - timedelta(days=REPOST_AFTER_DAYS)

    with get_session() as session:
        product = session.execute(
            select(Product)
            .where(
                Product.c.orgId == org_id,
                # Out of stock is the one status worth acting on: a post that
                # sends people to something unbuyable is worse than no post.
                or_(
                    Product.c.availability.is_(None),
                    Product.c.availability != "OutOfStock",
                ),
                or_(Product.c.lastPostedAt.is_(None), Product.c.lastPostedAt < cutoff),
            )
            # Never posted first, newest of those first; then the ones waiting
            # longest, so the catalogue rotates rather than repeating.
            .order_by(
                Product.c.lastPostedAt.asc().nullsfirst(),
                Product.c.firstSeenAt.desc(),
            )
            .limit(1)
        ).mappings().first()

        if product is None:
            return {"status": "nothing_due"}

        profile = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()
        org = session.execute(
            select(Organization.c.requireApproval).where(Organization.c.id == org_id)
        ).mappings().first()
        connections = session.execute(
            select(SocialConnection.c.id, SocialConnection.c.platform).where(
                SocialConnection.c.orgId == org_id,
                SocialConnection.c.status == "ACTIVE",
                SocialConnection.c.platform.in_(platforms),
            )
        ).mappings().all()

    if not connections:
        logger.info("No active connections for %s on %s", org_id, platforms)
        return {"status": "no_connections"}

    post = product_agent.generate(
        dict(product),
        dict(profile) if profile else {},
        angle_index=product["postCount"],
        locale=_locale_of(profile),
    )

    require_approval = bool(org and org["requireApproval"])
    content_id = new_id()
    scheduled_at = now + timedelta(minutes=SCHEDULE_AHEAD_MINUTES)

    with get_session() as session:
        session.execute(
            ContentItem.insert().values(
                id=content_id,
                orgId=org_id,
                type="SOCIAL_POST",
                # Approval-gated workspaces review these like any other draft.
                status="PENDING_APPROVAL" if require_approval else "SCHEDULED",
                title=product["title"][:200],
                body=post.body,
                hashtags=post.hashtags,
                variants=None,
                abVariants=None,
                evergreen=False,
                slideshowSeconds=30,
                renderAsVideo=True,
                aiGenerated=True,
                submittedAt=now if require_approval else None,
                createdAt=now,
                updatedAt=now,
            )
        )

        # The shop's own photograph is the post's image. Registered as an asset
        # so publishing treats it exactly like an uploaded one.
        if product["imageUrl"]:
            session.execute(
                MediaAsset.insert().values(
                    id=new_id(),
                    orgId=org_id,
                    contentItemId=content_id,
                    kind="IMAGE",
                    source="IMPORTED",
                    # The shop hosts it, so there is no object of ours behind
                    # this — but the column is NOT NULL, so it records where
                    # the file actually lives.
                    storageKey=product["imageUrl"],
                    url=product["imageUrl"],
                    mimeType="image/jpeg",
                    createdAt=now,
                )
            )

        for connection in connections:
            session.execute(
                ScheduledPost.insert().values(
                    id=new_id(),
                    orgId=org_id,
                    contentItemId=content_id,
                    connectionId=connection["id"],
                    scheduledAt=scheduled_at,
                    timezone="UTC",
                    status="PENDING",
                    attempts=0,
                    createdAt=now,
                    updatedAt=now,
                )
            )

        session.execute(
            update(Product)
            .where(Product.c.id == product["id"])
            .values(
                lastPostedAt=now,
                postCount=(product["postCount"] or 0) + 1,
                updatedAt=now,
            )
        )
        session.commit()

    logger.info(
        "Scheduled a product post for %s: %r to %d destination(s)%s",
        org_id, product["title"], len(connections),
        " (fell back to the product's own words)" if post.fell_back else "",
    )
    return {
        "status": "scheduled",
        "product": product["title"],
        "destinations": len(connections),
        "fellBack": post.fell_back,
        "contentItemId": content_id,
    }


def _locale_of(profile) -> str | None:
    """A hint for how to write the price, from where the shop says it is."""
    if not profile:
        return None
    location = (profile["location"] or "").lower()
    for needle, code in (
        ("france", "fr"), ("ireland", "ie"), ("united kingdom", "en"), ("uk", "en"),
    ):
        if needle in location:
            return code
    return None
