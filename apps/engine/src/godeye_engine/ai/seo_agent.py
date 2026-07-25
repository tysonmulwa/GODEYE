"""SEO Agent — LLM-powered keyword research, meta rewrites, and schema markup."""

from __future__ import annotations

import json
from typing import Any

from . import mission, provider
from .content_agent import parse_response

SYSTEM_PROMPT = mission.charter("seo") + "\n\n" + (
    "Deliver realistic keywords a small business can rank for, compelling meta "
    "tags, and valid schema.org markup, grounded in the crawled site. "
    "Respond ONLY with valid JSON — no markdown fences, no commentary."
)


def keyword_research(
    site_url: str, site_summary: str, profile: dict[str, Any] | None = None
) -> tuple[dict[str, Any], provider.LlmResult]:
    """Keyword clusters grouped by topic + search intent, grounded in the crawled site.

    The site's own crawled content is the source of truth. ``profile`` is passed
    ONLY when the audited URL is the user's own registered website; for any other
    site it stays ``None`` so the keywords reflect what the site actually sells /
    is about — not the user's unrelated business.
    """
    lines = [
        "You are auditing the website below. First infer, purely from its real",
        "crawled content, what this site is actually about — its niche, products,",
        "services and audience. Then do keyword research for THAT. Do not import a",
        "topic the content doesn't support.",
        "",
        f"Website: {site_url}",
        f"Crawled content ({len(site_summary)} chars):",
        site_summary[:6000],
        "",
    ]
    if profile and profile.get("businessName"):
        lines += [
            "The site owner describes their business as follows (supporting context",
            "only — the crawled content above is the source of truth):",
            f"- {profile.get('businessName')} ({profile.get('industry')}): {profile.get('description')}",
            f"- Audience: {profile.get('targetAudience')}",
            f"- Location: {profile.get('location') or 'not location-specific'}",
            "",
        ]
    lines += [
        "Return 4-6 keyword clusters that match the site's real subject matter.",
        "Respond with EXACTLY this JSON shape:",
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
        "include local variants only if the site is clearly location-specific.",
    ]
    user = "\n".join(lines)
    llm = provider.complete(SYSTEM_PROMPT, user, max_tokens=1500)
    data = parse_response(llm.text)
    clusters = data.get("clusters")
    if not isinstance(clusters, list) or not clusters:
        raise ValueError("SEO Agent returned no keyword clusters")
    return {"clusters": clusters}, llm


def meta_suggestions(
    pages: list[dict[str, Any]], profile: dict[str, Any] | None = None
) -> tuple[list[dict[str, Any]], provider.LlmResult]:
    """Rewrite weak titles/descriptions for up to 10 problem pages.

    Suggestions are driven by each page's own content (title, heading, URL);
    ``profile`` is added as context only when the audited URL is the user's own
    website, so tags describe what each page really is.
    """
    page_lines = [
        {
            "page": p["url"],
            "currentTitle": p.get("title"),
            "currentDescription": p.get("meta_description"),
            "h1": (p.get("h1s") or [None])[0],
        }
        for p in pages[:10]
    ]
    lines = [
        "These pages have weak or missing meta tags. Base each rewrite on that",
        "page's own title / heading / URL — describe what the page is actually about.",
        "",
        json.dumps(page_lines, indent=2),
    ]
    if profile and profile.get("businessName"):
        lines += [
            "",
            f"Site owner (context): {profile.get('businessName')} "
            f"({profile.get('industry')}) — {profile.get('description')}",
        ]
    lines += [
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
    user = "\n".join(lines)
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
