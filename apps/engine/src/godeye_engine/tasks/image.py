"""Image generation task — Image Agent → provider → brand overlay → storage → MediaAsset."""

from __future__ import annotations

import logging
import time

from sqlalchemy import select, update

from ..ai import image_agent, image_provider
from ..celery_app import app
from ..db import (
    AgentRun,
    BrandKit,
    BusinessProfile,
    MediaAsset,
    UsageRecord,
    get_session,
    new_id,
    utcnow,
)
from ..events import publish_event
from ..media import branding, presets
from ..storage import download_bytes, upload_bytes

logger = logging.getLogger(__name__)


@app.task(name="godeye_engine.tasks.image.generate_image", bind=True)
def generate_image(
    self,
    agent_run_id: str,
    org_id: str,
    brief: str,
    preset_id: str = "SQUARE",
    style: str | None = None,
    content_item_id: str | None = None,
    apply_brand: bool = False,
) -> dict:
    started = time.monotonic()
    preset = presets.get_preset(preset_id)

    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(status="RUNNING", taskId=self.request.id)
        )
        profile = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()
        brand = session.execute(
            select(BrandKit).where(BrandKit.c.orgId == org_id)
        ).mappings().first()
        session.commit()

    profile_dict = dict(profile) if profile else {"industry": "business"}

    try:
        # 1. Expand the brief into a strong prompt (LLM if available, else fallback)
        try:
            prompt = image_agent.build_image_prompt(
                profile_dict, image_agent.ImagePromptRequest(brief=brief, style=style)
            )
        except Exception as e:  # noqa: BLE001 — text LLM optional for images
            logger.info("Image prompt LLM unavailable (%s); using fallback prompt", e)
            prompt = image_agent.fallback_prompt(
                profile_dict, image_agent.ImagePromptRequest(brief=brief, style=style)
            )

        # 2. Generate at the closest provider size, then fit exactly to the preset
        provider_size = presets.closest_provider_size(preset.width, preset.height)
        result = image_provider.generate_image(prompt, provider_size)
        image_bytes = branding.fit_to_preset(result.data, preset)

        # 3. Optional brand overlay
        if apply_brand and brand:
            logo_bytes = None
            if brand["logoStorageKey"]:
                try:
                    logo_bytes = download_bytes(brand["logoStorageKey"])
                except Exception as e:  # noqa: BLE001
                    logger.warning("Brand logo download failed: %s", e)
            image_bytes = branding.apply_brand(
                image_bytes, logo_bytes, brand["primaryColor"]
            )
    except Exception as e:  # noqa: BLE001
        logger.exception("Image generation failed for run %s", agent_run_id)
        _fail_run(agent_run_id, org_id, str(e))
        return {"status": "FAILED", "error": str(e)}

    # 4. Upload + persist
    now = utcnow()
    media_id = new_id()
    key = f"{org_id}/generated/{media_id}.png"
    url = upload_bytes(key, image_bytes, "image/png")
    duration_ms = int((time.monotonic() - started) * 1000)

    with get_session() as session:
        session.execute(
            MediaAsset.insert().values(
                id=media_id,
                orgId=org_id,
                contentItemId=content_item_id,
                kind="IMAGE",
                source="AI_GENERATED",
                storageKey=key,
                url=url,
                mimeType="image/png",
                sizeBytes=len(image_bytes),
                width=preset.width,
                height=preset.height,
                prompt=prompt,
                preset=preset_id,
                agentRunId=agent_run_id,
                metadata={"provider": result.provider, "model": result.model},
                createdAt=now,
            )
        )
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(
                status="SUCCEEDED",
                output={"mediaAssetId": media_id, "url": url, "prompt": prompt},
                provider=result.provider,
                model=result.model,
                costUsd=round(result.cost_usd, 6),
                durationMs=duration_ms,
                completedAt=now,
            )
        )
        session.execute(
            UsageRecord.insert().values(
                id=new_id(),
                orgId=org_id,
                metric="images_generated",
                quantity=1,
                periodStart=now.replace(day=1, hour=0, minute=0, second=0, microsecond=0),
                createdAt=now,
            )
        )
        session.commit()

    publish_event(
        org_id,
        {
            "type": "media_asset.created",
            "agentRunId": agent_run_id,
            "mediaAssetId": media_id,
            "url": url,
        },
    )
    logger.info("Generated image %s (%s) for org %s", media_id, preset_id, org_id)
    return {"status": "SUCCEEDED", "mediaAssetId": media_id, "url": url}


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
