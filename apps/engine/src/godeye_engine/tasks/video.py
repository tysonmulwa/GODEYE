"""Video generation task: script → scene images → voiceover → subtitles → ffmpeg → storage.

Progress is written to AgentRun.output.progress so the UI can show pipeline steps
while polling; the final MediaAsset carries the mp4.
"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path

from sqlalchemy import select, update

from ..ai import image_provider, tts_provider, video_agent
from ..celery_app import app
from ..db import (
    AgentRun,
    BusinessProfile,
    MediaAsset,
    UsageRecord,
    get_session,
    new_id,
    utcnow,
)
from ..events import publish_event
from ..media import branding, presets, subtitles, video
from ..storage import upload_bytes

logger = logging.getLogger(__name__)


# Scene rendering dominates: each scene is an image call plus a TTS call, so a
# four-scene video spends most of its minutes between 10 and 70. The remaining
# steps are ffmpeg passes over local files and are quick by comparison.
STAGE_PERCENT: dict[str, int] = {
    "script": 5,
    "scenes": 10,  # 10 to 70, split across the scenes
    "assembly": 75,
    "captions": 85,
    "upload": 92,
}
SCENES_SPAN = 60


def _progress(
    agent_run_id: str,
    org_id: str,
    step: str,
    detail: str = "",
    percent: int | None = None,
) -> None:
    if percent is None:
        percent = STAGE_PERCENT.get(step, 0)
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


@app.task(name="godeye_engine.tasks.video.generate_video", bind=True)
def generate_video(
    self,
    agent_run_id: str,
    org_id: str,
    brief: str,
    preset_id: str = "VERTICAL",
    duration_sec: int = 30,
    voice: str = "nova",
    style: str | None = None,
    include_captions: bool = True,
    content_item_id: str | None = None,
) -> dict:
    started = time.monotonic()
    preset = video.get_video_preset(preset_id)

    with get_session() as session:
        session.execute(
            update(AgentRun)
            .where(AgentRun.c.id == agent_run_id)
            .values(status="RUNNING", taskId=self.request.id)
        )
        profile = session.execute(
            select(BusinessProfile).where(BusinessProfile.c.orgId == org_id)
        ).mappings().first()
        session.commit()

    profile_dict = dict(profile) if profile else {"industry": "business"}
    total_cost = 0.0

    try:
        # ffmpeg must exist before we spend money on generation
        video.locate_ffmpeg()

        # 1. Script
        _progress(agent_run_id, org_id, "script", "Writing the script")
        script, llm = video_agent.generate_script(profile_dict, brief, duration_sec, style)
        total_cost += llm.cost_usd

        with tempfile.TemporaryDirectory(prefix="godeye-video-") as tmp:
            tmpdir = Path(tmp)
            scene_files: list[tuple[Path, Path, float]] = []  # (image, audio, duration)

            # 2. Scene visuals + narration audio
            image_preset = presets.Preset(
                id=preset.id, label="video-frame",
                width=preset.width, height=preset.height,
                aspect="",
            )
            for i, scene in enumerate(script.scenes):
                _progress(
                    agent_run_id, org_id, "scenes",
                    f"Scene {i + 1}/{len(script.scenes)}: image + voiceover",
                    percent=STAGE_PERCENT["scenes"]
                    + int(SCENES_SPAN * i / max(1, len(script.scenes))),
                )
                img = image_provider.generate_image(
                    scene.visual_prompt,
                    presets.closest_provider_size(preset.width, preset.height),
                )
                total_cost += img.cost_usd
                image_bytes = branding.fit_to_preset(img.data, image_preset)
                image_path = tmpdir / f"scene{i}.png"
                image_path.write_bytes(image_bytes)

                tts = tts_provider.synthesize(scene.narration, voice)
                total_cost += tts.cost_usd
                audio_path = tmpdir / f"scene{i}.mp3"
                audio_path.write_bytes(tts.data)
                duration = video.probe_duration(str(audio_path)) + 0.3  # breathing room
                scene_files.append((image_path, audio_path, duration))

            # 3. Assemble clips.
            #
            # duration_sec used to be a hint to the script writer and nothing
            # more: whatever length the narration happened to run to was the
            # length the user got. Retime it toward the target instead, within
            # a band small enough to hear as pace rather than distortion.
            narrated = sum(d for _, _, d in scene_files)
            tempo = video.tempo_for_target(narrated, float(duration_sec))
            _progress(
                agent_run_id, org_id, "assembly",
                f"Cutting scenes together (script ran {narrated:.0f}s, "
                f"target {duration_sec}s)",
            )
            clip_paths: list[str] = []
            for i, (image_path, audio_path, duration) in enumerate(scene_files):
                clip = tmpdir / f"clip{i}.mp4"
                video.run(
                    video.scene_clip_cmd(
                        str(image_path), str(audio_path), str(clip),
                        preset.width, preset.height, duration / tempo, tempo,
                    )
                )
                clip_paths.append(str(clip))

            list_file = tmpdir / "concat.txt"
            list_file.write_text(video.concat_list_content(clip_paths), encoding="utf-8")
            joined = tmpdir / "joined.mp4"
            video.run(video.concat_cmd(str(list_file), str(joined)))
            final = joined

            # 4. Subtitles
            if include_captions:
                _progress(agent_run_id, org_id, "captions", "Burning subtitles")
                srt = subtitles.build_srt(
                    [(s.narration, d) for s, (_, _, d) in zip(script.scenes, scene_files)]
                )
                srt_path = tmpdir / "captions.srt"
                srt_path.write_text(srt, encoding="utf-8")
                captioned = tmpdir / "captioned.mp4"
                video.run(
                    video.burn_subtitles_cmd(
                        str(joined), str(srt_path), str(captioned), preset.height
                    )
                )
                final = captioned

            # 5. Upload + persist
            _progress(agent_run_id, org_id, "upload", "Uploading")
            video_bytes = final.read_bytes()
            total_duration = video.probe_duration(str(final))

        now = utcnow()
        media_id = new_id()
        key = f"{org_id}/generated/{media_id}.mp4"
        url = upload_bytes(key, video_bytes, "video/mp4")

        with get_session() as session:
            session.execute(
                MediaAsset.insert().values(
                    id=media_id,
                    orgId=org_id,
                    contentItemId=content_item_id,
                    kind="VIDEO",
                    source="AI_GENERATED",
                    storageKey=key,
                    url=url,
                    mimeType="video/mp4",
                    sizeBytes=len(video_bytes),
                    width=preset.width,
                    height=preset.height,
                    durationSec=round(total_duration, 2),
                    prompt=brief,
                    preset=preset_id,
                    agentRunId=agent_run_id,
                    metadata={
                        "title": script.title,
                        "hook": script.hook,
                        "cta": script.cta,
                        "hashtags": script.hashtags,
                        "scenes": len(script.scenes),
                        "voice": voice,
                    },
                    createdAt=now,
                )
            )
            session.execute(
                update(AgentRun)
                .where(AgentRun.c.id == agent_run_id)
                .values(
                    status="SUCCEEDED",
                    output={
                        "mediaAssetId": media_id,
                        "url": url,
                        "title": script.title,
                        "durationSec": round(total_duration, 2),
                    },
                    provider=llm.provider,
                    model=llm.model,
                    inputTokens=llm.input_tokens,
                    outputTokens=llm.output_tokens,
                    costUsd=round(total_cost, 6),
                    durationMs=int((time.monotonic() - started) * 1000),
                    completedAt=now,
                )
            )
            session.execute(
                UsageRecord.insert().values(
                    id=new_id(),
                    orgId=org_id,
                    metric="videos_generated",
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
        logger.info(
            "Generated video %s (%.1fs, %d scenes) for org %s",
            media_id, total_duration, len(script.scenes), org_id,
        )
        return {"status": "SUCCEEDED", "mediaAssetId": media_id, "url": url}

    except Exception as e:  # noqa: BLE001
        logger.exception("Video generation failed for run %s", agent_run_id)
        with get_session() as session:
            session.execute(
                update(AgentRun)
                .where(AgentRun.c.id == agent_run_id)
                .values(status="FAILED", error=str(e)[:2000], completedAt=utcnow())
            )
            session.commit()
        publish_event(
            org_id,
            {"type": "agent_run.completed", "agentRunId": agent_run_id, "status": "FAILED"},
        )
        return {"status": "FAILED", "error": str(e)}
