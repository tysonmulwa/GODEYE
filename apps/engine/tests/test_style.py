"""Dash stripping: the em dash reads as an AI watermark, so it must not survive."""

import pytest

from godeye_engine.ai import content_agent, image_agent, mission, seo_agent, video_agent
from godeye_engine.ai.content_agent import (
    PLATFORM_LIMITS,
    enforce_limits,
    extract_ab_variants,
)
from godeye_engine.ai.style import dedash


class TestDedash:
    @pytest.mark.parametrize(
        "text,expected",
        [
            ("Fresh coffee — roasted daily.", "Fresh coffee, roasted daily."),
            ("Our beans — roasted daily — arrive fresh.", "Our beans, roasted daily, arrive fresh."),
            ("Get 20% off—today only!", "Get 20% off, today only!"),
            ("Best in Nairobi – no contest.", "Best in Nairobi, no contest."),
            ("No dashes here at all.", "No dashes here at all."),
        ],
    )
    def test_sentence_breaks_become_commas(self, text, expected):
        assert dedash(text) == expected

    def test_every_long_stroke_is_covered(self):
        """Em, en, horizontal bar, figure dash and minus all look the same to a
        reader scanning for the tell, so all of them have to go."""
        for dash in "—–―‒−":
            assert dash not in dedash(f"Fresh coffee {dash} roasted daily.")

    def test_opening_hours_do_not_become_a_comma(self):
        """"9, 5" would be nonsense, and this is exactly the copy a shop posts."""
        assert dedash("Open 9–5 daily") == "Open 9-5 daily"
        assert dedash("Save 10–20% today") == "Save 10-20% today"

    def test_bullets_stay_bullets(self):
        assert dedash("— Free delivery\n— Same-day pickup") == "- Free delivery\n- Same-day pickup"

    def test_indented_bullets_keep_their_indent(self):
        assert dedash("  — Nested item") == "- Nested item"  # leading whitespace stripped at ends

    def test_no_doubled_punctuation_is_left_behind(self):
        assert dedash("Order now — , while stock lasts") == "Order now, while stock lasts"
        assert dedash("Fresh coffee — . Roasted daily") == "Fresh coffee. Roasted daily"

    def test_hyphens_are_untouched(self):
        """A hyphen is not the tell; mangling compounds would be a regression."""
        assert dedash("state-of-the-art cold-brew") == "state-of-the-art cold-brew"

    def test_empty_input(self):
        assert dedash("") == ""


class TestAgentOutputIsCleaned:
    def test_post_bodies_and_variants(self):
        data = {
            "title": "Launch — day one",
            "body": "Fresh coffee — roasted daily.",
            "hashtags": ["coffee"],
            "variants": {"X": {"body": "Try it — today!", "hashtags": ["coffee"]}},
        }
        out = enforce_limits(data, ["X"])
        assert "—" not in out["title"]
        assert "—" not in out["body"]
        assert "—" not in out["variants"]["X"]["body"]

    def test_ab_variants(self):
        raw = {
            "abVariants": {
                "A": {"body": "Angle one — emotional", "hashtags": []},
                "B": {"body": "Angle two — factual", "hashtags": []},
            }
        }
        out = extract_ab_variants(raw)
        assert out is not None
        assert "—" not in out["A"]["body"] and "—" not in out["B"]["body"]

    def test_cleaning_happens_before_the_length_limit(self):
        """dedash shortens text (" - " becomes ", "), so a post that is one
        character over its limit fits once cleaned. Cleaning after truncation
        would have chopped it and left an ellipsis for no reason."""
        limit = PLATFORM_LIMITS["X"]
        body = "A" * (limit - 7) + " — " + "B" * 5  # limit + 1 chars
        assert len(body) == limit + 1
        out = enforce_limits({"body": body, "hashtags": [], "variants": {}}, ["X"])
        cleaned = out["variants"]["X"]["body"]
        assert "—" not in cleaned
        assert len(cleaned) == limit
        assert not cleaned.endswith("…"), "truncated text that would have fitted"


class TestCharter:
    def test_the_rule_is_in_every_agent_prompt(self):
        """The charter is the one place all agents read, so the instruction has
        to live there rather than in one agent's task prompt."""
        for skill in ("content", "seo", "video", "image", "marketing"):
            assert "em dash" in mission.charter(skill)

    def test_the_prompts_practise_what_they_preach(self):
        """A model imitates the punctuation of the text it is shown, so a
        charter full of em dashes teaches the habit it is meant to forbid.

        This composes the prompts the agents actually send rather than grepping
        source, which would flag docstrings and error messages no model reads.
        """
        profile = {
            "businessName": "Acme",
            "industry": "coffee",
            "description": "We roast coffee.",
            "targetAudience": "Nairobi office workers",
        }
        prompts = {
            "content system": content_agent.SYSTEM_PROMPT,
            "seo system": seo_agent.SYSTEM_PROMPT,
            "video system": video_agent.SYSTEM_PROMPT,
            "image system": image_agent.PROMPT_SYSTEM,
            "content user": content_agent.build_prompt(
                profile,
                content_agent.ContentRequest(goal="launch", platforms=["X"], ab_test=True),
            ),
            "video user": video_agent.build_prompt(profile, "a launch clip", 30, None),
        }
        prompts |= {f"charter:{k}": mission.charter(k) for k in mission.SKILLS}

        offenders = [name for name, text in prompts.items() if "—" in text or "–" in text]
        assert not offenders, f"em dashes in composed prompts: {offenders}"
