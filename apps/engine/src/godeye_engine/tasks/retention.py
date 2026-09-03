"""Rows that must not accumulate forever.

Three tables grow without bound and none of them is read after a short window.

WebhookEvent (S-7)
    Meta deliveries. Nothing consumed them and `processedAt` was written
    nowhere, so the table was write-only — and, until the same fix, it accepted
    *unauthenticated* writes. Signed events are still stored because a delivery
    log is genuinely useful while debugging a channel; it is useful for days,
    not for the life of the product.

RefreshToken (D-3)
    Every login and every rotation inserts a row, and rotation marks `revokedAt`
    without deleting anything. One continuously-active user produces ~96 rows a
    day; a hundred users produce roughly 3.5 million rows a year, each carrying
    a unique index on a table that is read on every token refresh.

AnalyticsSnapshot is deliberately absent: it is the data behind the reporting
the product sells, and deleting it would delete the answer to "how did last
quarter go".

Deletes are batched. A single unbounded DELETE on a large table takes a lock
for as long as it runs, and this task shares a database with the publisher.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from ..celery_app import app
from ..db import get_engine
from ..periodic_lock import once_per_tick

logger = logging.getLogger(__name__)

#: How long a delivered webhook stays useful for debugging.
WEBHOOK_RETENTION_DAYS = 30
#: A revoked refresh token is only interesting while investigating a theft.
REVOKED_TOKEN_GRACE_DAYS = 7
#: Rows per statement, so no single DELETE holds a long lock.
BATCH = 5_000
#: Bounds one run. Whatever is left is picked up on the next tick.
MAX_BATCHES = 20


def _delete_in_batches(conn, table: str, where: str, params: dict) -> int:
    """DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT n), repeatedly.

    ctid rather than id: it needs no index and no ordering, which is what makes
    each batch cheap on a table whose only useful index is on something else.
    """
    removed = 0
    for _ in range(MAX_BATCHES):
        result = conn.execute(
            text(
                f'DELETE FROM "{table}" WHERE ctid IN '
                f'(SELECT ctid FROM "{table}" WHERE {where} LIMIT {BATCH})'
            ),
            params,
        )
        count = result.rowcount or 0
        removed += count
        if count < BATCH:
            break
    return removed


@app.task(name="godeye_engine.tasks.retention.purge_expired_rows")
@once_per_tick("purge-expired", 21000)
def purge_expired_rows() -> dict:
    now = datetime.now(UTC)
    webhook_cutoff = now - timedelta(days=WEBHOOK_RETENTION_DAYS)
    revoked_cutoff = now - timedelta(days=REVOKED_TOKEN_GRACE_DAYS)

    with get_engine().begin() as conn:
        webhooks = _delete_in_batches(
            conn, "WebhookEvent", '"createdAt" < :cutoff', {"cutoff": webhook_cutoff}
        )
        expired_tokens = _delete_in_batches(
            conn, "RefreshToken", '"expiresAt" < :now', {"now": now}
        )
        revoked_tokens = _delete_in_batches(
            conn,
            "RefreshToken",
            '"revokedAt" IS NOT NULL AND "revokedAt" < :cutoff',
            {"cutoff": revoked_cutoff},
        )

    result = {
        "webhookEvents": webhooks,
        "refreshTokensExpired": expired_tokens,
        "refreshTokensRevoked": revoked_tokens,
    }
    if any(result.values()):
        logger.info("Retention sweep removed %s", result)
    return result
