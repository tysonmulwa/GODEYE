"""Video Agent, prompt assembly and script normalization."""

import json

import pytest

from godeye_engine.ai import video_agent
from godeye_engine.ai.provider import LlmResult

PROFILE = {
    "businessName": "Acme Coffee",
    "industry": "Food & Beverage",
    "description": "Specialty coffee roastery.",
    "targetAudience": "Coffee lovers 25-45.",
    "brandVoice": "Warm and playful",
}


class TestBuildPrompt:
    def test_includes_profile_brief_and_duration(self):
        prompt = video_agent.build_prompt(PROFILE, "cold brew launch", 30, None)
        assert "Acme Coffee" in prompt
        assert "cold brew launch" in prompt
        assert "30 seconds" in prompt
        assert "visualPrompt" in prompt

    def test_scene_count_scales_with_duration(self):
        short = video_agent.build_prompt(PROFILE, "x", 15, None)
        long = video_agent.build_prompt(PROFILE, "x", 60, None)
        assert "exactly 2 scenes" in short
        assert "exactly 8 scenes" in long


class TestNormalizeScript:
    def valid_raw(self, scenes=3):
        return {
            "title": "T",
            "hook": "Stop scrolling!",
            "scenes": [
                {
                    "narration": f"Scene {i} narration",
                    "visualPrompt": f"Scene {i} visual",
                    "onScreenText": f"Text {i}" if i % 2 == 0 else None,
                }
                for i in range(scenes)
            ],
            "cta": "Order now",
            "hashtags": ["#coldbrew", "coffee"],
        }

    def test_normalizes_valid_script(self):
        script = video_agent.normalize_script(self.valid_raw())
        assert script.title == "T"
        assert len(script.scenes) == 3
        assert script.scenes[0].on_screen_text == "Text 0"
        assert script.scenes[1].on_screen_text is None
        assert script.hashtags == ["coldbrew", "coffee"]  # '#' stripped

    def test_caps_scene_count(self):
        script = video_agent.normalize_script(self.valid_raw(scenes=12))
        assert len(script.scenes) == video_agent.MAX_SCENES

    def test_skips_incomplete_scenes(self):
        raw = self.valid_raw()
        raw["scenes"][1]["narration"] = ""
        script = video_agent.normalize_script(raw)
        assert len(script.scenes) == 2

    def test_raises_on_no_scenes(self):
        with pytest.raises(ValueError, match="no scenes"):
            video_agent.normalize_script({"scenes": []})

    def test_raises_when_below_min_scenes(self):
        raw = self.valid_raw(scenes=1)
        with pytest.raises(ValueError, match="at least"):
            video_agent.normalize_script(raw)

    def test_full_narration_joins_scenes(self):
        script = video_agent.normalize_script(self.valid_raw(scenes=2))
        assert script.full_narration == "Scene 0 narration Scene 1 narration"


class TestGenerateScript:
    def test_pipeline_with_mocked_llm(self, monkeypatch):
        raw = {
            "title": "Cold Brew in 30s",
            "hook": "You're overpaying for coffee.",
            "scenes": [
                {"narration": "You're overpaying for coffee.", "visualPrompt": "barista pouring"},
                {"narration": "Our subscription halves the cost.", "visualPrompt": "beans macro"},
            ],
            "cta": "Link in bio",
            "hashtags": ["coffee"],
        }
        monkeypatch.setattr(
            video_agent.provider,
            "complete",
            lambda system, user, max_tokens=2000: LlmResult(
                text=json.dumps(raw),
                provider="anthropic",
                model="claude-sonnet-5",
                input_tokens=400,
                output_tokens=250,
            ),
        )
        script, llm = video_agent.generate_script(PROFILE, "cold brew", 20)
        assert script.hook.startswith("You're overpaying")
        assert llm.cost_usd > 0
