"""Generating a post about a product.

The guarantee under test is that nothing unlawful reaches a feed, no matter
what the model returns, the prompt asks, the filter decides.
"""

from __future__ import annotations

import json
from decimal import Decimal

from godeye_engine.ai import product_agent
from godeye_engine.ai.product_agent import ANGLES, generate

PRODUCT = {
    "title": "Chelsea Boot",
    "description": "Full-grain leather, welted so it can be resoled.",
    "price": Decimal("129.00"),
    "currency": "GBP",
    "availability": "InStock",
    "source": "jsonld",
}
PROFILE = {"businessName": "Mjini", "targetAudience": "people who walk to work"}


class FakeLLM:
    def __init__(self, text):
        self.text = text


def _replies(monkeypatch, *bodies):
    """Queue the model's answers; later calls repeat the last one."""
    calls: list[str] = []

    def complete(system, prompt):
        calls.append(prompt)
        body = bodies[min(len(calls) - 1, len(bodies) - 1)]
        return FakeLLM(json.dumps({"body": body, "hashtags": ["boots"]}))

    monkeypatch.setattr(product_agent.provider, "complete", complete)
    return calls


class TestCompliantOutput:
    def test_a_clean_draft_is_used_as_is(self, monkeypatch):
        _replies(monkeypatch, "Full-grain leather, welted. £129. Link in bio.")
        post = generate(PRODUCT, PROFILE)
        assert post.compliant and not post.fell_back
        assert "£129" in post.body

    def test_an_unlawful_draft_is_regenerated_not_published(self, monkeypatch):
        """The model produced a blacklisted scarcity claim; the next attempt
        is clean, and that is what ships."""
        calls = _replies(
            monkeypatch,
            "Only 2 left! Hurry.",
            "Welted leather boots, £129. Link in bio.",
        )
        post = generate(PRODUCT, PROFILE)
        assert post.compliant and not post.fell_back
        assert "Only 2 left" not in post.body
        assert len(calls) == 2, "should have asked again"

    def test_the_retry_quotes_the_offending_phrase_back(self, monkeypatch):
        calls = _replies(monkeypatch, "20% off today", "Welted leather boots, £129.")
        generate(PRODUCT, PROFILE)
        assert "20% off" in calls[1]

    def test_a_model_that_keeps_breaking_the_rules_never_reaches_a_feed(self, monkeypatch):
        """The fallback is dull on purpose. Dull beats unlawful."""
        _replies(monkeypatch, "Only 1 left, 50% off, ends tonight!")
        post = generate(PRODUCT, PROFILE)
        assert post.fell_back and post.compliant
        from godeye_engine.products.compliance import is_publishable

        assert is_publishable(post.body)
        assert "Chelsea Boot" in post.body and "£129" in post.body

    def test_hashtags_are_checked_too(self, monkeypatch):
        """#SaleNowOn makes the same claim the sentence would."""
        def complete(system, prompt):
            return FakeLLM(json.dumps({"body": "Good boots.", "hashtags": ["SaleNowOn"]}))

        monkeypatch.setattr(product_agent.provider, "complete", complete)
        assert generate(PRODUCT, PROFILE).fell_back

    def test_an_llm_failure_still_produces_a_post(self, monkeypatch):
        def boom(system, prompt):
            raise RuntimeError("provider down")

        monkeypatch.setattr(product_agent.provider, "complete", boom)
        post = generate(PRODUCT, PROFILE)
        assert post.fell_back and "Chelsea Boot" in post.body


class TestPricing:
    def test_a_feed_price_is_left_out_rather_than_risked(self, monkeypatch):
        """98/6/EC requires a consumer price to include VAT. A Shopify feed
        figure may not, so it is not put in front of a shopper."""
        calls = _replies(monkeypatch, "Welted leather boots. Link in bio.")
        post = generate({**PRODUCT, "source": "shopify"}, PROFILE)
        assert "Price: not shown" in calls[0]
        assert not post.fell_back

    def test_a_product_page_price_is_formatted_for_its_market(self, monkeypatch):
        calls = _replies(monkeypatch, "Bottes en cuir. 1 234,56 €.")
        generate(
            {**PRODUCT, "price": Decimal("1234.56"), "currency": "EUR"}, PROFILE, locale="fr"
        )
        assert "1 234,56 €" in calls[0]


class TestVariety:
    def test_angles_rotate_so_a_catalogue_is_not_one_caption(self, monkeypatch):
        _replies(monkeypatch, "Welted leather boots, £129.")
        seen = {generate(PRODUCT, PROFILE, angle_index=i).angle for i in range(len(ANGLES))}
        assert len(seen) == len(ANGLES)

    def test_the_angle_reaches_the_prompt(self, monkeypatch):
        calls = _replies(monkeypatch, "Welted leather boots, £129.")
        generate(PRODUCT, PROFILE, angle_index=1)
        assert ANGLES[1] in calls[0]


def test_fallback_says_the_true_useful_things():
    post = product_agent.fallback_post(PRODUCT, "£129")
    assert "Chelsea Boot" in post.body
    assert "Full-grain leather" in post.body
    assert "£129" in post.body
