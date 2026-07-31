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
from dataclasses import dataclass
from typing import Any

from . import mission, provider

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
    "You write briefs for a photographer, not descriptions of a concept.\n\n"
    "Rules:\n"
    "1. Put real people in the frame whenever the subject allows it. Give each "
    "an age range, an expression, what they are wearing, and what they are "
    "doing with their hands. A believable face carries a post; an abstract "
    "arrangement of objects does not.\n"
    "2. Photorealistic people who could be actual customers. Never a named or "
    "recognisable real person, and never a public figure.\n"
    "3. Ground it in the stated location. Real streets, real interiors, clothing "
    "and skin tones that match the audience described. A business in Nairobi "
    "should not be illustrated with generic Western stock imagery.\n"
    "4. Describe one specific moment, not a theme. Something is happening, and "
    "it happened a second ago.\n"
    "5. Say the light plainly: time of day, where it comes from, hard or soft. "
    f"6. Never use any of these: {BANNED_CLICHES}.\n"
    "7. No text, words, signage, logos or watermarks anywhere in the image; "
    "branding is added separately.\n\n"
    "Return ONLY the image prompt, no preamble and no quotes. Under 90 words."
)


@dataclass
class ImagePromptRequest:
    brief: str
    style: str | None = None


def build_image_prompt(
    profile: dict[str, Any],
    request: ImagePromptRequest,
    rng: random.Random | None = None,
) -> str:
    """Expand a short brief into a detailed image prompt via the text LLM.

    ``rng`` is injectable so tests can pin the shot type; production leaves it
    to chance, which is the point.
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

    style = request.style or "photorealistic editorial photography, natural light"
    user = (
        "\n".join(context)
        + f"\n\nImage brief: {request.brief}"
        + f"\nVisual style: {style}"
        + f"\nUse this framing: {picker.choice(SHOT_TYPES)}"
        + "\n\nWrite the image generation prompt now."
    )
    result = provider.complete(PROMPT_SYSTEM, user, max_tokens=300)
    return result.text.strip().strip('"')


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
