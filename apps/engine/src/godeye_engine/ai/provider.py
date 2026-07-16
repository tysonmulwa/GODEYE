"""Provider-agnostic LLM access: Anthropic primary, OpenAI fallback."""

from __future__ import annotations

from dataclasses import dataclass

from ..config import get_settings

# USD per million tokens (input, output) — used for AgentRun cost accounting.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet-5": (3.0, 15.0),
    "claude-opus-4-8": (15.0, 75.0),
    "claude-haiku-4-5": (0.80, 4.0),
    "gpt-4o-mini": (0.15, 0.60),
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
    raise RuntimeError(
        "No AI provider configured — set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env"
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
