"""The creative director that briefs the photographer.

The image agent writes an excellent photographic brief: subject, moment, place,
light, camera, texture. Every one of those is about *how to take the picture*.
None of them asks what the picture is for, so the pipeline reliably produced a
competent photograph that sold nothing.

This module decides that first. It picks a marketing angle and a creative
category, names the desire the image is meant to touch and the hook that should
stop a thumb, and decides whether the frame needs room for text. The
photographic brief then executes that idea rather than inventing one.

Two axes, deliberately independent:

    creative category  what kind of marketing idea this is
    shot type          how that idea is photographed

The image agent already rotates shot types, and its own comment admits why that
was not enough: given the same brief a model converges on the same idea and
merely photographs it from a new angle. Rotating the idea is the missing half.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass

# What kind of marketing idea the picture is. Rotated, and checked against what
# this business has recently had, so a run of posts does not settle into one
# shape.
# Categories that photograph how the business works rather than what the
# customer gets. They are legitimate creatives — for a post that is actually
# about process, a founder, or a lesson — and a trap otherwise.
#
# The failure that produced this set: an overhead desk with a content calendar,
# a notebook, coffee and a hand placing a photograph. Beautiful, and a picture
# of the *act of marketing* rather than a reason to buy anything. It was
# reachable because "behind the scenes" sits in the rotation and nothing
# stopped a generic post from drawing it.
PROCESS_CATEGORIES = frozenset(
    {"behind the scenes", "founder", "educational", "demonstration"}
)

# Words in a brief that mean the post really is about process, which is when
# the categories above stop being a trap and become the right answer.
_PROCESS_SIGNS = (
    "behind the scenes",
    "how we",
    "how it",
    "our process",
    "meet the",
    "founder",
    "team",
    "tutorial",
    "guide",
    "explain",
    "tip",
    "lesson",
    "workshop",
    "day in the life",
    "culture",
)

# Concepts that exist in every stock library and sell nothing. Named so the
# brief can refuse them outright rather than hoping the model has better taste.
STOCK_PATTERNS = (
    "a desk shot with any combination of notebook, planner, calendar, coffee "
    "cup, laptop, pens or printed photographs; a hand writing, typing, or "
    "reaching into frame; a mood board or content calendar; a person looking "
    "at a phone or pointing at a screen; a meeting around a table; a smiling "
    "employee at a workstation; a laptop beside a coffee; a product floating "
    "on a plain or gradient background; a city skyline"
)

CREATIVE_CATEGORIES = (
    "product hero, the thing itself shot with real care",
    "lifestyle, the product inside a life the viewer would want",
    "transformation, the difference the product makes made visible",
    "problem, the friction the customer lives with right now",
    "UGC, as though a customer photographed it themselves on a phone",
    "social proof, real people visibly choosing this",
    "customer story, one person and what changed for them",
    "demonstration, the thing being used properly and closely",
    "educational, a detail that teaches the viewer something",
    "editorial, photographed as a magazine would shoot it",
    "premium campaign, restraint and craft doing the selling",
    "community, the people around the business rather than the product",
    "behind the scenes, the work that customers never usually see",
    "founder, the person whose name is on it",
    "curiosity, a frame that withholds enough to make you look twice",
    "aspirational, the outcome the customer is actually buying",
)

# Why the picture should work on someone. Inferred from the business and the
# post rather than drawn at random — the drawn one is a fallback.
MARKETING_ANGLES = (
    "transformation",
    "aspiration",
    "problem and solution",
    "desire",
    "convenience",
    "status",
    "exclusivity",
    "social proof",
    "trust",
    "belonging",
    "curiosity",
    "emotional connection",
    "relief",
    "achievement",
    "discovery",
    "value",
    "premium",
    "authenticity",
    "education",
)

# One sentence each, folded into the brief rather than branching the pipeline.
# A platform is a visual culture, not a separate product.
PLATFORM_BIAS = {
    "INSTAGRAM": (
        "Instagram: aspirational and aesthetic. Polished but believable, strong "
        "styling, a frame someone would want their own life to resemble."
    ),
    "TIKTOK": (
        "TikTok: candid and unpolished. It should look photographed by a person "
        "rather than produced by a brand: imperfect framing, real rooms, "
        "nothing that reads as an advertisement."
    ),
    "FACEBOOK": (
        "Facebook: relatable and plain-spoken. Ordinary people, a clearly "
        "readable product or service, warmth over gloss."
    ),
    "LINKEDIN": (
        "LinkedIn: credible and professional. Real working environments, "
        "competence and outcome rather than lifestyle or glamour."
    ),
    "X": (
        "X: direct and immediate. One clear idea legible at a glance in a fast "
        "timeline, no ornament."
    ),
}

# Presets whose crop is normally overlaid with a headline. A story or a portrait
# usually carries text; a square feed post usually does not, and demanding
# negative space on every image is its own way of making everything look alike.
_OVERLAY_PRESETS = {"STORY", "PORTRAIT", "VERTICAL", "REEL"}

_NEGATIVE_SPACE_PLACEMENTS = (
    "subject low and to the right, the upper left third left clean and "
    "uncluttered for a headline",
    "subject to the right, the left third quiet enough to carry text",
    "subject in the lower half, the sky or wall above it kept plain for a "
    "headline",
)

_HEADER_RE = re.compile(r"^\[strategy\]([^\n]*)\n?", re.IGNORECASE)


@dataclass
class CreativeStrategy:
    """What the image is trying to achieve, decided before how to shoot it."""

    objective: str
    audience_desire: str
    audience_problem: str
    angle: str
    creative_category: str
    visual_hook: str
    desired_action: str
    platform: str | None = None
    negative_space: str | None = None

    def brief(self) -> str:
        """The strategy as instruction text, placed above the photographic brief."""
        lines = [
            f"Objective: {self.objective}",
            f"What this customer wants: {self.audience_desire}",
            f"What is in their way: {self.audience_problem}",
            f"Angle: {self.angle}",
            f"Creative category: {self.creative_category}",
            f"Visual hook, the one reason a thumb stops: {self.visual_hook}",
            f"What the viewer should want to do next: {self.desired_action}",
        ]
        if self.platform and self.platform.upper() in PLATFORM_BIAS:
            lines.append(PLATFORM_BIAS[self.platform.upper()])
        if self.negative_space:
            lines.append(f"Composition: {self.negative_space}")
        else:
            lines.append(
                "Composition: fill the frame. No text is going over this one, so "
                "do not leave empty space waiting for a headline."
            )
        return "\n".join(lines)


def category_key(category: str) -> str:
    """The first word of a category, which is what identifies it in memory."""
    return category.split(",", 1)[0].strip().lower()


def is_process_post(brief: str | None) -> bool:
    """Whether the post is genuinely about how the business works."""
    text = (brief or "").lower()
    return any(sign in text for sign in _PROCESS_SIGNS)


def choose_category(
    recent: list[str] | None = None,
    rng: random.Random | None = None,
    brief: str | None = None,
) -> str:
    """A creative category this business has not just had.

    Mirrors how the image agent picks a shot type, but excludes what was used
    recently — the whole point is that consecutive posts are different ideas,
    not the same idea from a new angle.

    Process categories are withheld unless the post is actually about process.
    Left in the general pool they get drawn for ordinary selling posts, and the
    result is a photograph of the business at work rather than a reason to buy
    from it. A shop announcing new stock does not want a picture of a desk.
    """
    picker = rng or random
    used = {category_key(c) for c in (recent or [])}
    if not is_process_post(brief):
        used |= PROCESS_CATEGORIES
    fresh = [c for c in CREATIVE_CATEGORIES if category_key(c) not in used]
    # Everything used means the memory is longer than the catalogue; start over
    # rather than fail.
    return picker.choice(fresh or list(CREATIVE_CATEGORIES))


def negative_space_plan(
    preset_id: str | None,
    has_overlay: bool | None = None,
    rng: random.Random | None = None,
) -> str | None:
    """Where to leave room for a headline, or None to fill the frame.

    Returns None deliberately and often. A brief that always asks for negative
    space produces a wall of images with a subject shoved to one side and a
    conspicuous hole beside it, which is its own kind of sameness.
    """
    if has_overlay is None:
        has_overlay = (preset_id or "").upper() in _OVERLAY_PRESETS
    if not has_overlay:
        return None
    return (rng or random).choice(_NEGATIVE_SPACE_PLACEMENTS)


def format_header(strategy: CreativeStrategy) -> str:
    """A single line recording the idea, stored with the prompt.

    MediaAsset.prompt is already written and already read back for memory, so
    the idea rides along with the picture it produced and needs no new column.
    """
    return (
        f"[strategy] category={category_key(strategy.creative_category)}; "
        f"angle={strategy.angle}; hook={strategy.visual_hook[:80]}"
    )


def parse_header(prompt: str) -> dict[str, str]:
    """Read back what a stored prompt's header recorded. Empty if there is none."""
    match = _HEADER_RE.match(prompt or "")
    if not match:
        return {}
    fields: dict[str, str] = {}
    for part in match.group(1).split(";"):
        key, sep, value = part.partition("=")
        if sep:
            fields[key.strip().lower()] = value.strip()
    return fields


def strip_header(prompt: str) -> str:
    """The photographic prompt without its strategy line.

    Recent prompts are shown to the model as examples of what not to repeat.
    The header is bookkeeping, and feeding it back would teach the model to
    write headers instead of photographs.
    """
    return _HEADER_RE.sub("", prompt or "", count=1).strip()


def recent_categories(prompts: list[str] | None) -> list[str]:
    """The ideas behind this business's recent images, newest first."""
    found = []
    for prompt in prompts or []:
        category = parse_header(prompt).get("category")
        if category:
            found.append(category)
    return found


def validate(strategy: CreativeStrategy, recent: list[str] | None = None) -> list[str]:
    """Structural complaints about a strategy, empty when it is worth rendering.

    Deliberately cheap and deliberately not a judgement of the picture — nothing
    here has seen an image. It catches the failures that are visible in the
    plan itself: repeating the idea just used, and a hook that says nothing.
    """
    complaints = []
    used = recent_categories(recent)[:2]
    if category_key(strategy.creative_category) in used:
        complaints.append(
            f"creative category '{category_key(strategy.creative_category)}' was "
            "used in one of the last two images"
        )
    hook = (strategy.visual_hook or "").strip()
    if len(hook) < 12:
        complaints.append("visual hook is empty or too vague to photograph")
    if not (strategy.audience_desire or "").strip():
        complaints.append("no audience desire named")
    return complaints
