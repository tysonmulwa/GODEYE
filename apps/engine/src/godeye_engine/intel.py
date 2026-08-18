"""Best-time detection, engagement-driven with per-platform heuristic fallbacks."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import AnalyticsSnapshot, ScheduledPost, SocialConnection, get_session, utcnow

# Industry-standard fallback posting hours (local time) per platform.
PLATFORM_DEFAULT_HOURS: dict[str, list[int]] = {
    "TELEGRAM": [12, 19],
    "DISCORD": [17, 20],
    "REDDIT": [8, 13, 20],
    "FACEBOOK": [9, 13, 19],
    "INSTAGRAM": [11, 14, 19],
    "X": [9, 12, 17],
    "LINKEDIN": [8, 12, 17],
}
GENERIC_HOURS = [9, 13, 18]

# Need at least this many measured posts before trusting the data over defaults.
MIN_DATA_POINTS = 8


def engagement_by_hour(org_id: str, platform: str, tz: str) -> dict[int, list[float]]:
    """Collect engagement values grouped by local publish hour."""
    since = utcnow() - timedelta(days=90)
    zone = ZoneInfo(tz)
    with get_session() as session:
        rows = session.execute(
            select(
                ScheduledPost.c.id,
                ScheduledPost.c.publishedAt,
                AnalyticsSnapshot.c.value,
                AnalyticsSnapshot.c.capturedAt,
            )
            .select_from(
                ScheduledPost.join(
                    SocialConnection, ScheduledPost.c.connectionId == SocialConnection.c.id
                ).join(
                    AnalyticsSnapshot,
                    AnalyticsSnapshot.c.dimensions["scheduledPostId"].astext
                    == ScheduledPost.c.id,
                )
            )
            .where(
                ScheduledPost.c.orgId == org_id,
                ScheduledPost.c.status == "PUBLISHED",
                ScheduledPost.c.publishedAt >= since,
                SocialConnection.c.platform == platform,
                AnalyticsSnapshot.c.metric == "post_engagement",
            )
        ).fetchall()

    # keep only the latest snapshot per post
    latest: dict[str, tuple] = {}
    for row in rows:
        current = latest.get(row.id)
        if current is None or row.capturedAt > current.capturedAt:
            latest[row.id] = row

    by_hour: dict[int, list[float]] = defaultdict(list)
    for row in latest.values():
        if row.publishedAt is None:
            continue
        local_hour = row.publishedAt.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone).hour
        by_hour[local_hour].append(float(row.value))
    return dict(by_hour)


def best_hours(org_id: str, platform: str, tz: str = "UTC", count: int = 3) -> list[int]:
    """Top posting hours (local). Falls back to platform heuristics on thin data."""
    data = engagement_by_hour(org_id, platform, tz)
    total_points = sum(len(v) for v in data.values())
    if total_points < MIN_DATA_POINTS:
        return (PLATFORM_DEFAULT_HOURS.get(platform) or GENERIC_HOURS)[:count]
    averages = {hour: sum(values) / len(values) for hour, values in data.items()}
    ranked = sorted(averages, key=lambda h: averages[h], reverse=True)
    return sorted(ranked[:count])


def best_times(org_id: str, platform: str, tz: str = "UTC", count: int = 3) -> list[str]:
    return [f"{h:02d}:00" for h in best_hours(org_id, platform, tz, count)]
