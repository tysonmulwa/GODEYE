"""Image presets, Pillow processing, and provider selection."""

import io

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
    def test_accent_bar_applied_without_logo(self):
        src = make_image(600, 600)
        out = branding.apply_brand(src, logo_bytes=None, accent_hex="#FF0000")
        img = Image.open(io.BytesIO(out)).convert("RGB")
        # bottom row should now contain red pixels from the accent bar
        bottom_pixel = img.getpixel((300, 599))
        assert bottom_pixel[0] > 200 and bottom_pixel[1] < 60

    def test_logo_composited(self):
        src = make_image(800, 800)
        logo = make_image(200, 200, color=(0, 255, 0))
        out = branding.apply_brand(src, logo_bytes=logo, accent_hex=None)
        img = Image.open(io.BytesIO(out))
        assert img.size == (800, 800)  # dimensions preserved


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
                text='"A warm cinematic latte scene"',
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
        # surrounding quotes stripped
        assert prompt == "A warm cinematic latte scene"


class TestImagePromptQuality:
    """Two consecutive posts came back as the same stock composition: hands
    reaching toward each other, split warm and cool light, bokeh. The profile
    held a location and an audience that were never passed to the agent, so
    every image was set nowhere and aimed at no one."""

    PROFILE = {
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
            lambda system, user, **kw: (seen.add(user.split("Use this framing: ")[1]),
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


def image_provider_stub():
    from godeye_engine.ai.provider import LlmResult

    return LlmResult(
        text="A specific photographic prompt.",
        provider="anthropic", model="test",
        input_tokens=1, output_tokens=1,
    )
