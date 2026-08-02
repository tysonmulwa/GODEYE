"""Autopilot planner — turns PostingPlans into generated, scheduled content.

Every 5 minutes Beat runs plan_autopilot: for each active plan with
autoGenerate, it computes upcoming publish slots (preferred times, or
engagement-driven best times) and dispatches one autopilot_generate task per
slot. That task writes the content with the Content Agent and creates the
ScheduledPost rows the regular scheduler then publishes.
"""

from __future__ import annotations

import logging
from datetime import datetime, time as dt_time, timedelta
from zoneinfo import ZoneInfo

from croniter import croniter
from sqlalchemy import select, update

from .. import intel
from ..ai import content_agent
from ..celery_app import app
from ..media import presets
from ..db import (
    AgentRun,
    BusinessProfile,
    ContentItem,
    Organization,
    PostingPlan,
    ScheduledPost,
    SocialConnection,
    get_session,
    new_id,
    utcnow,
)
from ..events import publish_event

logger = logging.getLogger(__name__)

MAX_SLOTS_PER_RUN = 6
PLAN_HORIZON_HOURS = 24
RECYCLE_AFTER_DAYS = 7

CADENCE_TIMES_PER_DAY = {"DAILY_1": 1, "DAILY_2": 2, "DAILY_3": 3}


def compute_slots(
    cadence: str,
    custom_cron: str | None,
    preferred_times: list[str],
    tz: str,
    start_utc: datetime,
    end_utc: datetime,
    fallback_hours: list[int],
) -> list[datetime]:
    """UTC-naive publish slots in (start_utc, end_utc], honoring the plan timezone."""
    zone = ZoneInfo(tz)
    start_local = start_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone)
    end_local = end_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone)

    if cadence == "CUSTOM":
        if not custom_cron:
            return []
        slots = []
        cron = croniter(custom_cron, start_local)
        while True:
            nxt = cron.get_next(datetime)
            if nxt > end_local:
                break
            slots.append(nxt)
        return [s.astimezone(ZoneInfo("UTC")).replace(tzinfo=None) for s in slots]

    if cadence == "HOURLY":
        first = (start_local + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        slots = []
        cursor = first
        while cursor <= end_local:
            slots.append(cursor)
            cursor += timedelta(hours=1)
        return [s.astimezone(ZoneInfo("UTC")).replace(tzinfo=None) for s in slots]

    # Daily N / weekends: concrete local times per qualifying day
    times_per_day = CADENCE_TIMES_PER_DAY.get(cadence, 1)
    weekend_only = cadence == "WEEKENDS"
    day_times = sorted(preferred_times) or [f"{h:02d}:00" for h in fallback_hours]
    day_times = day_times[: max(times_per_day, len(day_times) if weekend_only else times_per_day)]
    if not weekend_only:
        day_times = day_times[:times_per_day]

    slots = []
    day = start_local.date()
    while True:
        for hhmm in day_times:
            hour, minute = int(hhmm[:2]), int(hhmm[3:5])
            candidate = datetime.combine(day, dt_time(hour, minute), tzinfo=zone)
            if candidate <= start_local or candidate > end_local:
                continue
            if weekend_only and candidate.weekday() not in (5, 6):
                continue
            slots.append(candidate)
        day += timedelta(days=1)
        if datetime.combine(day, dt_time(0, 0), tzinfo=zone) > end_local:
            break
    return [s.astimezone(ZoneInfo("UTC")).replace(tzinfo=None) for s in sorted(slots)]


@app.task(name="godeye_engine.tasks.planner.plan_autopilot")
def plan_autopilot() -> int:
    now = utcnow()
    horizon = now + timedelta(hours=PLAN_HORIZON_HOURS)

    with get_session() as session:
        plans = session.execute(
            select(PostingPlan).where(
                PostingPlan.c.active.is_(True), PostingPlan.c.autoGenerate.is_(True)
            )
        ).mappings().all()

    planned = 0
    for plan in plans:
        start = max(plan["lastPlannedAt"] or now, now)
        fallback = intel.best_hours(
            plan["orgId"],
            plan["platforms"][0] if plan["platforms"] else "FACEBOOK",
            plan["timezone"],
        )
        slots = compute_slots(
            plan["cadence"],
            plan["customCron"],
            plan["preferredTimes"],
            plan["timezone"],
            start,
            horizon,
            fallback,
        )[:MAX_SLOTS_PER_RUN]
        if not slots:
            continue

        for index, slot in enumerate(slots):
            autopilot_generate.delay(plan["id"], slot.isoformat(), index)
        with get_session() as session:
            session.execute(
                update(PostingPlan)
                .where(PostingPlan.c.id == plan["id"])
                .values(lastPlannedAt=max(slots), updatedAt=utcnow())
            )
            session.commit()
        planned += len(slots)
        logger.info("Plan %s: queued %d slot(s)", plan["name"], len(slots))
    return planned


@app.task(name="godeye_engine.tasks.planner.autopilot_generate")
def autopilot_generate(plan_id: str, slot_iso: str, slot_index: int = 0) -> dict:
    slot = datetime.fromisoformat(slot_iso)
    with get_session() as session:
        plan = session.execute(
            select(PostingPlan).where(PostingPlan.c.id == plan_id)
        ).mappings().first()
        if plan is None or not plan["active"]:
            return {"status": "skipped", "reason": "plan gone or inactive"}
        profile = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == plan["orgId"])
        ).mappings().first()
        connections = session.execute(
            select(SocialConnection).where(
                SocialConnection.c.orgId == plan["orgId"],
                SocialConnection.c.status == "ACTIVE",
                SocialConnection.c.platform.in_(plan["platforms"]),
            )
        ).mappings().all()
        org = session.execute(
            select(Organization.c.type, Organization.c.requireApproval).where(
                Organization.c.id == plan["orgId"]
            )
        ).mappings().first()

    require_approval = bool(org and org["requireApproval"])
    if profile is None or not connections:
        # Silence here looks exactly like autopilot being broken: the slot is
        # consumed, nothing is produced, and nothing anywhere says why. Both
        # causes are fixable by the user once they know which one it is.
        reason = (
            "the workspace has no business profile"
            if profile is None
            else f"no ACTIVE connection matches the plan's platforms {list(plan['platforms'])}"
        )
        logger.warning(
            "Autopilot skipped a slot for plan %r: %s", plan["name"], reason
        )
        return {"status": "skipped", "reason": reason}

    topics = plan["topics"] or []
    topic = topics[slot_index % len(topics)] if topics else None
    goals = profile["goals"] or ["Grow the audience and promote the business"]
    goal = goals[slot_index % len(goals)]

    request = content_agent.ContentRequest(
        goal=f"Autopilot post for plan '{plan['name']}': {goal}",
        platforms=list(plan["platforms"]),
        topic=topic,
        ab_test=bool(plan["abTesting"]),
    )
    try:
        result = content_agent.generate(
            {**dict(profile), "orgType": (org["type"] if org else None) or "BUSINESS"}, request
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Autopilot generation failed for plan %s", plan_id)
        return {"status": "FAILED", "error": str(e)}

    now = utcnow()
    content_id = new_id()
    run_id = new_id()
    # Approval-gated orgs get a review stop: content waits in PENDING_APPROVAL and
    # the dispatcher holds its (already booked) slots until an admin approves.
    content_status = "PENDING_APPROVAL" if require_approval else "SCHEDULED"
    with get_session() as session:
        session.execute(
            AgentRun.insert().values(
                id=run_id,
                orgId=plan["orgId"],
                agent="CONTENT",
                status="SUCCEEDED",
                input={"autopilot": True, "planId": plan_id, "goal": goal, "topic": topic},
                output={"contentItemId": content_id},
                provider=result.llm.provider,
                model=result.llm.model,
                inputTokens=result.llm.input_tokens,
                outputTokens=result.llm.output_tokens,
                costUsd=round(result.llm.cost_usd, 6),
                createdAt=now,
                completedAt=now,
            )
        )
        session.execute(
            ContentItem.insert().values(
                id=content_id,
                orgId=plan["orgId"],
                type="SOCIAL_POST",
                status=content_status,
                title=result.title,
                body=result.body,
                hashtags=result.hashtags,
                variants=result.variants,
                abVariants=result.ab_variants,
                evergreen=False,
                aiGenerated=True,
                agentRunId=run_id,
                submittedAt=now if require_approval else None,
                createdAt=now,
                updatedAt=now,
            )
        )
        for index, conn in enumerate(connections):
            variant_key = None
            if plan["abTesting"] and result.ab_variants:
                variant_key = "A" if index % 2 == 0 else "B"
            session.execute(
                ScheduledPost.insert().values(
                    id=new_id(),
                    orgId=plan["orgId"],
                    contentItemId=content_id,
                    connectionId=conn["id"],
                    scheduledAt=slot,
                    timezone=plan["timezone"],
                    status="PENDING",
                    variantKey=variant_key,
                    planId=plan_id,
                    attempts=0,
                    createdAt=now,
                    updatedAt=now,
                )
            )
        session.commit()

    # Optionally generate an on-brand image and attach it to this post.
    if plan["generateImages"]:
        _queue_image_for_content(plan, content_id, result.title, topic or goal, connections)

    publish_event(
        plan["orgId"],
        {"type": "scheduled_post.updated", "scheduledPostId": content_id, "status": "PENDING"},
    )
    logger.info(
        "Autopilot: '%s' %s to %d connection(s) at %s",
        result.title,
        "awaiting approval, slots booked" if require_approval else "scheduled",
        len(connections),
        slot,
    )
    return {
        "status": "PENDING_APPROVAL" if require_approval else "SCHEDULED",
        "contentItemId": content_id,
        "connections": len(connections),
    }


def _queue_image_for_content(
    plan: dict, content_id: str, title: str, brief: str, connections: list
) -> None:
    """Create an IMAGE AgentRun and dispatch generation for an autopilot post."""
    from .image import generate_image

    now = utcnow()
    run_id = new_id()
    platform = plan["platforms"][0] if plan["platforms"] else "INSTAGRAM"
    preset_id = presets.PLATFORM_DEFAULT_PRESET.get(platform, "SQUARE")

    with get_session() as session:
        session.execute(
            AgentRun.insert().values(
                id=run_id,
                orgId=plan["orgId"],
                agent="IMAGE",
                status="QUEUED",
                input={"autopilot": True, "contentItemId": content_id, "brief": brief},
                createdAt=now,
            )
        )
        session.commit()

    generate_image.delay(
        agent_run_id=run_id,
        org_id=plan["orgId"],
        brief=f"{title}. {brief}",
        preset_id=preset_id,
        content_item_id=content_id,
        apply_brand=True,  # no-ops if the org has no brand kit/logo
    )


@app.task(name="godeye_engine.tasks.planner.recycle_evergreen")
def recycle_evergreen() -> int:
    """Requeue proven evergreen content for plans that opted in (max 1 per plan/run)."""
    now = utcnow()
    cutoff = now - timedelta(days=RECYCLE_AFTER_DAYS)

    with get_session() as session:
        plans = session.execute(
            select(PostingPlan).where(
                PostingPlan.c.active.is_(True), PostingPlan.c.recycleEvergreen.is_(True)
            )
        ).mappings().all()

    recycled = 0
    for plan in plans:
        with get_session() as session:
            content = session.execute(
                select(ContentItem)
                .where(
                    ContentItem.c.orgId == plan["orgId"],
                    ContentItem.c.evergreen.is_(True),
                    ContentItem.c.status == "PUBLISHED",
                    (ContentItem.c.lastRecycledAt.is_(None))
                    | (ContentItem.c.lastRecycledAt < cutoff),
                    ContentItem.c.updatedAt < cutoff,
                )
                .order_by(ContentItem.c.lastRecycledAt.asc().nullsfirst())
                .limit(1)
            ).mappings().first()
            if content is None:
                continue
            connections = session.execute(
                select(SocialConnection.c.id).where(
                    SocialConnection.c.orgId == plan["orgId"],
                    SocialConnection.c.status == "ACTIVE",
                    SocialConnection.c.platform.in_(plan["platforms"]),
                )
            ).fetchall()
            if not connections:
                continue

            hour = intel.best_hours(
                plan["orgId"],
                plan["platforms"][0],
                plan["timezone"],
                count=1,
            )[0]
            zone = ZoneInfo(plan["timezone"])
            local_tomorrow = (now.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone) + timedelta(days=1)).replace(
                hour=hour, minute=0, second=0, microsecond=0
            )
            slot = local_tomorrow.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)

            for conn in connections:
                session.execute(
                    ScheduledPost.insert().values(
                        id=new_id(),
                        orgId=plan["orgId"],
                        contentItemId=content["id"],
                        connectionId=conn.id,
                        scheduledAt=slot,
                        timezone=plan["timezone"],
                        status="PENDING",
                        planId=plan["id"],
                        attempts=0,
                        createdAt=now,
                        updatedAt=now,
                    )
                )
            session.execute(
                update(ContentItem)
                .where(ContentItem.c.id == content["id"])
                .values(lastRecycledAt=now, updatedAt=now)
            )
            session.commit()
            recycled += 1
            logger.info("Recycled evergreen '%s' for plan %s", content["title"], plan["name"])
    return recycled
