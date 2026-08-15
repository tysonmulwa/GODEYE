"""Image presets, Pillow processing, and provider selection."""

import io
from typing import ClassVar

import pytest
from PIL import Image

from godeye_engine.ai import image_agent, image_provider
from godeye_engine.config import get_settings
from godeye_engine.media import branding, presets


def make_image(width: int, height: int, color=(120, 80, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


class TestPresets:
    def test_known_preset(self):
        p = presets.get_preset("INSTAGRAM_FEED")
        assert (p.width, p.height) == (1080, 1080)

    def test_unknown_preset_falls_back_to_square(self):
        assert presets.get_preset("NOPE").id == "SQUARE"

    def test_platform_default(self):
        assert presets.PLATFORM_DEFAULT_PRESET["INSTAGRAM"] == "INSTAGRAM_FEED"

    def test_closest_provider_size(self):
        assert presets.closest_provider_size(1600, 900) == "1536x1024"  # wide
        assert presets.closest_provider_size(1080, 1920) == "1024x1536"  # tall
        assert presets.closest_provider_size(1080, 1080) == "1024x1024"  # square


class TestFitToPreset:
    def test_crops_and_resizes_to_exact_dimensions(self):
        # a wide source fit into a square preset
        src = make_image(2000, 1000)
        out = branding.fit_to_preset(src, presets.get_preset("SQUARE"))
        img = Image.open(io.BytesIO(out))
        assert img.size == (1080, 1080)

    def test_portrait_preset(self):
        src = make_image(1000, 1000)
        out = branding.fit_to_preset(src, presets.get_preset("STORY"))
        img = Image.open(io.BytesIO(out))
        assert img.size == (1080, 1920)


class TestApplyBrand:
    """The overlay is a small round badge in the corner. It used to be a logo a
    sixth of the image wide plus a full-width colour bar, which on a photograph
    reads as a banner over someone's face."""

    def test_the_photo_itself_is_left_alone(self):
        """The old full-width bar painted across the bottom of every image."""
        src = make_image(600, 600, color=(120, 80, 200))
        out = branding.apply_brand(src, logo_bytes=None, accent_hex="#FF0000")
        img = Image.open(io.BytesIO(out)).convert("RGB")
        assert img.getpixel((300, 300)) == (120, 80, 200), "centre was altered"
        assert img.getpixel((20, 590)) == (120, 80, 200), "bottom-left was altered"

    def test_the_badge_lands_in_the_bottom_right(self):
        src = make_image(600, 600, color=(120, 80, 200))
        out = branding.apply_brand(src, logo_bytes=None, accent_hex="#FF0000")
        img = Image.open(io.BytesIO(out)).convert("RGB")
        diameter = max(branding.BADGE_MIN_PX, 600 // branding.BADGE_WIDTH_RATIO)
        margin = max(8, 600 // branding.BADGE_MARGIN_RATIO)
        centre = (600 - margin - diameter // 2, 600 - margin - diameter // 2)
        assert img.getpixel(centre) != (120, 80, 200), "nothing was drawn"

    def test_the_badge_is_round_not_square(self):
        """The corner of the badge's bounding box must still be the photograph."""
        src = make_image(600, 600, color=(120, 80, 200))
        out = branding.apply_brand(src, logo_bytes=None, accent_hex="#FF0000")
        img = Image.open(io.BytesIO(out)).convert("RGB")
        diameter = max(branding.BADGE_MIN_PX, 600 // branding.BADGE_WIDTH_RATIO)
        margin = max(8, 600 // branding.BADGE_MARGIN_RATIO)
        top_left_of_box = (600 - margin - diameter + 1, 600 - margin - diameter + 1)
        assert img.getpixel(top_left_of_box) == (120, 80, 200), "badge is square"

    def test_the_badge_stays_small(self):
        """A watermark, not a billboard."""
        diameter = max(branding.BADGE_MIN_PX, 1080 // branding.BADGE_WIDTH_RATIO)
        assert diameter / 1080 < 0.15

    def test_a_logo_is_composited_and_dimensions_are_preserved(self):
        src = make_image(800, 800)
        logo = make_image(200, 200, color=(0, 255, 0))
        out = branding.apply_brand(src, logo_bytes=logo, accent_hex=None)
        img = Image.open(io.BytesIO(out))
        assert img.size == (800, 800)

    def test_a_square_logo_is_clipped_to_the_circle(self):
        """A logo shipped on its own square background would otherwise show as a
        square patch inside the round badge."""
        src = make_image(600, 600, color=(120, 80, 200))
        logo = make_image(400, 400, color=(0, 255, 0))
        out = branding.apply_brand(src, logo_bytes=logo, accent_hex=None)
        img = Image.open(io.BytesIO(out)).convert("RGB")
        diameter = max(branding.BADGE_MIN_PX, 600 // branding.BADGE_WIDTH_RATIO)
        margin = max(8, 600 // branding.BADGE_MARGIN_RATIO)
        corner = (600 - margin - diameter + 1, 600 - margin - diameter + 1)
        assert img.getpixel(corner) == (120, 80, 200)

    def test_nothing_to_apply_leaves_the_image_untouched(self):
        src = make_image(400, 400, color=(10, 20, 30))
        out = branding.apply_brand(src, logo_bytes=None, accent_hex=None)
        img = Image.open(io.BytesIO(out)).convert("RGB")
        assert img.getpixel((200, 200)) == (10, 20, 30)
        assert img.getpixel((395, 395)) == (10, 20, 30)


class TestProviderSelection:
    def test_raises_when_no_provider_configured(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "")
        monkeypatch.setenv("GOOGLE_API_KEY", "")
        monkeypatch.setenv("IMAGE_PROVIDER", "openai")
        get_settings.cache_clear()
        with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
            image_provider.generate_image("a cat", "1024x1024")
        get_settings.cache_clear()

    def test_image_cost_lookup(self):
        result = image_provider.ImageResult(
            data=b"x", provider="openai", model="gpt-image-1", provider_size="1024x1024"
        )
        assert result.cost_usd == 0.04

    def test_dated_snapshots_price_as_their_base_model(self):
        """Pinning "gpt-image-2-2026-04-21" is normal; without prefix matching it
        would miss the table and bill at the default, overstating cost by a third."""
        assert image_provider.price_for("gpt-image-2-2026-04-21") == 0.03

    def test_mini_is_not_swallowed_by_the_gpt_image_1_prefix(self):
        """"gpt-image-1-mini" starts with "gpt-image-1", so a naive prefix match
        would price the cheap tier at 8x its real cost."""
        assert image_provider.price_for("gpt-image-1-mini") == 0.005

    def test_unknown_model_falls_back(self):
        assert image_provider.price_for("some-future-model") == image_provider.DEFAULT_IMAGE_PRICE


LATTE_BRIEF = (
    "A warm cinematic latte scene on a scuffed oak counter, morning light "
    "raking across the crema, a barista's hands still on the jug."
)


class TestImageAgent:
    def test_fallback_prompt_keeps_the_safety_rules(self):
        profile = {"industry": "coffee roasting", "businessName": "Acme"}
        req = image_agent.ImagePromptRequest(brief="a latte on a table", style="photorealistic")
        prompt = image_agent.fallback_prompt(profile, req)
        assert "latte" in prompt
        assert "coffee roasting" in prompt
        assert "no text or logos" in prompt

    def test_build_image_prompt_uses_llm(self, monkeypatch):
        from godeye_engine.ai.provider import LlmResult

        monkeypatch.setattr(
            image_agent.provider,
            "complete",
            lambda system, user, max_tokens=300: LlmResult(
                text=f'"{LATTE_BRIEF}"',
                provider="anthropic",
                model="claude-sonnet-5",
                input_tokens=50,
                output_tokens=20,
            ),
        )
        profile = {"industry": "coffee", "businessName": "Acme", "description": "roastery"}
        prompt = image_agent.build_image_prompt(
            profile, image_agent.ImagePromptRequest(brief="a latte")
        )
        # Surrounding quotes stripped, and the prompt now carries a one-line
        # strategy header recording the idea behind it, which the next image
        # reads back so it does not repeat the same creative category.
        assert prompt.startswith("[strategy] ")
        assert prompt.endswith(LATTE_BRIEF)


class TestImagePromptQuality:
    """Two consecutive posts came back as the same stock composition: hands
    reaching toward each other, split warm and cool light, bokeh. The profile
    held a location and an audience that were never passed to the agent, so
    every image was set nowhere and aimed at no one."""

    PROFILE: ClassVar[dict] = {
        "businessName": "PataMpoa",
        "industry": "Dating",
        "description": "A dating app.",
        "location": "Nairobi-Kenya",
        "targetAudience": "relationship seekers, content creators",
        "brandVoice": "warm and cool",
    }

    def test_the_location_reaches_the_model(self, monkeypatch):
        captured = {}

        def fake_complete(system, user, **kw):
            captured["user"] = user
            captured["system"] = system
            return image_provider_stub()

        monkeypatch.setattr(image_agent.provider, "complete", fake_complete)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "Nairobi" in captured["user"]

    def test_the_audience_reaches_the_model(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "content creators" in captured["user"]

    def test_brand_voice_is_marked_as_tone_not_lighting(self, monkeypatch):
        """"warm and cool" was being taken literally and turning up as split
        warm/cool lighting in the rendered image."""
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "not to be taken as a lighting" in captured["user"]

    def test_the_clichés_are_named_so_the_model_avoids_them(self):
        system = image_agent.PROMPT_SYSTEM
        assert "fingertips almost touching" in system
        assert "warm and cool light" in system

    def test_framing_varies_between_calls(self, monkeypatch):
        """Identical briefs must not converge on one composition."""
        seen = set()
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (seen.add(user.split("Framing to lean toward, same rule: ")[1]),
                                        image_provider_stub())[1],
        )
        import random as _random

        for seed in range(12):
            image_agent.build_image_prompt(
                self.PROFILE,
                image_agent.ImagePromptRequest(brief="a date night"),
                rng=_random.Random(seed),
            )
        assert len(seen) > 1, "every call picked the same framing"

    def test_the_fallback_still_names_the_place_and_the_people(self):
        """No LLM is exactly when the model is most likely to invent an
        American office."""
        prompt = image_agent.fallback_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "Nairobi" in prompt
        assert "content creators" in prompt
        assert "no text or logos" in prompt


# Long enough to be a real brief. A stub shorter than MIN_PROMPT_CHARS is
# indistinguishable from the empty reply that put a logic puzzle on a dating
# app's feed, and the agent now rejects it, correctly.
STUB_BRIEF = (
    "Tight portrait of a woman in her mid twenties in a small Nairobi bedroom, "
    "phone angled toward the camera, ring light caught in her irises, mid laugh."
)


def image_provider_stub():
    from godeye_engine.ai.provider import LlmResult

    return LlmResult(
        text=STUB_BRIEF,
        provider="anthropic", model="test",
        input_tokens=1, output_tokens=1,
    )


class TestTheAgentKnowsWhatTheBusinessSells:
    """The wristwatch.

    A PataMpoa post about earning from live video calls came back as a
    photograph of a wristwatch. The cause was not the model's taste: the image
    agent was given the business name, the word "Dating" and a caption, and was
    never once told that the business does video calls, streaming, gifts and
    payouts. The content agent had been given all of that from the start, which
    is why the captions were right and the pictures were not.

    With nothing concrete to photograph, "earning" resolves to a stock symbol
    of success. So the products and the services are the load-bearing input
    here, not an enrichment.
    """

    PROFILE: ClassVar[dict] = {
        "businessName": "PataMpoa",
        "industry": "Dating",
        "description": "A dating and live streaming app.",
        "location": "Nairobi-Kenya",
        "targetAudience": "relationship seekers, content creators",
        "services": ["live video calls", "gifting", "creator payouts"],
        "products": ["coin packs"],
        "goals": ["grow paying creators"],
        "seasonalNotes": "December holidays",
    }

    def _capture(self, monkeypatch) -> dict:
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        return captured

    def test_the_services_reach_the_model(self, monkeypatch):
        """The exact regression. Without these words there is no video call to
        photograph and the model draws a watch."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning from the app")
        )
        assert "live video calls" in captured["user"]
        assert "creator payouts" in captured["user"]

    def test_the_products_reach_the_model(self, monkeypatch):
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning from the app")
        )
        assert "coin packs" in captured["user"]

    def test_what_is_sold_must_be_recognisable(self, monkeypatch):
        """Listing the services is not enough on its own. The brief has to say
        they belong in the frame, or they read as background trivia."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning from the app")
        )
        assert "recognisable in the picture" in captured["user"]

    def test_the_goals_and_the_season_reach_the_model(self, monkeypatch):
        """Goals decide which outcome is worth photographing; the season is
        visible in weather, daylight and what people are wearing."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning from the app")
        )
        assert "grow paying creators" in captured["user"]
        assert "December holidays" in captured["user"]

    def test_a_profile_with_no_catalogue_is_told_so_explicitly(self, monkeypatch):
        """Silence is what caused the original failure, so an empty catalogue
        must not be silent. The model is told to work the subject out of the
        description rather than reach for an industry symbol."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            {"businessName": "Acme", "industry": "Dating", "description": "A dating app."},
            image_agent.ImagePromptRequest(brief="earning from the app"),
        )
        assert "No product or service list was supplied" in captured["user"]
        assert "generic symbol" in captured["user"]

    def test_a_solo_creator_is_the_person_in_shot(self, monkeypatch):
        """A creator is the product. An anonymous model sells a stranger."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            {**self.PROFILE, "orgType": "CREATOR"},
            image_agent.ImagePromptRequest(brief="a studio day"),
        )
        assert "solo creator" in captured["user"]

    def test_a_company_is_not_told_it_is_a_creator(self, monkeypatch):
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a studio day")
        )
        assert "solo creator" not in captured["user"]

    def test_the_website_is_still_withheld(self, monkeypatch):
        """A URL cannot be photographed and this brief bans text in the frame,
        so sending one only invites the model to draw it."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            {**self.PROFILE, "website": "https://patampoaglobal.com"},
            image_agent.ImagePromptRequest(brief="earning from the app"),
        )
        assert "patampoaglobal.com" not in captured["user"]

    def test_the_fallback_also_names_what_is_sold(self):
        """No text LLM is exactly when the model has least to go on."""
        prompt = image_agent.fallback_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning from the app")
        )
        assert "coin packs" in prompt

    def test_the_system_prompt_forbids_the_symbol(self):
        """"Sell the outcome, do not represent the business" pushed the agent
        toward abstraction with nothing pulling it back to the actual trade.
        The wristwatch is named so the rule cannot be read the wrong way."""
        system = image_agent.PROMPT_SYSTEM
        assert "wristwatch" in system
        assert "identifiable in the frame" in system
        assert "name the industry from the picture alone" in system


class TestTheCaptionDecidesThePicture:
    """Read the post, find what is happening, photograph that.

    The agent used to reason from the business to a marketing concept and only
    then to a picture, and posts got lost in the jump. An upbeat post calling
    on streamers to come and connect produced a woman alone in her room with an
    unlit ring light: a good photograph of the opposite of the post, because
    the rotated creative category said "problem" and outranked the caption.
    """

    POST = (
        "Calling all streamers and content creators in Nairobi and beyond. "
        "PataMpoa is where genuine connections happen, and where your audience "
        "can grow across borders. PataMpoa gives you the space to stream, "
        "connect, and turn conversations into opportunities."
    )

    def _capture(self, monkeypatch) -> dict:
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        return captured

    def test_the_post_is_labelled_as_the_post(self, monkeypatch):
        """It used to arrive as "Image brief", which invites interpretation.
        It is the caption that will run beside the picture."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            {"businessName": "PataMpoa", "industry": "Dating", "description": "Dating app."},
            image_agent.ImagePromptRequest(brief=self.POST),
        )
        assert "The post this image goes with:" in captured["user"]

    def test_the_category_is_a_suggestion_not_a_mandate(self, monkeypatch):
        """The regression. As a mandate it produced the opposite of the post."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            {"businessName": "PataMpoa", "industry": "Dating", "description": "Dating app."},
            image_agent.ImagePromptRequest(brief=self.POST),
        )
        assert "ignore if it fights it" in captured["user"]
        assert "Creative category to work inside" not in captured["user"]

    def test_the_extraction_is_demanded_in_order(self):
        system = image_agent.PROMPT_SYSTEM
        for label in ("SUBJECT:", "ACTION:", "WITH:", "OUTCOME:", "PROMPT:"):
            assert label in system, f"{label} missing from the reply format"
        assert system.index("SUBJECT:") < system.index("PROMPT:")

    def test_the_verb_is_photographed_not_symbolised(self):
        system = image_agent.PROMPT_SYSTEM
        assert "Photograph the verb" in system
        assert "abstract representation of authenticity" in system

    def test_people_posts_default_to_people(self):
        """Never a desk, a notebook or a calendar for a post about connecting."""
        system = image_agent.PROMPT_SYSTEM
        assert "realistic people interacting" in system
        assert "Relevant first, attractive second" in system

    def test_the_concept_is_recorded_in_the_header(self, monkeypatch):
        """The extraction is worth keeping: it is what the next image reads
        back to avoid repeating itself."""
        from godeye_engine.ai import creative_strategy
        from godeye_engine.ai.provider import LlmResult

        reply = (
            "SUBJECT: a Nairobi content creator\n"
            "ACTION: livestreaming to her audience\n"
            "WITH: viewers reacting in the chat\n"
            "OUTCOME: her audience growing across borders\n"
            "PROMPT: A woman in her mid twenties mid stream in a bright Nairobi "
            "apartment, ring light catching her face, phone propped in front of "
            "her, laughing at something a viewer just sent."
        )
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: LlmResult(
                text=reply, provider="anthropic", model="test",
                input_tokens=1, output_tokens=1,
            ),
        )
        prompt = image_agent.build_image_prompt(
            {"businessName": "PataMpoa", "industry": "Dating", "description": "Dating app."},
            image_agent.ImagePromptRequest(brief=self.POST),
        )
        header = creative_strategy.parse_header(prompt)
        assert "livestreaming" in header["hook"]
        assert "audience growing" in header["angle"]

    def test_an_unlabelled_reply_still_yields_the_brief(self, monkeypatch):
        """Format compliance is not worth failing a usable picture over."""
        concept = image_agent._split_reply("A woman mid stream in a Nairobi flat.")
        assert concept.prompt == "A woman mid stream in a Nairobi flat."
        assert concept.action == ""


class TestAnEmptyReplyNeverReachesTheImageModel:
    """The scales puzzle.

    A PataMpoa post produced a shapes-and-scales logic puzzle, and another
    produced a stock living room with a to-do list on the table. Both were
    stored with this as the entire prompt:

        [strategy] category=problem; angle=; hook=

    The photographic brief was empty and the image model drew the category
    name. "problem" became a literal logic problem. "lifestyle" became a
    lifestyle stock photo.

    The cause was a strict-output call with thinking left on: the model spent
    the whole 600 token budget thinking and returned a response with no text
    block. The header made the empty result look like a prompt, so nothing
    raised, the fallback never ran, and every run was recorded SUCCEEDED
    because a picture did come back.
    """

    PROFILE: ClassVar[dict] = {
        "businessName": "PataMpoa",
        "industry": "Dating",
        "description": "A dating app.",
        "services": ["live video calls"],
    }

    def _reply(self, monkeypatch, text: str):
        from godeye_engine.ai.provider import LlmResult

        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: LlmResult(
                text=text, provider="anthropic", model="test",
                input_tokens=1, output_tokens=1,
            ),
        )

    def test_an_empty_reply_raises_rather_than_returning_a_header(self, monkeypatch):
        self._reply(monkeypatch, "")
        with pytest.raises(ValueError, match="no usable brief"):
            image_agent.build_image_prompt(
                self.PROFILE, image_agent.ImagePromptRequest(brief="earning")
            )

    def test_a_reply_truncated_mid_label_raises(self, monkeypatch):
        """One stored prompt ended at "ANG", three characters into ANGLE."""
        self._reply(monkeypatch, "ANG")
        with pytest.raises(ValueError, match="no usable brief"):
            image_agent.build_image_prompt(
                self.PROFILE, image_agent.ImagePromptRequest(brief="earning")
            )

    def test_a_labelled_reply_with_an_empty_prompt_raises(self, monkeypatch):
        """The labels arriving is not the same as a brief arriving."""
        self._reply(monkeypatch, "ANGLE: payday\nHOOK: she sees the number\nPROMPT:")
        with pytest.raises(ValueError, match="no usable brief"):
            image_agent.build_image_prompt(
                self.PROFILE, image_agent.ImagePromptRequest(brief="earning")
            )

    def test_a_real_brief_still_passes(self, monkeypatch):
        brief = (
            "Tight portrait of a Kenyan woman in her mid twenties in a small "
            "Nairobi bedroom, phone angled toward camera showing a live call, "
            "ring light in her irises, caught mid laugh."
        )
        self._reply(monkeypatch, f"ANGLE: payday\nHOOK: the moment she sees it\nPROMPT: {brief}")
        prompt = image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning")
        )
        assert brief in prompt
        assert prompt.startswith("[strategy] ")

    def test_an_unlabelled_reply_is_still_accepted_as_the_brief(self, monkeypatch):
        """Tolerated on purpose. A model that ignores the labels but writes a
        real photographic brief has not failed, and failing the render over
        formatting would throw away a usable picture."""
        brief = (
            "Wide environmental shot of a Nairobi rooftop at golden hour, a "
            "creator packing up her ring light after a long stream, city "
            "buildings soft behind her."
        )
        self._reply(monkeypatch, brief)
        assert brief in image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="earning")
        )


class TestPlatformReachesTheBrief:
    """PLATFORM_BIAS existed for weeks and never once fired: the task hardcoded
    platform=None because an earlier attempt read a column that does not exist.
    """

    PROFILE: ClassVar[dict] = {"businessName": "PataMpoa", "industry": "Dating", "description": "A dating app."}

    def test_the_platform_culture_reaches_the_model(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        image_agent.build_image_prompt(
            self.PROFILE,
            image_agent.ImagePromptRequest(brief="a date night"),
            platform="TIKTOK",
        )
        assert "candid and unpolished" in captured["user"]

    def test_no_platform_adds_no_instruction(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "candid and unpolished" not in captured["user"]


class TestVariationAcrossRuns:
    """Rotating the framing alone is not enough: given the same brief a model
    lands on the same idea and merely photographs it from a new angle."""

    PROFILE: ClassVar[dict] = {"businessName": "PataMpoa", "industry": "Dating", "description": "A dating app."}

    def _capture(self, monkeypatch) -> dict:
        captured = {}
        monkeypatch.setattr(
            image_agent.provider, "complete",
            lambda system, user, **kw: (captured.update(user=user), image_provider_stub())[1],
        )
        return captured

    def test_recent_images_are_shown_to_the_agent(self, monkeypatch):
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE,
            image_agent.ImagePromptRequest(brief="a date night"),
            recent_prompts=["Two hands reaching toward each other over a map"],
        )
        assert "hands reaching toward each other" in captured["user"]
        assert "must be a different photograph" in captured["user"]

    def test_no_history_means_no_stray_instruction(self, monkeypatch):
        """A first image has nothing to differ from, and inventing a list would
        have the agent avoiding pictures nobody made."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE, image_agent.ImagePromptRequest(brief="a date night")
        )
        assert "different photograph" not in captured["user"]

    def test_only_the_last_few_are_sent(self, monkeypatch):
        """The whole back catalogue would crowd out the brief itself."""
        captured = self._capture(monkeypatch)
        image_agent.build_image_prompt(
            self.PROFILE,
            image_agent.ImagePromptRequest(brief="a date night"),
            recent_prompts=[f"prompt number {i}" for i in range(20)],
        )
        assert "prompt number 3" in captured["user"]
        assert "prompt number 9" not in captured["user"]


class TestJpegEncoding:
    """Generated images ship as JPEG. TikTok's photo endpoint rejects PNG with
    file_format_check_failed, and every other network takes JPEG."""

    def test_output_is_a_readable_jpeg(self):
        out = branding.to_jpeg(make_image(1080, 1080))
        img = Image.open(io.BytesIO(out))
        assert img.format == "JPEG"
        assert img.size == (1080, 1080)

    def test_it_is_much_smaller_than_the_png(self):
        """The real 1080x1080 frame was 1.6 MB as PNG. Photographic detail is
        where JPEG wins; a flat colour would compress smaller as PNG and prove
        nothing about a generated photograph."""
        import random

        rng = random.Random(0)
        noisy = Image.new("RGB", (1080, 1080))
        noisy.putdata([
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(1080 * 1080)
        ])
        buf = io.BytesIO()
        noisy.save(buf, format="PNG")
        png = buf.getvalue()
        jpeg = branding.to_jpeg(png)
        assert len(jpeg) < len(png) * 0.7, f"png={len(png)} jpeg={len(jpeg)}"

    def test_a_transparent_source_is_flattened_rather_than_failing(self):
        """JPEG has no alpha channel, and Pillow raises rather than guessing."""
        buf = io.BytesIO()
        Image.new("RGBA", (400, 400), (10, 200, 90, 128)).save(buf, format="PNG")
        img = Image.open(io.BytesIO(branding.to_jpeg(buf.getvalue())))
        assert img.mode == "RGB"

    def test_a_branded_image_survives_the_round_trip(self):
        """The badge is composited before this runs, so it has to come through."""
        branded = branding.apply_brand(
            make_image(600, 600, color=(120, 80, 200)), logo_bytes=None, accent_hex="#FF0000"
        )
        img = Image.open(io.BytesIO(branding.to_jpeg(branded))).convert("RGB")
        assert img.size == (600, 600)
        r, g, b = img.getpixel((300, 300))
        assert abs(r - 120) < 8 and abs(g - 80) < 8 and abs(b - 200) < 8
