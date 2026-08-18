"""Content generation task. Content Agent → ContentItem row → realtime event."""

from __future__ import annotations

import logging
import time

from sqlalchemy import select, update

from ..ai import content_agent
from ..celery_app import app
from ..db import (
    AgentRun,
    BusinessProfile,
    ContentItem,
    Organization,
    UsageRecord,
    get_session,
    new_id,
    utcnow,
)
from ..events import publish_event

logger = logging.getLogger(__name__)


@app.task(name="godeye_engine.tasks.content.generate_content", bind=True)
def generate_content(
    self,
    agent_run_id: str,
    org_id: str,
    goal: str,
    platforms: list[str],
    tone: str | None = None,
    topic: str | None = None,
    call_to_action: str | None = None,
    ab_test: bool = False,
) -> dict:
    started = time.monotonic()

    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(status="RUNNING", taskId=self.request.id)
        )
        profile_row = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()
        org_type = session.execute(
            select(Organization.c.type).where(Organization.c.id == org_id)
        ).scalar()
        session.commit()

    if profile_row is None:
        _fail_run(agent_run_id, org_id, "Business profile not found")
        return {"status": "FAILED"}

    profile = {**dict(profile_row), "orgType": org_type or "BUSINESS"}

    try:
        result = content_agent.generate(
            profile,
            content_agent.ContentRequest(
                goal=goal,
                platforms=platforms,
                tone=tone,
                topic=topic,
                call_to_action=call_to_action,
                ab_test=ab_test,
            ),
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Content generation failed for run %s", agent_run_id)
        _fail_run(agent_run_id, org_id, str(e))
        return {"status": "FAILED", "error": str(e)}

    duration_ms = int((time.monotonic() - started) * 1000)
    content_id = new_id()
    now = utcnow()

    with get_session() as session:
        session.execute(
            ContentItem.insert().values(
                id=content_id,
                orgId=org_id,
                type="SOCIAL_POST",
                status="DRAFT",
                title=result.title,
                body=result.body,
                hashtags=result.hashtags,
                variants=result.variants,
                abVariants=result.ab_variants,
                evergreen=False,
                aiGenerated=True,
                agentRunId=agent_run_id,
                createdAt=now,
                updatedAt=now,
            )
        )
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(
                status="SUCCEEDED",
                output={"contentItemId": content_id, "title": result.title},
                provider=result.llm.provider,
                model=result.llm.model,
                inputTokens=result.llm.input_tokens,
                outputTokens=result.llm.output_tokens,
                costUsd=round(result.llm.cost_usd, 6),
                durationMs=duration_ms,
                completedAt=now,
            )
        )
        session.execute(
            UsageRecord.insert().values(
                id=new_id(),
                orgId=org_id,
                metric="ai_tokens",
                quantity=result.llm.input_tokens + result.llm.output_tokens,
                periodStart=now.replace(day=1, hour=0, minute=0, second=0, microsecond=0),
                createdAt=now,
            )
        )
        session.commit()

    publish_event(
        org_id,
        {
            "type": "agent_run.completed",
            "agentRunId": agent_run_id,
            "status": "SUCCEEDED",
            "contentItemId": content_id,
        },
    )
    return {"status": "SUCCEEDED", "contentItemId": content_id}


def _fail_run(agent_run_id: str, org_id: str, error: str) -> None:
    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(status="FAILED", error=error[:2000], completedAt=utcnow())
        )
        session.commit()
    publish_event(
        org_id,
        {"type": "agent_run.completed", "agentRunId": agent_run_id, "status": "FAILED"},
    )
