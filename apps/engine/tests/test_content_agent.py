"""Content Agent unit tests, prompt assembly, parsing, limit enforcement."""

import json

import pytest

from godeye_engine.ai import content_agent
from godeye_engine.ai.provider import LlmResult

PROFILE = {
    "businessName": "Acme Coffee",
    "industry": "Food & Beverage",
    "description": "Specialty coffee roastery.",
    "targetAudience": "Coffee lovers 25-45.",
    "location": "Nairobi",
    "brandVoice": "Warm and playful",
    "products": ["Beans", "Cold brew"],
    "goals": ["Grow Instagram"],
}


def make_request(platforms=None):
    return content_agent.ContentRequest(
        goal="Announce new cold brew",
        platforms=platforms or ["TELEGRAM", "DISCORD"],
        tone="excited",
        topic="Cold brew launch",
        call_to_action="Order now",
    )


class TestBuildPrompt:
    def test_includes_profile_and_request_fields(self):
        prompt = content_agent.build_prompt(PROFILE, make_request())
        assert "Acme Coffee" in prompt
        assert "Warm and playful" in prompt
        assert "Announce new cold brew" in prompt
        assert "Order now" in prompt
        assert "TELEGRAM" in prompt and "DISCORD" in prompt

    def test_includes_platform_length_limits(self):
        prompt = content_agent.build_prompt(PROFILE, make_request(["DISCORD"]))
        assert "max 2000 characters" in prompt


class TestParseResponse:
    def test_parses_clean_json(self):
        data = {"title": "T", "body": "B", "hashtags": [], "variants": {}}
        assert content_agent.parse_response(json.dumps(data)) == data

    def test_strips_code_fences(self):
        payload = '```json\n{"title": "T", "body": "B"}\n```'
        assert content_agent.parse_response(payload)["title"] == "T"

    def test_extracts_json_from_prose(self):
        payload = 'Here you go: {"title": "T", "body": "B"} enjoy!'
        assert content_agent.parse_response(payload)["body"] == "B"

    def test_raises_on_garbage(self):
        with pytest.raises(ValueError):
            content_agent.parse_response("no json here at all")


class TestEnforceLimits:
    def test_fills_missing_variants_from_base(self):
        data = {"title": "T", "body": "Base body", "hashtags": ["a"], "variants": {}}
        result = content_agent.enforce_limits(data, ["TELEGRAM"])
        assert result["variants"]["TELEGRAM"]["body"] == "Base body"
        assert result["variants"]["TELEGRAM"]["hashtags"] == ["a"]

    def test_truncates_over_limit_variant(self):
        long_body = "x" * 5000
        data = {
            "title": "T",
            "body": "b",
            "hashtags": [],
            "variants": {"DISCORD": {"body": long_body, "hashtags": []}},
        }
        result = content_agent.enforce_limits(data, ["DISCORD"])
        assert len(result["variants"]["DISCORD"]["body"]) <= 2000

    def test_strips_hash_prefix_from_hashtags(self):
        data = {"title": "T", "body": "b", "hashtags": ["#coffee"], "variants": {}}
        result = content_agent.enforce_limits(data, ["TELEGRAM"])
        assert result["hashtags"] == ["coffee"]


class TestGenerate:
    def test_full_pipeline_with_mocked_llm(self, monkeypatch):
        response = json.dumps(
            {
                "title": "Cold Brew Launch",
                "body": "Big news ☕",
                "hashtags": ["coldbrew"],
                "variants": {
                    "TELEGRAM": {"body": "Telegram text", "hashtags": ["coldbrew"]},
                    "DISCORD": {"body": "Discord text", "hashtags": []},
                },
            }
        )
        monkeypatch.setattr(
            content_agent.provider,
            "complete",
            lambda system, user, max_tokens=2500: LlmResult(
                text=response,
                provider="anthropic",
                model="claude-sonnet-5",
                input_tokens=500,
                output_tokens=200,
            ),
        )
        result = content_agent.generate(PROFILE, make_request())
        assert result.title == "Cold Brew Launch"
        assert result.variants["TELEGRAM"]["body"] == "Telegram text"
        assert result.ab_variants is None
        assert result.llm.input_tokens == 500
        assert result.llm.cost_usd > 0


class TestAbVariants:
    def test_prompt_requests_ab_when_enabled(self):
        req = make_request()
        req.ab_test = True
        prompt = content_agent.build_prompt(PROFILE, req)
        assert "abVariants" in prompt
        assert "different creative" in prompt.lower()

    def test_extract_ab_variants_normalizes(self):
        raw = {
            "abVariants": {
                "A": {"body": "Angle one", "hashtags": ["#tag"]},
                "B": {"body": "Angle two", "hashtags": ["tag2"]},
            }
        }
        ab = content_agent.extract_ab_variants(raw)
        assert ab["A"]["body"] == "Angle one"
        assert ab["A"]["hashtags"] == ["tag"]  # # stripped
        assert ab["B"]["body"] == "Angle two"

    def test_extract_returns_none_when_missing(self):
        assert content_agent.extract_ab_variants({"body": "x"}) is None

    def test_extract_returns_none_when_incomplete(self):
        assert content_agent.extract_ab_variants({"abVariants": {"A": {"body": "x"}}}) is None

    def test_generate_includes_ab_when_requested(self, monkeypatch):
        response = json.dumps(
            {
                "title": "T",
                "body": "canonical",
                "hashtags": [],
                "variants": {"TELEGRAM": {"body": "tg", "hashtags": []}},
                "abVariants": {
                    "A": {"body": "Emotional angle", "hashtags": []},
                    "B": {"body": "Factual angle", "hashtags": []},
                },
            }
        )
        monkeypatch.setattr(
            content_agent.provider,
            "complete",
            lambda system, user, max_tokens=2500: LlmResult(
                text=response, provider="anthropic", model="claude-sonnet-5",
                input_tokens=100, output_tokens=100,
            ),
        )
        req = make_request(["TELEGRAM"])
        req.ab_test = True
        result = content_agent.generate(PROFILE, req)
        assert result.ab_variants is not None
        assert result.ab_variants["A"]["body"] == "Emotional angle"
        assert result.ab_variants["B"]["body"] == "Factual angle"
