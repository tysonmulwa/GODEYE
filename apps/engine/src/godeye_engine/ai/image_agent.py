"""Image Agent — turns a business profile + brief into a strong image prompt.

Uses the text LLM to expand a short brief into a detailed, on-brand image
generation prompt, then hands that to the image provider.

The prompt is the whole product here. An image model given a vague brief
produces the safest thing it knows, which is why two different posts came back
as near-identical stock compositions: hands reaching toward each other, split
warm and cool lighting, bokeh. Nobody stops scrolling for that. So this asks for
a specific person doing a specific thing in a specific place, names the clichés
it must not fall back on, and varies the framing between calls.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any

from . import creative_strategy, mission, provider

# Rotated per call so repeated briefs do not converge on one composition. Each
# forces a genuinely different camera position rather than a different adjective.
SHOT_TYPES: tuple[str, ...] = (
    "tight portrait, subject looking straight down the lens, filling the frame",
    "wide environmental shot that shows the place as much as the person",
    "candid documentary moment, subject unaware of the camera, caught mid-action",
    "over-the-shoulder view of the subject's hands doing the actual work",
    "low angle looking up, subject framed against sky or ceiling",
    "overhead flat lay, objects arranged deliberately on a real surface",
    "street-level scene with real passers-by out of focus behind the subject",
    "two people mid-conversation, one listening, caught between words",
)

# Named explicitly because these are exactly what the model reaches for when a
# brief is abstract, and what made every earlier image look like the last one.
BANNED_CLICHES = (
    "hands reaching toward each other or fingertips almost touching, "
    "a face split between warm and cool light, silhouettes against a sunset, "
    "glowing abstract networks or world maps, lens flare, "
    "anonymous business people shaking hands, and generic heavy bokeh used to "
    "hide an empty background"
)

PROMPT_SYSTEM = mission.charter("image") + "\n\n" + (
    "You are a creative director briefing a photographer. Two jobs, in order.\n\n"
    "FIRST, decide what the picture is for. You are given the business, the "
    "audience, and a creative category to work inside. Work out what this "
    "customer actually wants, what stands in their way, and the single visual "
    "hook that would stop a thumb. Photograph the outcome the customer is "
    "buying rather than the thing being sold: the confidence rather than the "
    "gym, the table of people rather than the plate of food, the life in the "
    "house rather than the house.\n\n"
    "Reply in exactly this form, with nothing before it:\n"
    "ANGLE: <two or three words>\n"
    "HOOK: <one short sentence naming what stops the scroll>\n"
    "PROMPT: <the photographic brief>\n\n"
    "SECOND, write that brief. "
    "You write briefs for a photographer, not descriptions of a concept. A "
    "one-line prompt gives the model nothing to hold onto and it falls back on "
    "stock imagery, so every brief you write is complete.\n\n"
    "Cover all of these, in flowing prose rather than a list:\n"
    "1. SUBJECT. Real people in the frame whenever the subject allows it, each "
    "with an age range, an expression, what they are wearing, and what their "
    "hands are doing. A believable face carries a post; an arrangement of "
    "objects does not. Photorealistic people who could be actual customers, "
    "never a named or recognisable real person or public figure.\n"
    "2. MOMENT. One specific thing happening, caught a second after it started. "
    "Not a theme, not a mood board.\n"
    "3. PLACE. The stated location, named and real: its streets, interiors, "
    "vehicles, plants, weather. Clothing and skin tones that match the audience "
    "described. A business in Nairobi is not illustrated with generic Western "
    "stock imagery, and a business anywhere else is not either.\n"
    "4. LIGHT. Time of day, which direction it comes from, hard or soft, and "
    "what it does to the shadows.\n"
    "5. CAMERA. Framing, how close, the angle, and what falls out of focus.\n"
    "6. TEXTURE. The detail that separates a photograph from a render: skin "
    "with pores and flyaway hair, creased fabric, scuffed leather, condensation, "
    "dust in the air, fingerprints, honest wear on real objects.\n\n"
    f"Never use any of these: {BANNED_CLICHES}.\n"
    "No text, words, signage, logos or watermarks anywhere in the image; "
    "branding is added separately.\n\n"
    "No preamble and no quotes. The three labelled lines and nothing else; the "
    "image prompt after PROMPT: is 70 to 120 words."
)


@dataclass
class ImagePromptRequest:
    brief: str
    style: str | None = None


def build_image_prompt(
    profile: dict[str, Any],
    request: ImagePromptRequest,
    rng: random.Random | None = None,
    recent_prompts: list[str] | None = None,
    platform: str | None = None,
    preset_id: str | None = None,
) -> str:
    """Expand a short brief into a detailed image prompt via the text LLM.

    ``rng`` is injectable so tests can pin the shot type; production leaves it
    to chance, which is the point.

    ``recent_prompts`` are what this business's last few images actually were.
    Rotating the framing alone is not enough, because a model given the same
    brief converges on the same idea and merely photographs it from a new angle.
    Showing it what it already made is the only instruction that reliably
    produces a different picture rather than a different crop.
    """
    picker = rng or random
    context = [
        f"Business: {profile.get('businessName')} ({profile.get('industry')}).",
        f"What they do: {profile.get('description')}",
    ]
    # Location and audience decide who is in the picture and where they are, and
    # were previously left out entirely, so every image was set nowhere in
    # particular and aimed at no one.
    if profile.get("location"):
        context.append(f"Location, and where the photo should be set: {profile['location']}")
    if profile.get("targetAudience"):
        context.append(f"The people this is for, who should be in shot: {profile['targetAudience']}")
    if profile.get("brandVoice"):
        # Flagged as tone, because a voice like "warm and cool" was being read
        # as a lighting instruction and turned up in the image itself.
        context.append(
            f"Brand tone, for mood only and not to be taken as a lighting or "
            f"colour instruction: {profile['brandVoice']}"
        )

    # The idea and the framing are separate choices. Rotating the framing alone
    # gave the same picture from a new angle, which is what the recent-prompt
    # memory below was fighting on its own.
    category = creative_strategy.choose_category(
        creative_strategy.recent_categories(recent_prompts), picker
    )
    negative_space = creative_strategy.negative_space_plan(preset_id, rng=picker)

    style = request.style or "photorealistic editorial photography, natural light"
    parts = [
        "\n".join(context),
        "",
        f"Image brief: {request.brief}",
        f"Visual style: {style}",
        f"Creative category to work inside: {category}",
        f"Use this framing: {picker.choice(SHOT_TYPES)}",
    ]
    if platform and platform.upper() in creative_strategy.PLATFORM_BIAS:
        parts.append(creative_strategy.PLATFORM_BIAS[platform.upper()])
    parts.append(
        f"Composition: {negative_space}"
        if negative_space
        else "Composition: fill the frame. No text is going over this one, so do "
        "not leave empty space waiting for a headline."
    )
    if recent_prompts:
        parts += [
            "",
            "This business's last few images were the following. Yours must be a "
            "different photograph, not the same idea from another angle: change "
            "the subject, what they are doing, the setting and the time of day.",
            # Stripped of their strategy headers: those are bookkeeping, and
            # showing them back would teach the model to write headers rather
            # than photographs.
            *(
                f"- {creative_strategy.strip_header(p)[:200]}"
                for p in recent_prompts[:4]
            ),
        ]
    parts += ["", "Write the image generation prompt now."]
    # 300 truncated these mid-word once the brief became a full photographic
    # description, and the tail is where the texture detail lives, which is the
    # part that stops the render looking synthetic.
    result = provider.complete(PROMPT_SYSTEM, "\n".join(parts), max_tokens=600)
    angle, hook, prompt = _split_reply(result.text)
    # The idea is recorded on the front of the prompt, which is already stored
    # and already read back, so the next image knows what this one was without
    # a new column anywhere.
    header = creative_strategy.format_header(
        creative_strategy.CreativeStrategy(
            objective="",
            audience_desire="",
            audience_problem="",
            angle=angle,
            creative_category=category,
            visual_hook=hook,
            desired_action="",
            platform=platform,
            negative_space=negative_space,
        )
    )
    return f"{header}\n{prompt}"


_ANGLE_RE = re.compile(r"^\s*ANGLE:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_HOOK_RE = re.compile(r"^\s*HOOK:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_PROMPT_RE = re.compile(r"^\s*PROMPT:\s*(.*)$", re.IGNORECASE | re.MULTILINE | re.DOTALL)


def _split_reply(text: str) -> tuple[str, str, str]:
    """Pull the angle, the hook and the brief out of the model's reply.

    A model asked for three labelled parts usually returns three labelled
    parts, and sometimes returns the brief alone. That is not worth failing a
    render over: an unlabelled reply is treated as the brief, and the labels
    fall back to empty, which costs the memory a line and nothing else.
    """
    body = (text or "").strip().strip('"')
    prompt_match = _PROMPT_RE.search(body)
    if not prompt_match:
        return "", "", body
    angle_match = _ANGLE_RE.search(body)
    hook_match = _HOOK_RE.search(body)
    return (
        (angle_match.group(1).strip() if angle_match else ""),
        (hook_match.group(1).strip() if hook_match else ""),
        prompt_match.group(1).strip().strip('"'),
    )


def fallback_prompt(
    profile: dict[str, Any],
    request: ImagePromptRequest,
    rng: random.Random | None = None,
) -> str:
    """Deterministic prompt when no text LLM is available.

    Still names the place and the audience, because without them the image
    model defaults to an American office.
    """
    picker = rng or random
    style = request.style or "photorealistic editorial photography, natural light"
    industry = profile.get("industry", "business")
    parts = [
        f"{request.brief}.",
        f"{picker.choice(SHOT_TYPES)}.",
        f"{style}, shot for a {industry} brand.",
    ]
    if profile.get("location"):
        parts.append(f"Set in {profile['location']}, with people and surroundings that belong there.")
    if profile.get("targetAudience"):
        parts.append(f"The people in shot are {profile['targetAudience']}.")
    parts.append("Real faces, natural expressions, no text or logos anywhere in the image.")
    return " ".join(parts)
