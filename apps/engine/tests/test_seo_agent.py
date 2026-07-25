"""SEO Agent — keyword parsing, meta suggestions, deterministic schema markup."""

import json

import pytest

from godeye_engine.ai import seo_agent
from godeye_engine.ai.provider import LlmResult

PROFILE = {
    "businessName": "Acme Coffee",
    "industry": "Food & Beverage",
    "description": "Specialty coffee roastery in Nairobi.",
    "targetAudience": "Coffee lovers",
    "location": "Nairobi, Kenya",
    "products": ["Single-origin beans", "Cold brew kits"],
}


def mock_llm(monkeypatch, payload: dict):
    monkeypatch.setattr(
        seo_agent.provider,
        "complete",
        lambda system, user, max_tokens=1500: LlmResult(
            text=json.dumps(payload),
            provider="anthropic",
            model="claude-sonnet-5",
            input_tokens=300,
            output_tokens=200,
        ),
    )


class TestKeywordResearch:
    def test_returns_clusters(self, monkeypatch):
        mock_llm(
            monkeypatch,
            {
                "clusters": [
                    {
                        "topic": "Specialty coffee Nairobi",
                        "intent": "commercial",
                        "keywords": ["specialty coffee nairobi", "buy coffee beans kenya"],
                    }
                ]
            },
        )
        keywords, llm = seo_agent.keyword_research("https://acme.coffee", "site summary", PROFILE)
        assert len(keywords["clusters"]) == 1
        assert llm.cost_usd > 0

    def test_raises_on_empty_clusters(self, monkeypatch):
        mock_llm(monkeypatch, {"clusters": []})
        with pytest.raises(ValueError, match="no keyword clusters"):
            seo_agent.keyword_research("https://acme.coffee", "summary")

    def test_foreign_site_excludes_business_profile(self, monkeypatch):
        """Auditing a site that isn't the user's own must not leak their business."""
        captured: dict[str, str] = {}

        def fake_complete(system, user, max_tokens=1500):
            captured["user"] = user
            return LlmResult(
                text=json.dumps(
                    {"clusters": [{"topic": "t", "intent": "commercial", "keywords": ["a", "b"]}]}
                ),
                provider="anthropic",
                model="claude-sonnet-5",
                input_tokens=1,
                output_tokens=1,
            )

        monkeypatch.setattr(seo_agent.provider, "complete", fake_complete)
        seo_agent.keyword_research(
            "https://mjinicollection.com", "Handmade jewelry and fashion accessories", None
        )
        assert "mjinicollection.com" in captured["user"]
        assert "jewelry" in captured["user"].lower()
        assert "Acme Coffee" not in captured["user"]  # no profile leak


class TestMetaSuggestions:
    def test_merges_current_values(self, monkeypatch):
        mock_llm(
            monkeypatch,
            {
                "suggestions": [
                    {
                        "page": "https://example.com/shop",
                        "suggestedTitle": "Buy Specialty Coffee Beans | Acme",
                        "suggestedDescription": "Order freshly roasted single-origin Kenyan "
                        "coffee with free Nairobi delivery.",
                    }
                ]
            },
        )
        pages = [
            {
                "url": "https://example.com/shop",
                "title": "shop",
                "meta_description": None,
                "h1s": ["Shop"],
            }
        ]
        suggestions, _ = seo_agent.meta_suggestions(pages, PROFILE)
        assert suggestions[0]["currentTitle"] == "shop"
        assert suggestions[0]["currentDescription"] is None
        assert suggestions[0]["suggestedTitle"].startswith("Buy Specialty")


class TestSchemaMarkup:
    def test_local_business_when_location_present(self):
        schema = seo_agent.build_schema_markup(PROFILE, "https://example.com")
        assert schema["@type"] == "LocalBusiness"
        assert schema["address"]["addressLocality"] == "Nairobi, Kenya"
        assert len(schema["makesOffer"]) == 2

    def test_organization_without_location(self):
        profile = {**PROFILE, "location": None}
        schema = seo_agent.build_schema_markup(profile, "https://example.com")
        assert schema["@type"] == "Organization"
        assert "address" not in schema
