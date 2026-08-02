"""Write a post about one product.

The interesting constraint is not tone, it is what may lawfully be said. A
shop selling into the EU or UK cannot announce a discount without stating the
30-day low, and cannot invent scarcity at all — and an imported catalogue
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
real shops, most of them selling into the EU and UK.

Never write any of the following. They are not stylistic preferences; each is
prohibited by consumer law in every EU member state, and the shop carries the
consequence.

1. Any price reduction, discount, saving or sale claim — "20% off", "was
   £99", "now only", "save €30", "sale now on", "RRP". Announcing a reduction
   legally requires stating the lowest price of the previous 30 days, and that
   history does not exist here.
2. Any claim of limited stock or limited time — "only 3 left", "almost gone",
   "selling fast", "hurry", "ends tonight", "while stocks last", "act now".
   Falsely stating limited availability is blacklisted outright. You are not
   given a stock count or a deadline, so any such claim would be invented.
3. Any fact you were not given. No invented materials, origin, awards,
   reviews, ratings or customer counts.

Write plainly and specifically. Lead with the product rather than with a hook
about the reader. State the price exactly as supplied, unchanged. One clear
call to action. No em dashes.

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
                 price_text: str | None) -> str:
    lines = [
        f"Product: {product['title']}",
        f"Price: {price_text}" if price_text else "Price: not shown in this post",
    ]
    if product.get("description"):
        lines.append(f"The shop's own description: {product['description'][:600]}")
    if product.get("availability"):
        lines.append(f"Availability: {product['availability']}")
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


def fallback_post(product: dict[str, Any], price_text: str | None) -> ProductPost:
    """A caption built from the product's own facts, with nothing added.

    Used when the model will not stay inside the rules. Dull beats unlawful,
    and this still says the true and useful things: what it is, what the shop
    says about it, what it costs.
    """
    parts = [product["title"]]
    description = (product.get("description") or "").strip()
    if description:
        sentence = description.split(". ")[0].strip().rstrip(".")
        if sentence and sentence.lower() != product["title"].lower():
            parts.append(f"{sentence}.")
    if price_text:
        parts.append(f"{price_text}.")
    parts.append("Full details on our website.")
    return ProductPost(
        body=dedash(" ".join(parts)),
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
            product["price"], product.get("currency"), locale
        )

    prompt = build_prompt(product, profile, angle, price_text)
    last_violations: list[compliance.Violation] = []

    for attempt in range(MAX_ATTEMPTS):
        try:
            llm = provider.complete(SYSTEM_PROMPT, prompt)
            data = _parse(llm.text)
        except Exception as e:  # noqa: BLE001 — a plain post beats no post
            logger.warning("Product copy generation failed: %s: %s", type(e).__name__, e)
            break

        body = dedash((data.get("body") or "").strip())
        hashtags = [str(t).lstrip("#") for t in (data.get("hashtags") or [])][:5]
        if not body:
            continue

        # The whole post is checked, hashtags included: #SaleNowOn carries the
        # same claim as the sentence would.
        last_violations = compliance.check(" ".join([body, *hashtags]))
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
    return fallback_post(product, price_text)


def _parse(text: str) -> dict[str, Any]:
    import json
    import re

    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in the response")
    return json.loads(match.group(0))
