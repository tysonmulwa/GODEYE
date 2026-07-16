"""SEO Agent — LLM-powered keyword research, meta rewrites, and schema markup."""

from __future__ import annotations

import json
from typing import Any

from . import provider
from .content_agent import parse_response

SYSTEM_PROMPT = """You are the SEO Agent of GODEYE, an AI marketing platform. \
You do practical, white-hat SEO: realistic keywords a small business can rank for, \
compelling meta tags, and valid schema.org markup. \
You respond ONLY with valid JSON — no markdown fences, no commentary."""


def keyword_research(
    profile: dict[str, Any], site_summary: str
) -> tuple[dict[str, Any], provider.LlmResult]:
    """Keyword clusters grouped by topic + search intent."""
    user = "\n".join(
        [
            "Do keyword research for this business:",
            f"Business: {profile.get('businessName')} ({profile.get('industry')})",
            f"What they do: {profile.get('description')}",
            f"Audience: {profile.get('targetAudience')}",
            f"Location: {profile.get('location') or 'not location-specific'}",
            f"Products/services: {', '.join((profile.get('products') or []) + (profile.get('services') or [])) or 'n/a'}",
            "",
            f"Site content summary: {site_summary[:1500]}",
            "",
            "Return 4-6 keyword clusters. Respond with EXACTLY this JSON shape:",
            json.dumps(
                {
                    "clusters": [
                        {
                            "topic": "cluster theme",
                            "intent": "informational | commercial | transactional | navigational",
                            "keywords": ["keyword 1", "keyword 2", "long-tail keyword phrase"],
                        }
                    ]
                },
                indent=2,
            ),
            "",
            "Rules: 4-8 keywords per cluster; prioritize achievable long-tail terms;",
            "include local variants when the business has a location.",
        ]
    )
    llm = provider.complete(SYSTEM_PROMPT, user, max_tokens=1500)
    data = parse_response(llm.text)
    clusters = data.get("clusters")
    if not isinstance(clusters, list) or not clusters:
        raise ValueError("SEO Agent returned no keyword clusters")
    return {"clusters": clusters}, llm


def meta_suggestions(
    profile: dict[str, Any], pages: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], provider.LlmResult]:
    """Rewrite weak titles/descriptions for up to 10 problem pages."""
    page_lines = [
        {
            "page": p["url"],
            "currentTitle": p.get("title"),
            "currentDescription": p.get("meta_description"),
            "h1": (p.get("h1s") or [None])[0],
        }
        for p in pages[:10]
    ]
    user = "\n".join(
        [
            f"Business: {profile.get('businessName')} ({profile.get('industry')}) — "
            f"{profile.get('description')}",
            "",
            "These pages have weak or missing meta tags:",
            json.dumps(page_lines, indent=2),
            "",
            "Write an optimized title (<60 chars) and meta description (50-160 chars) for each.",
            "Respond with EXACTLY this JSON shape:",
            json.dumps(
                {
                    "suggestions": [
                        {
                            "page": "url",
                            "suggestedTitle": "…",
                            "suggestedDescription": "…",
                        }
                    ]
                },
                indent=2,
            ),
        ]
    )
    llm = provider.complete(SYSTEM_PROMPT, user, max_tokens=2000)
    data = parse_response(llm.text)
    raw = data.get("suggestions") or []
    by_url = {p["url"]: p for p in pages}
    suggestions = []
    for item in raw:
        page = by_url.get(item.get("page"))
        suggestions.append(
            {
                "page": item.get("page", ""),
                "currentTitle": page.get("title") if page else None,
                "suggestedTitle": str(item.get("suggestedTitle") or "")[:70],
                "currentDescription": page.get("meta_description") if page else None,
                "suggestedDescription": str(item.get("suggestedDescription") or "")[:170],
            }
        )
    return suggestions, llm


def build_schema_markup(profile: dict[str, Any], url: str) -> dict[str, Any]:
    """Deterministic JSON-LD from the business profile (no LLM needed)."""
    schema: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness" if profile.get("location") else "Organization",
        "name": profile.get("businessName") or "",
        "description": (profile.get("description") or "")[:300],
        "url": url,
    }
    if profile.get("location"):
        schema["address"] = {"@type": "PostalAddress", "addressLocality": profile["location"]}
    products = profile.get("products") or []
    if products:
        schema["makesOffer"] = [
            {"@type": "Offer", "itemOffered": {"@type": "Product", "name": name}}
            for name in products[:10]
        ]
    return schema
