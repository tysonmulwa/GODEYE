"""Video Agent — turns a brief into a structured short-video script.

The script is a list of scenes; each scene carries narration (spoken by TTS),
a visual prompt (rendered by the image provider), and optional on-screen text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from . import provider
from .content_agent import parse_response  # tolerant JSON extraction

SYSTEM_PROMPT = """You are the Video Agent of GODEYE, an AI marketing platform. \
You write scripts for short vertical social videos (TikTok / Reels / Shorts) that \
hook viewers in the first two seconds and hold attention to the end. \
You respond ONLY with valid JSON — no markdown fences, no commentary."""

MIN_SCENES = 2
MAX_SCENES = 8
# ~2.6 words/second is a comfortable TTS narration pace.
WORDS_PER_SECOND = 2.6


@dataclass
class Scene:
    narration: str
    visual_prompt: str
    on_screen_text: str | None = None


@dataclass
class VideoScript:
    title: str
    hook: str
    scenes: list[Scene]
    cta: str
    hashtags: list[str] = field(default_factory=list)

    @property
    def full_narration(self) -> str:
        return " ".join(s.narration for s in self.scenes)


def build_prompt(profile: dict[str, Any], brief: str, duration_sec: int, style: str | None) -> str:
    scene_count = max(MIN_SCENES, min(MAX_SCENES, duration_sec // 8 + 1))
    total_words = int(duration_sec * WORDS_PER_SECOND)
    lines = [
        "Write a short-video script for this business:",
        "",
        f"Business: {profile.get('businessName')} ({profile.get('industry')})",
        f"What they do: {profile.get('description')}",
        f"Target audience: {profile.get('targetAudience')}",
    ]
    if profile.get("brandVoice"):
        lines.append(f"Brand voice: {profile['brandVoice']}")
    lines += [
        "",
        f"Video brief: {brief}",
        f"Target length: {duration_sec} seconds (~{total_words} spoken words TOTAL across all scenes).",
        f"Scene count: exactly {scene_count} scenes.",
        f"Visual style for scene images: {style or 'clean, vibrant, photorealistic'}",
        "",
        "Respond with EXACTLY this JSON shape:",
        json.dumps(
            {
                "title": "internal title",
                "hook": "the first scene's opening line — must grab attention instantly",
                "scenes": [
                    {
                        "narration": "spoken words for this scene",
                        "visualPrompt": "detailed image-generation prompt for the scene background (no text in image)",
                        "onScreenText": "3-6 word caption overlay or null",
                    }
                ],
                "cta": "closing call to action (also the last scene's narration ending)",
                "hashtags": ["tag1", "tag2"],
            },
            indent=2,
        ),
        "",
        "Rules: scene 1 narration MUST start with the hook; keep narration conversational",
        "and punchy; visualPrompt must describe imagery only (no words/logos in the image);",
        "hashtags without the # prefix.",
    ]
    return "\n".join(lines)


def normalize_script(raw: dict[str, Any]) -> VideoScript:
    """Validate + clamp the model output into a usable script."""
    scenes_raw = raw.get("scenes") or []
    if not isinstance(scenes_raw, list) or not scenes_raw:
        raise ValueError("Script has no scenes")
    scenes: list[Scene] = []
    for item in scenes_raw[:MAX_SCENES]:
        narration = str(item.get("narration") or "").strip()
        visual = str(item.get("visualPrompt") or "").strip()
        if not narration or not visual:
            continue
        text = item.get("onScreenText")
        scenes.append(
            Scene(
                narration=narration,
                visual_prompt=visual,
                on_screen_text=str(text).strip() if text else None,
            )
        )
    if len(scenes) < MIN_SCENES:
        raise ValueError(f"Script needs at least {MIN_SCENES} usable scenes, got {len(scenes)}")
    return VideoScript(
        title=str(raw.get("title") or "Untitled video"),
        hook=str(raw.get("hook") or scenes[0].narration),
        scenes=scenes,
        cta=str(raw.get("cta") or ""),
        hashtags=[str(t).lstrip("#") for t in (raw.get("hashtags") or [])][:20],
    )


def generate_script(
    profile: dict[str, Any], brief: str, duration_sec: int, style: str | None = None
) -> tuple[VideoScript, provider.LlmResult]:
    prompt = build_prompt(profile, brief, duration_sec, style)
    llm = provider.complete(SYSTEM_PROMPT, prompt, max_tokens=2000)
    script = normalize_script(parse_response(llm.text))
    return script, llm
