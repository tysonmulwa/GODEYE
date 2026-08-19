"""Hourly engagement collection for recently published posts."""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import select

from ..celery_app import app
from ..db import AnalyticsSnapshot, ScheduledPost, SocialConnection, get_session, new_id, utcnow
from ..publishers import get_publisher
from ..security import decrypt_credentials

logger = logging.getLogger(__name__)

LOOKBACK_DAYS = 7


@app.task(name="godeye_engine.tasks.metrics.collect_metrics")
def collect_metrics() -> int:
    """Fetch engagement for posts published in the last week; store snapshots."""
    since = utcnow() - timedelta(days=LOOKBACK_DAYS)
    with get_session() as session:
        rows = session.execute(
            select(
                ScheduledPost.c.id,
                ScheduledPost.c.orgId,
                ScheduledPost.c.externalPostId,
                ScheduledPost.c.variantKey,
                SocialConnection.c.id.label("connectionId"),
                SocialConnection.c.platform,
                SocialConnection.c.encryptedCredentials,
            )
            .select_from(
                ScheduledPost.join(
                    SocialConnection, ScheduledPost.c.connectionId == SocialConnection.c.id
                )
            )
            .where(
                ScheduledPost.c.status == "PUBLISHED",
                ScheduledPost.c.publishedAt >= since,
                ScheduledPost.c.externalPostId.isnot(None),
            )
        ).fetchall()

    collected = 0
    snapshots = []
    for row in rows:
        try:
            publisher = get_publisher(row.platform)
            credentials = decrypt_credentials(row.encryptedCredentials, row.orgId)
            value = publisher.get_metrics(credentials, row.externalPostId)
        except Exception as e:  # noqa: BLE001, one bad post must not stop the sweep
            logger.debug("Metrics fetch failed for %s (%s): %s", row.id, row.platform, e)
            continue
        if value is None:
            continue
        snapshots.append(
            {
                "id": new_id(),
                "orgId": row.orgId,
                "connectionId": row.connectionId,
                "metric": "post_engagement",
                "value": value,
                "dimensions": {"scheduledPostId": row.id, "variantKey": row.variantKey},
                "capturedAt": utcnow(),
            }
        )
        collected += 1

    if snapshots:
        with get_session() as session:
            session.execute(AnalyticsSnapshot.insert(), snapshots)
            session.commit()
        logger.info("Collected engagement for %d post(s)", collected)
    return collected
