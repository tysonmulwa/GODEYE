"""The creative director's decisions, before any photograph is taken."""

import random

import pytest

from godeye_engine.ai import creative_strategy as cs


def strategy(**over):
    base = dict(
        objective="product discovery",
        audience_desire="to look put together without effort",
        audience_problem="everything in the shops looks the same",
        angle="aspiration",
        creative_category="lifestyle, the product inside a life the viewer would want",
        visual_hook="a stranger turning to look as she walks past",
        desired_action="open the collection",
    )
    base.update(over)
    return cs.CreativeStrategy(**base)


class TestCategoryRotation:
    def test_avoids_what_was_just_used(self):
        recent = [cs.category_key(c) for c in cs.CREATIVE_CATEGORIES[:8]]
        for _ in range(30):
            chosen = cs.choose_category(recent, random.Random())
            assert cs.category_key(chosen) not in recent

    def test_starts_over_rather_than_failing_when_all_are_used(self):
        every = [cs.category_key(c) for c in cs.CREATIVE_CATEGORIES]
        assert cs.choose_category(every, random.Random(1)) in cs.CREATIVE_CATEGORIES

    def test_no_memory_still_returns_a_category(self):
        assert cs.choose_category(None, random.Random(1)) in cs.CREATIVE_CATEGORIES


class TestNegativeSpace:
    def test_a_clean_square_post_fills_the_frame(self):
        # The important half. Asking for negative space on everything makes
        # every image look like the same advertisement.
        assert cs.negative_space_plan("SQUARE") is None

    def test_a_story_leaves_room_for_a_headline(self):
        assert cs.negative_space_plan("STORY") is not None

    def test_an_explicit_overlay_flag_beats_the_preset(self):
        assert cs.negative_space_plan("SQUARE", has_overlay=True) is not None
        assert cs.negative_space_plan("STORY", has_overlay=False) is None

    def test_the_plan_reaches_the_brief(self):
        text = strategy(negative_space="subject to the right").brief()
        assert "subject to the right" in text

    def test_without_a_plan_the_brief_says_so(self):
        assert "fill the frame" in strategy().brief()


class TestMemoryRoundTrip:
    def test_a_header_survives_being_written_and_read(self):
        s = strategy()
        stored = cs.format_header(s) + "\nA woman steps out of a matatu."
        assert cs.parse_header(stored)["category"] == "lifestyle"
        assert cs.parse_header(stored)["angle"] == "aspiration"

    def test_the_header_is_stripped_before_the_model_sees_it(self):
        stored = cs.format_header(strategy()) + "\nA woman steps out of a matatu."
        assert cs.strip_header(stored) == "A woman steps out of a matatu."

    def test_a_prompt_written_before_this_existed_still_reads(self):
        # Every image already in the database predates the header.
        old = "A woman steps out of a matatu."
        assert cs.parse_header(old) == {}
        assert cs.strip_header(old) == old

    def test_categories_come_back_newest_first(self):
        prompts = [
            cs.format_header(strategy(creative_category="UGC, as though a customer")) + "\nx",
            "an older prompt with no header",
            cs.format_header(strategy(creative_category="founder, the person")) + "\ny",
        ]
        assert cs.recent_categories(prompts) == ["ugc", "founder"]


class TestValidation:
    def test_a_fresh_idea_passes(self):
        assert cs.validate(strategy(), []) == []

    def test_repeating_the_last_idea_is_rejected(self):
        recent = [cs.format_header(strategy()) + "\nx"]
        assert any("used in one of the last two" in c for c in cs.validate(strategy(), recent))

    def test_an_idea_from_further_back_is_allowed_again(self):
        recent = [
            cs.format_header(strategy(creative_category="ugc, a")) + "\nx",
            cs.format_header(strategy(creative_category="founder, a")) + "\ny",
            cs.format_header(strategy()) + "\nz",
        ]
        assert cs.validate(strategy(), recent) == []

    def test_a_hook_that_says_nothing_is_rejected(self):
        assert any("hook" in c for c in cs.validate(strategy(visual_hook="nice"), []))

    def test_a_missing_desire_is_rejected(self):
        assert any("desire" in c for c in cs.validate(strategy(audience_desire=" "), []))


class TestPlatform:
    @pytest.mark.parametrize("platform", ["INSTAGRAM", "TIKTOK", "FACEBOOK", "LINKEDIN"])
    def test_each_platform_reaches_the_brief(self, platform):
        assert cs.PLATFORM_BIAS[platform][:20] in strategy(platform=platform).brief()

    def test_tiktok_and_linkedin_do_not_ask_for_the_same_picture(self):
        assert strategy(platform="TIKTOK").brief() != strategy(platform="LINKEDIN").brief()

    def test_an_unknown_platform_is_simply_omitted(self):
        assert "Objective:" in strategy(platform="MYSPACE").brief()
