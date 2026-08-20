"""USE metrics for the worker, exposed at ``GET /metrics``.

Rubric row 4. A worker is a resource, not an endpoint, so RED does not describe
it — Utilisation, Saturation and Errors do:

    utilisation   tasks in flight, and how long they take
    saturation    QUEUE DEPTH, and how late the oldest due post is
    errors        publishes that failed, by platform and by permanence

**Queue depth and publish lateness are the two numbers that predict a customer
noticing.** Everything else is diagnosis after the fact. The autoscaling policy
in docs/ops/CAPACITY.md scales on the first; the SLO in docs/ops/SLOs.md is
written against the second.

Deliberately Prometheus rather than OTLP for these: they are gauges a scraper
should sample on its own schedule, and the ceiling they describe is a property
of the deployment rather than of any one request.
"""

from __future__ import annotations

import logging

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

logger = logging.getLogger(__name__)

REGISTRY = CollectorRegistry()

# ---------------------------------------------------------------- utilisation
TASK_DURATION = Histogram(
    "godeye_task_duration_seconds",
    "Wall-clock time for a Celery task",
    ["task", "outcome"],
    # Buckets chosen from the real shape of this work: a text publish is under a
    # second, an image publish a few, a video publish tens. Default buckets put
    # all three in one bin and tell you nothing.
    buckets=(0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600),
    registry=REGISTRY,
)

TASKS_IN_FLIGHT = Gauge(
    "godeye_tasks_in_flight",
    "Tasks currently executing on this worker",
    ["task"],
    registry=REGISTRY,
)

# ----------------------------------------------------------------- saturation
QUEUE_DEPTH = Gauge(
    "godeye_queue_depth",
    "Messages waiting on a Celery queue",
    ["queue"],
    registry=REGISTRY,
)

PUBLISH_LATENESS = Gauge(
    "godeye_publish_lateness_seconds",
    "How far past its scheduled time the oldest unpublished post is",
    registry=REGISTRY,
)

DUE_BACKLOG = Gauge(
    "godeye_due_posts_backlog",
    "Posts due to publish and not yet claimed",
    registry=REGISTRY,
)

# --------------------------------------------------------------------- errors
PUBLISH_RESULTS = Counter(
    "godeye_publish_total",
    "Publish attempts by platform and outcome",
    ["platform", "outcome"],
    registry=REGISTRY,
)

CONNECTION_REFRESH = Counter(
    "godeye_connection_refresh_total",
    "Token refresh attempts by platform and outcome",
    ["platform", "outcome"],
    registry=REGISTRY,
)

EGRESS_BLOCKED = Counter(
    "godeye_egress_blocked_total",
    "Outbound fetches refused by the SSRF guard, by reason",
    ["reason"],
    registry=REGISTRY,
)


def render() -> bytes:
    """The Prometheus exposition body for ``GET /metrics``."""
    return generate_latest(REGISTRY)


def sample_saturation() -> None:
    """Refresh the gauges that describe backlog, on scrape.

    Read at scrape time rather than pushed on a timer so a scraper that stops
    scraping produces a gap rather than a flat line — a flat line reads as
    "healthy" and is the worst possible answer to "is anything wrong".
    """
    from datetime import UTC, datetime

    from sqlalchemy import and_, func, select

    from .db import ScheduledPost, get_session

    now = datetime.now(UTC).replace(tzinfo=None)
    try:
        with get_session() as session:
            row = session.execute(
                select(
                    func.count().label("backlog"),
                    func.min(ScheduledPost.c.scheduledAt).label("oldest"),
                ).where(
                    and_(
                        ScheduledPost.c.status == "PENDING",
                        ScheduledPost.c.scheduledAt <= now,
                    )
                )
            ).first()
        backlog = int(row.backlog or 0) if row else 0
        DUE_BACKLOG.set(backlog)
        oldest = row.oldest if row else None
        PUBLISH_LATENESS.set((now - oldest).total_seconds() if oldest else 0)
    except Exception as e:  # noqa: BLE001 - a metrics scrape must never take the process down
        logger.warning("Could not sample publish saturation: %s", e)


def sample_queue_depths() -> None:
    """Queue depth straight from Redis.

    Celery keeps a list per queue; its length is the depth. This is the number
    the autoscaling policy in docs/ops/CAPACITY.md is written against, because a
    publish worker is I/O-bound and its CPU stays flat while the backlog grows.
    """
    try:
        import redis as redis_lib

        from .config import get_settings

        client = redis_lib.Redis.from_url(
            get_settings().redis_url, socket_connect_timeout=2, socket_timeout=2
        )
        for queue in ("publish", "media", "background", "celery"):
            QUEUE_DEPTH.labels(queue=queue).set(client.llen(queue))
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not sample queue depth: %s", e)
