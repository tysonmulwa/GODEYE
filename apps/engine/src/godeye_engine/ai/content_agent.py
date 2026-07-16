"""Content Agent v1 — turns a business profile + goal into platform-ready posts."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from . import provider

PLATFORM_LIMITS = {
    "TELEGRAM": 4096,
    "DISCORD": 2000,
    "REDDIT": 40000,
    "FACEBOOK": 63206,
    "INSTAGRAM": 2200,
    "X": 280,
    "LINKEDIN": 3000,
    "THREADS": 500,
}

SYSTEM_PROMPT = """You are the Content Agent of GODEYE, an AI marketing platform. \
You write high-performing social media content that sounds human, matches the brand \
voice exactly, and is tailored to each platform's culture and length limits. \
You respond ONLY with valid JSON — no markdown fences, no commentary."""


@dataclass
class ContentRequest:
    goal: str
    platforms: list[str]
    tone: str | None = None
    topic: str | None = None
    call_to_action: str | None = None
    ab_test: bool = False


@dataclass
class GeneratedContent:
    title: str
    body: str
    hashtags: list[str]
    variants: dict[str, dict[str, Any]]
    ab_variants: dict[str, dict[str, Any]] | None = None
    llm: provider.LlmResult = field(repr=False, default=None)  # type: ignore[assignment]


def build_prompt(profile: dict[str, Any], request: ContentRequest) -> str:
    """Assemble the user prompt from the business profile and the request."""
    lines = [
        "Create social media content for this business:",
        "",
        f"Business: {profile.get('businessName')}",
        f"Industry: {profile.get('industry')}",
        f"Description: {profile.get('description')}",
        f"Target audience: {profile.get('targetAudience')}",
    ]
    if profile.get("location"):
        lines.append(f"Location: {profile['location']}")
    if profile.get("website"):
        lines.append(f"Website: {profile['website']}")
    if profile.get("products"):
        lines.append(f"Products: {', '.join(profile['products'])}")
    if profile.get("services"):
        lines.append(f"Services: {', '.join(profile['services'])}")
    if profile.get("brandVoice"):
        lines.append(f"Brand voice: {profile['brandVoice']}")
    if profile.get("goals"):
        lines.append(f"Business goals: {', '.join(profile['goals'])}")

    lines += ["", f"Post goal: {request.goal}"]
    if request.topic:
        lines.append(f"Topic: {request.topic}")
    if request.tone:
        lines.append(f"Tone override: {request.tone}")
    if request.call_to_action:
        lines.append(f"Call to action: {request.call_to_action}")

    platform_specs = "\n".join(
        f"- {p} (max {PLATFORM_LIMITS.get(p, 5000)} characters)" for p in request.platforms
    )
    shape: dict[str, Any] = {
        "title": "short internal title for this post",
        "body": "the canonical post text",
        "hashtags": ["tag1", "tag2"],
        "variants": {
            p: {"body": f"text adapted for {p}", "hashtags": ["tag"]}
            for p in request.platforms
        },
    }
    if request.ab_test:
        shape["abVariants"] = {
            "A": {"body": "first creative angle", "hashtags": ["tag"]},
            "B": {"body": "clearly different second angle", "hashtags": ["tag"]},
        }
    lines += [
        "",
        "Target platforms:",
        platform_specs,
        "",
        "Respond with EXACTLY this JSON shape:",
        json.dumps(shape, indent=2),
        "",
        "Rules: hashtags without the # prefix; every variant must respect its platform's",
        "length limit INCLUDING hashtags; adapt style per platform (Reddit: no hashtags,",
        "conversational; Telegram/Discord: community tone; Instagram: emotive, emoji ok).",
    ]
    if request.ab_test:
        lines.append(
            "A/B rule: abVariants.A and abVariants.B must take genuinely different creative "
            "angles (e.g. emotional vs. factual, question vs. statement) — not rewordings."
        )
    return "\n".join(lines)


def parse_response(text: str) -> dict[str, Any]:
    """Parse the model's JSON, tolerating accidental code fences or prose."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            raise ValueError(f"Model did not return JSON: {text[:200]}")
        return json.loads(match.group(0))


def enforce_limits(data: dict[str, Any], platforms: list[str]) -> dict[str, Any]:
    """Guarantee every variant exists and respects its platform limit."""
    variants: dict[str, dict[str, Any]] = {}
    base_body = str(data.get("body", ""))
    base_tags = [str(t).lstrip("#") for t in data.get("hashtags", [])][:30]
    for p in platforms:
        raw = (data.get("variants") or {}).get(p) or {}
        body = str(raw.get("body") or base_body)
        tags = [str(t).lstrip("#") for t in (raw.get("hashtags") or base_tags)][:30]
        limit = PLATFORM_LIMITS.get(p, 5000)
        suffix = (" " + " ".join(f"#{t}" for t in tags)) if tags and p != "REDDIT" else ""
        if len(body) + len(suffix) > limit:
            body = body[: max(0, limit - len(suffix) - 1)].rstrip() + "…"
        variants[p] = {"body": body, "hashtags": tags}
    return {
        "title": str(data.get("title") or base_body[:60] or "Untitled post"),
        "body": base_body,
        "hashtags": base_tags,
        "variants": variants,
    }


def extract_ab_variants(raw: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    """Return normalized {A, B} variants, or None if the model skipped them."""
    ab = raw.get("abVariants")
    if not isinstance(ab, dict) or "A" not in ab or "B" not in ab:
        return None
    out: dict[str, dict[str, Any]] = {}
    for key in ("A", "B"):
        variant = ab[key] or {}
        out[key] = {
            "body": str(variant.get("body", "")),
            "hashtags": [str(t).lstrip("#") for t in (variant.get("hashtags") or [])][:30],
        }
    if not out["A"]["body"] or not out["B"]["body"]:
        return None
    return out


def generate(profile: dict[str, Any], request: ContentRequest) -> GeneratedContent:
    """Full pipeline: prompt → LLM → parse → enforce limits."""
    prompt = build_prompt(profile, request)
    llm = provider.complete(SYSTEM_PROMPT, prompt)
    raw = parse_response(llm.text)
    data = enforce_limits(raw, request.platforms)
    return GeneratedContent(
        title=data["title"],
        body=data["body"],
        hashtags=data["hashtags"],
        variants=data["variants"],
        ab_variants=extract_ab_variants(raw) if request.ab_test else None,
        llm=llm,
    )
