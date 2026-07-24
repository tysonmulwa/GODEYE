"""Provider-agnostic LLM access: Anthropic, then OpenAI, then Gemini."""

from __future__ import annotations

from dataclasses import dataclass

from ..config import get_settings

# USD per million tokens (input, output) — used for AgentRun cost accounting.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet-5": (3.0, 15.0),
    "claude-opus-4-8": (15.0, 75.0),
    "claude-haiku-4-5": (0.80, 4.0),
    "gpt-4o-mini": (0.15, 0.60),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-1.5-flash": (0.075, 0.30),
}
DEFAULT_PRICE = (3.0, 15.0)


@dataclass
class LlmResult:
    text: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int

    @property
    def cost_usd(self) -> float:
        price_in, price_out = MODEL_PRICES.get(self.model, DEFAULT_PRICE)
        return (self.input_tokens * price_in + self.output_tokens * price_out) / 1_000_000


def complete(system: str, user: str, max_tokens: int = 2500) -> LlmResult:
    """Run a single completion. Raises RuntimeError if no provider is configured."""
    settings = get_settings()
    if settings.anthropic_api_key:
        return _anthropic(system, user, max_tokens)
    if settings.openai_api_key:
        return _openai(system, user, max_tokens)
    if settings.google_api_key:
        return _gemini(system, user, max_tokens)
    raise RuntimeError(
        "No AI provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, "
        "or GOOGLE_API_KEY (Gemini) in .env"
    )


def _anthropic(system: str, user: str, max_tokens: int) -> LlmResult:
    import anthropic

    settings = get_settings()
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    response = client.messages.create(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(block.text for block in response.content if block.type == "text")
    return LlmResult(
        text=text,
        provider="anthropic",
        model=settings.anthropic_model,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
    )


def _openai(system: str, user: str, max_tokens: int) -> LlmResult:
    from openai import OpenAI

    settings = get_settings()
    client = OpenAI(api_key=settings.openai_api_key)
    model = "gpt-4o-mini"
    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    usage = response.usage
    return LlmResult(
        text=response.choices[0].message.content or "",
        provider="openai",
        model=model,
        input_tokens=usage.prompt_tokens if usage else 0,
        output_tokens=usage.completion_tokens if usage else 0,
    )


def _gemini(system: str, user: str, max_tokens: int) -> LlmResult:
    """Gemini via the Generative Language REST API (httpx — no extra SDK dep)."""
    import httpx

    settings = get_settings()
    model = settings.gemini_model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    response = httpx.post(
        url,
        params={"key": settings.google_api_key},
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.9},
        },
        timeout=90,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Gemini API error {response.status_code}: {response.text[:300]}")

    body = response.json()
    candidates = body.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {response.text[:300]}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts)

    usage = body.get("usageMetadata") or {}
    return LlmResult(
        text=text,
        provider="google",
        model=model,
        input_tokens=usage.get("promptTokenCount", 0),
        output_tokens=usage.get("candidatesTokenCount", 0),
    )
