"""Autopilot posts the catalogue when the model is unavailable.

The inconsistency this fixes was spotted from the outside: with the Anthropic
balance empty, product posts kept going out and autopilot stopped dead. Same
failing dependency, two designs.

`product_agent.generate` catches an LLM failure and returns `fallback_post`,
built from the product's own title, description and price -- "a plain post
beats no post", as the code says. `content_agent.generate` has no such path, so
`autopilot_generate` raised and gave up, and because `plan_autopilot` advances
lastPlannedAt on dispatch, the slot was gone for good.

Autopilot now takes the same escape. The bar it has to clear: nothing invented.
The copy is the shop's own words and the picture is the shop's own photograph.
A fallback that wrote filler marketing copy from a topic string and published it
under the customer's brand would be worse than posting nothing, which is why
the catalogue is the only source allowed here and no-catalogue still fails.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

from godeye_engine.tasks import planner

SLOT = datetime(2026, 9, 5, 9, 0, 0)
PLAN = {"id": "plan1", "orgId": "org1", "name": "GODEYE", "platforms": ["FACEBOOK"]}
PROFILE = {"orgId": "org1", "location": "AE", "goals": ["sell shoes"]}

PRODUCT = {
    "id": "prod1",
    "title": "Timberland Classic",
    "postCount": 2,
    "imageUrl": "https://shop.example/timberland.jpg",
    "price": 499,
    "currency": "AED",
}


class ProductSession:
    def __init__(self, product):
        self.product = product

    def execute(self, statement):
        product = self.product

        class Result:
            def mappings(self):
                return self

            def first(self):
                return product

        return Result()

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakePost:
    body = "Timberland Classic. AED 499."
    hashtags = ["timberland", "shoes"]


def _fallback(product=PRODUCT, generate=None):
    with (
        patch.object(planner, "get_session", return_value=ProductSession(product)),
        patch("godeye_engine.ai.product_agent.generate", generate or (lambda *a, **k: FakePost())),
    ):
        return planner._catalogue_fallback(PLAN, PROFILE, slot_index=0)


class TestItBuildsAPostFromTheCatalogue:
    def test_a_product_becomes_content(self):
        content, product = _fallback()
        assert content is not None
        assert product["id"] == "prod1"

    def test_the_copy_is_the_shops_own_words(self):
        content, _ = _fallback()
        assert content.body == FakePost.body
        assert content.hashtags == FakePost.hashtags
        assert content.title == "Timberland Classic"

    def test_no_model_usage_is_claimed(self):
        """`llm` is None because nothing ran. Reporting a provider and a cost
        for a post no model wrote would put fiction in the billing figures."""
        content, _ = _fallback()
        assert content.llm is None

    def test_the_product_rotation_position_drives_the_angle(self):
        """Shares create_product_post's rotation, so the two paths do not both
        reach for the same product with the same angle."""
        seen = {}

        def spy(product, profile, angle_index=0, locale=None):
            seen["angle_index"] = angle_index
            return FakePost()

        _fallback(generate=spy)
        assert seen["angle_index"] == PRODUCT["postCount"]


class TestWhenThereIsNothingHonestToPost:
    def test_no_catalogue_means_no_post(self):
        """Most workspaces have no products. They must keep failing rather than
        get invented copy, which is the whole point of sourcing from the shop."""
        content, product = _fallback(product=None)
        assert content is None and product is None

    def test_no_profile_means_no_post(self):
        with patch.object(planner, "get_session", return_value=ProductSession(PRODUCT)):
            content, _ = planner._catalogue_fallback(PLAN, None, slot_index=0)
        assert content is None

    def test_a_failure_inside_the_fallback_is_swallowed(self):
        """This already runs on the failure path. Raising would replace the
        original generation error with a second one and lose it."""

        def boom(*a, **k):
            raise RuntimeError("compliance exploded")

        content, product = _fallback(generate=boom)
        assert content is None and product is None


class TestItIsWiredIn:
    def test_the_generation_failure_path_tries_the_catalogue_first(self):
        import inspect

        source = inspect.getsource(planner.autopilot_generate)
        assert "_catalogue_fallback" in source
        # Still records a failure when the catalogue cannot help, so a
        # workspace with no products is not silently skipped again.
        assert "_record_failed_autopilot_run" in source

    def test_a_catalogue_post_does_not_ask_for_a_generated_image(self):
        """Image generation needs the model budget that just failed, and would
        replace a real photograph of the product with an invented one."""
        import inspect

        source = inspect.getsource(planner.autopilot_generate)
        before = source.index("fallback_product is not None")
        generate_images = source.index('plan["generateImages"]')
        assert before < generate_images, "the generated-image branch must be guarded"
