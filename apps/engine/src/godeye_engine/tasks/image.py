"""Image generation task — Image Agent → provider → brand overlay → storage → MediaAsset."""

from __future__ import annotations

import logging
import time

from celery.exceptions import SoftTimeLimitExceeded
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

# Where each stage sits on the bar, measured rather than guessed: a probe of the
# real pipeline put the provider call at roughly 20s against 3s for everything
# else combined. So generation owns the span from 20 to 80, and the steps around
# it are deliberately narrow. Inventing even progress across five equal steps
# would park the bar mid-way for twenty seconds and read as a hang.
STAGES: dict[str, tuple[int, str]] = {
    "prompt": (8, "Writing the image prompt"),
    "generate": (20, "Generating the image"),
    "fit": (80, "Fitting to the preset"),
    "brand": (88, "Applying your brand"),
    "upload": (93, "Uploading"),
}


def _progress(agent_run_id: str, org_id: str, step: str) -> None:
    """Publish which stage this run is on, and how far along that puts it.

    Written to AgentRun.output as well as pushed over the socket, so a browser
    that missed the event still sees the right state when it polls.
    """
    percent, detail = STAGES[step]
    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(output={"progress": step, "detail": detail, "percent": percent})
        )
        session.commit()
    publish_event(
        org_id,
        {
            "type": "agent_run.progress",
            "agentRunId": agent_run_id,
            "step": step,
            "percent": percent,
        },
    )


# One image is a single provider call plus some resizing. If it has not finished
# in five minutes it is not going to, and waiting costs a worker slot that
# scheduled posts also need.
@app.task(
    name="godeye_engine.tasks.image.generate_image",
    bind=True,
    soft_time_limit=5 * 60,
    time_limit=6 * 60,
)
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
        # What this org's last few images actually were, so the agent can be
        # told not to make another one like them.
        recent_prompts = list(
            session.execute(
                select(MediaAsset.c.prompt)
                .where(
                    MediaAsset.c.orgId == org_id,
                    MediaAsset.c.source == "AI_GENERATED",
                    MediaAsset.c.prompt.isnot(None),
                )
                .order_by(MediaAsset.c.createdAt.desc())
                .limit(4)
            ).scalars()
        )
        session.commit()

    profile_dict = dict(profile) if profile else {"industry": "business"}

    try:
        # 1. Expand the brief into a strong prompt (LLM if available, else fallback)
        _progress(agent_run_id, org_id, "prompt")
        try:
            prompt = image_agent.build_image_prompt(
                profile_dict,
                image_agent.ImagePromptRequest(brief=brief, style=style),
                recent_prompts=recent_prompts,
            )
        except Exception as e:  # noqa: BLE001 — text LLM optional for images
            logger.info("Image prompt LLM unavailable (%s); using fallback prompt", e)
            prompt = image_agent.fallback_prompt(
                profile_dict, image_agent.ImagePromptRequest(brief=brief, style=style)
            )

        # 2. Generate at the closest provider size, then fit exactly to the preset
        _progress(agent_run_id, org_id, "generate")
        provider_size = presets.closest_provider_size(preset.width, preset.height)
        result = image_provider.generate_image(prompt, provider_size)
        _progress(agent_run_id, org_id, "fit")
        image_bytes = branding.fit_to_preset(result.data, preset)

        # 3. Optional brand overlay
        if apply_brand and brand:
            _progress(agent_run_id, org_id, "brand")
            logo_bytes = None
            if brand["logoStorageKey"]:
                try:
                    logo_bytes = download_bytes(brand["logoStorageKey"])
                except Exception as e:  # noqa: BLE001
                    logger.warning("Brand logo download failed: %s", e)
            image_bytes = branding.apply_brand(
                image_bytes, logo_bytes, brand["primaryColor"]
            )
    except SoftTimeLimitExceeded:
        # Raised inside the task, so this handler runs, the run is marked FAILED
        # and the message is acked. Left to the hard limit the worker would be
        # killed and task_acks_late would hand the same job to the next worker.
        logger.warning("Image generation timed out for run %s", agent_run_id)
        detail = (
            "The image provider did not respond in time. This usually means the "
            "model name is wrong for the installed SDK, or the provider is "
            "degraded. Check OPENAI_IMAGE_MODEL on the worker service."
        )
        _fail_run(agent_run_id, org_id, detail)
        return {"status": "FAILED", "error": detail}
    except Exception as e:  # noqa: BLE001
        logger.exception("Image generation failed for run %s", agent_run_id)
        _fail_run(agent_run_id, org_id, str(e))
        return {"status": "FAILED", "error": str(e)}

    # 4. Upload + persist.
    #
    # Inside the same try as everything above. It used to sit outside it, so an
    # upload failure escaped the task without ever calling _fail_run: the run
    # stayed RUNNING with no error and no completedAt, the UI span forever, and
    # the worker carried on to the next job looking perfectly healthy. Storage
    # credentials are the likely thing to be missing here, and being told that
    # is the entire difference between a two-minute fix and an afternoon.
    try:
        _progress(agent_run_id, org_id, "upload")
        # JPEG, not PNG: TikTok's photo endpoint rejects PNG with
        # file_format_check_failed, and the file is a fraction of the size for
        # no visible difference at these dimensions.
        image_bytes = branding.to_jpeg(image_bytes)
        now = utcnow()
        media_id = new_id()
        key = f"{org_id}/generated/{media_id}.jpg"
        url = upload_bytes(key, image_bytes, "image/jpeg")
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
                    mimeType="image/jpeg",
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
    except Exception as e:  # noqa: BLE001
        logger.exception("Storing generated image failed for run %s", agent_run_id)
        _fail_run(agent_run_id, org_id, _storage_error(e))
        return {"status": "FAILED", "error": str(e)}


def _storage_error(e: Exception) -> str:
    """Name the likely cause when the image was made but could not be stored.

    The picture already exists at this point and the provider was paid for it,
    so the failure is local: object storage. The Celery worker is a separate
    deployment from the engine API, and only the API's own upload endpoint is
    exercised by normal use, so the worker's storage settings can be wrong
    without anyone noticing until an agent tries to write.
    """
    return (
        f"The image was generated but could not be stored: {e}. "
        "Uploads run in the Celery worker, which is a separate deployment from "
        "the engine API and needs its own storage settings. Check "
        "STORAGE_BACKEND, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET "
        "and S3_PUBLIC_URL on the worker service."
    )


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
