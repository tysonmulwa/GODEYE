"""Write a post about one product.

The interesting constraint is not tone, it is what may lawfully be said. A
shop selling into the EU or UK cannot announce a discount without stating the
30-day low, and cannot invent scarcity at all, and an imported catalogue
supplies neither a price history nor a stock count. So the model is told what
it must not reach for, and then the finished text is checked against the same
rules deterministically, because being told is not the same as complying.

When a draft fails that check it is regenerated once with the offending phrase
quoted back. If it fails again the post is built from the product's own facts
instead. A plainer caption is a perfectly good post; an unlawful one is not.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from ..products import compliance
from . import provider
from .style import dedash

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 2

# Angles to rotate through, so a catalogue of forty products does not read as
# forty of the same caption. Each is a different true thing to say about an
# object, not a different intensity of selling.
ANGLES = [
    "what it is made of and how it is made",
    "the moment someone would actually use it",
    "the detail a buyer would only notice in person",
    "who it suits and what it goes with",
    "the problem it quietly solves",
    "what makes it different from the obvious alternative",
]

SYSTEM_PROMPT = """You write short social posts about individual products for
real shops, selling in many different countries.

Never write any of the following. They are not stylistic preferences; each is
prohibited by consumer law somewhere these posts will be read, and the shop
carries the consequence.

1. Any price reduction, discount, saving or sale claim, "20% off", "now
   only", "save €30", "sale now on", "RRP". Announcing a reduction legally
   requires stating the lowest price of the previous 30 days in the EU and UK,
   and that history does not exist here. If you are given a recorded former
   price you may state it once as a plain fact, and only in the words allowed
   there; you are given it precisely when that is lawful for this shop.
2. Any claim of limited stock or limited time, "only 3 left", "almost gone",
   "selling fast", "hurry", "ends tonight", "while stocks last", "act now".
   Falsely stating limited availability is blacklisted outright. You are not
   given a stock count or a deadline, so any such claim would be invented.
3. Any fact you were not given. No invented materials, origin, awards,
   reviews, ratings or customer counts.

Write the post someone could act on without opening the link. When you are
given sizes, colours or a category, say them, those answer "will it fit me"
and "does it come in black", and leaving them out makes the reader click to
find out. Include the link if one is given.

A short scannable shape works better than a paragraph: a line that names the
thing, a line or two on what it is actually like, then the details as their own
short lines. Emoji are fine as line markers where they earn their place; do not
sprinkle them through sentences.

State the price exactly as supplied, unchanged. One clear call to action. No em
dashes. Never invent a fact you were not given.

Reply as JSON only:
{"body": "the caption", "hashtags": ["five", "at", "most"]}"""


@dataclass
class ProductPost:
    body: str
    hashtags: list[str]
    angle: str
    compliant: bool
    fell_back: bool = False


def build_prompt(product: dict[str, Any], profile: dict[str, Any], angle: str,
                 price_text: str | None, was_text: str | None = None) -> str:
    lines = [
        f"Product: {product['title']}",
        f"Price: {price_text}" if price_text else "Price: not shown in this post",
    ]
    if was_text:
        # Only ever present when both the market and the shop's own record
        # allow it, so the model may state it plainly.
        lines.append(
            f"This shop's recorded former price: {was_text}. You may say it was "
            f"this before, exactly once, as a plain fact. Do not call it a sale, "
            f"a deal, or a limited offer, and do not compute a percentage."
        )
    if product.get("description"):
        lines.append(f"The shop's own description: {product['description'][:600]}")
    if product.get("availability"):
        lines.append(f"Availability: {product['availability']}")
    # The details that answer "will it fit me, does it come in black" without
    # the reader opening the link. The shop already knows them; a post that
    # leaves them out makes someone click to find out.
    variants = product.get("variants") or {}
    if variants.get("sizes"):
        lines.append(f"Sizes the shop lists: {', '.join(variants['sizes'])}")
    if variants.get("colours"):
        lines.append(f"Colours the shop lists: {', '.join(variants['colours'])}")
    if variants.get("category"):
        lines.append(f"Category: {variants['category']}")
    if product.get("url"):
        lines.append(f"Link to include: {product['url']}")
    if profile.get("businessName"):
        lines.append(f"Shop: {profile['businessName']}")
    if profile.get("targetAudience"):
        lines.append(f"Who buys from this shop: {profile['targetAudience']}")
    if profile.get("brandVoice"):
        lines.append(f"Tone to write in: {profile['brandVoice']}")
    if profile.get("location"):
        lines.append(f"Where the shop is: {profile['location']}")
    lines.append(f"\nAngle for this post: {angle}")
    lines.append(
        "\nWrite one caption. Use only the facts above. If the price is given, "
        "include it exactly as written."
    )
    return "\n".join(lines)


def fallback_post(product: dict[str, Any], price_text: str | None,
                  was_text: str | None = None) -> ProductPost:
    """A caption built from the product's own facts, with nothing added.

    Used when the model will not stay inside the rules. Dull beats unlawful,
    and this still says the true and useful things: what it is, what the shop
    says about it, what it costs.
    """
    # The title is a name, not a sentence, so it needs closing before the next
    # one starts: "Premium Perfume Luxurious fragrance" reads as one phrase.
    title = product["title"].strip()
    lines = [title if title.endswith((".", "!", "?")) else f"{title}."]
    description = (product.get("description") or "").strip()
    if description:
        sentence = description.split(". ")[0].strip().rstrip(".")
        if sentence and sentence.lower() != title.lower():
            lines.append(f"{sentence[0].upper()}{sentence[1:]}.")

    # Written as its own short lines rather than a run-on sentence: these are
    # the facts a reader scans for, and the shop already knows every one.
    details = []
    if price_text:
        details.append(
            f"Price: {price_text} (was {was_text})" if was_text else f"Price: {price_text}"
        )
    variants = product.get("variants") or {}
    if variants.get("sizes"):
        details.append(f"Sizes: {', '.join(variants['sizes'])}")
    if variants.get("colours"):
        details.append(f"Colours: {', '.join(variants['colours'])}")
    if details:
        lines.append("")
        lines.extend(details)

    url = product.get("url")
    lines.append("")
    lines.append(f"Shop now: {url}" if url else "Full details on our website.")
    return ProductPost(
        body=dedash("\n".join(lines)),
        hashtags=[],
        angle="the product's own words",
        compliant=True,
        fell_back=True,
    )


def generate(product: dict[str, Any], profile: dict[str, Any], angle_index: int = 0,
             locale: str | None = None) -> ProductPost:
    """One post about one product, guaranteed to pass the compliance check."""
    angle = ANGLES[angle_index % len(ANGLES)]

    # Only publish a price we can vouch for. A Shopify feed figure may exclude
    # VAT, which a consumer-facing price may not.
    price_text = None
    if product.get("price") is not None and compliance.price_is_confirmable(
        product.get("source", "")
    ):
        price_text = compliance.format_price(
            product["price"],
            # Many shops store a price with no currency because their own site
            # only ever sells in one. A bare number in a caption does not carry
            # that context, so the workspace's stated location fills it in.
            product.get("currency") or compliance.currency_for_location(profile.get("location")),
            locale,
        )

    # Saying what a thing used to cost needs both a market where that is
    # lawful and a former price the shop actually recorded. Neither alone is
    # enough, and the default when either is unknown is not to say it.
    was_text = None
    allow_comparison = price_text is not None and compliance.price_comparison_allowed(
        profile.get("location"), product.get("compareAtPrice"), product.get("price")
    )
    if allow_comparison:
        was_text = compliance.format_price(
            product["compareAtPrice"],
            product.get("currency") or compliance.currency_for_location(profile.get("location")),
            locale,
        )

    prompt = build_prompt(product, profile, angle, price_text, was_text)
    last_violations: list[compliance.Violation] = []

    for attempt in range(MAX_ATTEMPTS):
        try:
            llm = provider.complete(SYSTEM_PROMPT, prompt)
            data = _parse(llm.text)
        except Exception as e:  # noqa: BLE001, a plain post beats no post
            logger.warning("Product copy generation failed: %s: %s", type(e).__name__, e)
            break

        body = dedash((data.get("body") or "").strip())
        hashtags = [str(t).lstrip("#") for t in (data.get("hashtags") or [])][:5]
        if not body:
            continue

        # The whole post is checked, hashtags included: #SaleNowOn carries the
        # same claim as the sentence would.
        last_violations = compliance.check(
            " ".join([body, *hashtags]), allow_price_comparison=allow_comparison
        )
        if not last_violations:
            return ProductPost(body=body, hashtags=hashtags, angle=angle, compliant=True)

        logger.info(
            "Product copy attempt %d rejected: %s",
            attempt + 1, compliance.describe(last_violations),
        )
        # Quote the phrase back rather than repeating the rule: the first
        # instruction already said it, and it is the specific words that need
        # to go.
        prompt += (
            f"\n\nThat draft used {compliance.describe(last_violations)}. "
            "Rewrite it without any of that. Do not replace it with a "
            "different urgency or discount claim; leave the idea out entirely."
        )

    logger.warning(
        "Falling back to the product's own words for %r after %d attempt(s): %s",
        product.get("title"), MAX_ATTEMPTS, compliance.describe(last_violations),
    )
    return fallback_post(product, price_text, was_text)


def _parse(text: str) -> dict[str, Any]:
    import json
    import re

    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in the response")
    return json.loads(match.group(0))
