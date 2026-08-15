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
    "FIRST, decide what the picture is for. You are given the business, what "
    "it sells, the audience, and a creative category to work inside. Work out "
    "what this customer actually wants, what stands in their way, and the "
    "single visual hook that would stop a thumb. Photograph the outcome the "
    "customer is buying rather than the thing being sold: the confidence "
    "rather than the gym, the table of people rather than the plate of food, "
    "the life in the house rather than the house.\n\n"
    "Think in one customer, not in themes. Pick a single believable person, "
    "the moment they reach for this business, and what is different for them a "
    "second later. A student who needs a laptop that survives four years of "
    "coursework. A woman closing her laptop on a stream that just paid her "
    "rent. A man at a stall holding the pair of trainers he came for. That "
    "person, that moment, and that place are the picture. A theme is not a "
    "picture and a mood is not a picture.\n\n"
    "The picture must SELL the business, not REPRESENT it. Representing it is "
    "photographing the work: the desk, the planning, the tools, the premises, "
    "the staff at their stations. Selling it is photographing what the "
    "customer ends up with. A gym sells the confidence, not the equipment. A "
    "restaurant sells the table of people leaning in over the food, not the "
    "kitchen. An agency sells the client's business visibly winning, not a "
    "content calendar. Ask what the viewer should want after seeing it. "
    "'I want that meal.' 'I want to look like that.' 'I want that life.' "
    "If there is no such answer, the concept is wrong and you must think "
    "again before writing anything.\n\n"
    "But photographing the outcome is not permission to photograph an "
    "abstraction. Whatever you choose, what this business actually sells has "
    "to be identifiable in the frame. A viewer who knows nothing about the "
    "brand should be able to name the industry from the picture alone. If they "
    "cannot, you have drawn a symbol instead of an advertisement, and a symbol "
    "sells nothing. A post about earning from live video calls is a creator "
    "lit by her own ring light watching gifts land, or the moment she sees the "
    "payout on her phone. It is never a wristwatch standing in for success, "
    "never a sunrise standing in for opportunity, never an open road standing "
    "in for freedom. Name the real thing in the brief: the product in someone's "
    "hands, the screen showing the actual result, the room where the service "
    "happens, the money changing hands.\n\n"
    f"Refuse these outright, they are stock imagery and sell nothing: {creative_strategy.STOCK_PATTERNS}. "
    "If your idea could be found in a stock library under the name of the "
    "industry, it has failed and you must replace it.\n\n"
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
    "2. MOMENT. One specific thing happening, caught a second after it "
    "started, and it is the moment the customer gets something. Money or goods "
    "changing hands, a screen showing the result, someone using the thing and "
    "visibly reacting to it, a payout, a delivery, a fitting, a meal arriving, "
    "a choice being made between two options. Marketing photography without "
    "that moment is a portrait, and a portrait sells nothing. Not a theme, not "
    "a mood board.\n"
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
    "Never invent evidence. No customer testimonials, no named or initialled "
    "reviewers, no star ratings, no review cards, no follower or customer "
    "counts, no percentages, no 'trusted by' figures, no awards, no press "
    "logos, and no screenshots of praise. These are fabricated consumer "
    "reviews when the business has not supplied them, which is banned outright "
    "under EU consumer law and the UK Digital Markets, Competition and "
    "Consumers Act, and no amount of visual appeal is worth that to the "
    "business whose name is on the post. Social proof must be photographed "
    "rather than asserted: real customers visibly using or enjoying the thing, "
    "a busy room, a queue, people choosing it. Show the evidence, never write "
    "it.\n\n"
    "No preamble and no quotes. The three labelled lines and nothing else; the "
    "image prompt after PROMPT: is 70 to 120 words."
)


# A real photographic brief is 70 to 120 words. Anything under this is a
# truncated or empty reply, not a short one, and must not reach the image model.
MIN_PROMPT_CHARS = 80


@dataclass
class ImagePromptRequest:
    brief: str
    style: str | None = None


def _listed(value: Any) -> str:
    """A Postgres text[] column as readable prose, empty when there is nothing."""
    if not value:
        return ""
    if isinstance(value, str):
        return value.strip()
    return ", ".join(str(v).strip() for v in value if str(v).strip())


def _business_context(profile: dict[str, Any]) -> list[str]:
    """Everything about the business that changes what the picture should be.

    This was six fields: name, industry, description, location, audience,
    voice. The content agent has always been given more than that, including
    the products and the services, which is why captions knew what the business
    sold and pictures did not.

    That gap is what produced the wristwatch. A post about earning from video
    calls was briefed with a name, the word "Dating" and a caption. Nothing in
    it had ever said stream, gift, video call or payout, so the model reached
    for a generic symbol of success and drew a watch. The products and services
    are the whole subject of a marketing photograph and they were the one thing
    withheld.

    Website and competitors are deliberately still withheld. A URL cannot be
    photographed and this brief forbids text in the frame, so sending one only
    invites the model to draw it; a competitor's name invites their branding.
    """
    is_creator = profile.get("orgType") == "CREATOR"
    context = [
        f"Business: {profile.get('businessName')} ({profile.get('industry')}).",
        f"What they do: {profile.get('description')}",
    ]

    # The subject of the photograph. Named as what a customer pays for, because
    # a bare list reads as things to arrange on a table, which is the stock
    # product shot this brief spends its length trying to prevent.
    products = _listed(profile.get("products"))
    services = _listed(profile.get("services"))
    if products:
        context.append(
            f"What they sell, and what has to be recognisable in the picture: {products}"
        )
    if services:
        context.append(
            f"What they do for a customer, and what that looks like happening: {services}"
        )
    if not products and not services:
        # Said out loud rather than left silent, so the model works the subject
        # out of the description instead of falling back on an industry symbol.
        context.append(
            "No product or service list was supplied. Work out from the "
            "description what a customer actually pays for, and photograph "
            "that. Do not substitute a generic symbol of the industry."
        )

    if profile.get("location"):
        context.append(f"Location, and where the photo should be set: {profile['location']}")
    if profile.get("targetAudience"):
        context.append(f"The people this is for, who should be in shot: {profile['targetAudience']}")
    if is_creator:
        # A solo creator is the product. Photographing an anonymous model for
        # them sells a stranger.
        context.append(
            "This is a solo creator rather than a company. The person in shot "
            "is the creator themselves at work, not an anonymous model."
        )

    goals = _listed(profile.get("goals"))
    if goals:
        # What the business is chasing decides which outcome is worth
        # photographing: new customers, bigger orders, or people coming back.
        context.append(f"What the business is trying to achieve: {goals}")
    if profile.get("seasonalNotes"):
        # Drives weather, clothing and daylight, all of which are visible.
        context.append(f"Season and timing to reflect in the scene: {profile['seasonalNotes']}")

    if profile.get("brandVoice"):
        # Flagged as tone, because a voice like "warm and cool" was being read
        # as a lighting instruction and turned up in the image itself.
        context.append(
            f"Brand tone, for mood only and not to be taken as a lighting or "
            f"colour instruction: {profile['brandVoice']}"
        )
    return context


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
    context = _business_context(profile)

    # The idea and the framing are separate choices. Rotating the framing alone
    # gave the same picture from a new angle, which is what the recent-prompt
    # memory below was fighting on its own.
    category = creative_strategy.choose_category(
        creative_strategy.recent_categories(recent_prompts), picker, brief=request.brief
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
    result = provider.complete(PROMPT_SYSTEM, "\n".join(parts), max_tokens=900)
    angle, hook, prompt = _split_reply(result.text)
    # Never hand the image model a header with no brief under it.
    #
    # The strategy header is bookkeeping, but it is also text, so prepending it
    # turned an empty reply into a non-empty return value. The caller's fallback
    # is guarded by an except, and nothing raised, so a prompt reading exactly
    # "[strategy] category=problem; angle=; hook=" went to the image provider as
    # the whole brief. It drew the category: "problem" came back as a literal
    # logic puzzle, "lifestyle" as a stock living room. Every run was recorded
    # SUCCEEDED because a picture did come back.
    if len(prompt.strip()) < MIN_PROMPT_CHARS:
        raise ValueError(
            f"the image agent returned no usable brief (got {len(prompt.strip())} "
            f"characters, need {MIN_PROMPT_CHARS})"
        )
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
    # Without the LLM there is nothing to reason the subject out of the
    # description, so naming what the business sells matters more here, not
    # less. This is the path that runs when the text provider is down.
    sells = _listed(profile.get("products")) or _listed(profile.get("services"))
    if sells:
        parts.append(f"Show {sells} clearly in use, recognisable in the frame.")
    parts.append("Real faces, natural expressions, no text or logos anywhere in the image.")
    return " ".join(parts)
