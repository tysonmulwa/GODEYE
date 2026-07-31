"""Provider-agnostic image generation: an OpenAI gpt-image-* model or Google Imagen.

Anthropic does not generate images, so this uses OPENAI_API_KEY (default) or
GOOGLE_API_KEY. Raises a clear error when neither is configured.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from ..config import get_settings

# USD per generated image (approximate, medium quality, 1024x1024) for cost
# accounting only — this doesn't gate billing, it's the number that shows up in
# AgentRun.costUsd and the images_generated UsageRecord. Actual cost varies with
# quality tier and size, neither of which this app currently requests explicitly
# (OpenAI defaults apply). Recheck against OpenAI's own pricing page if this
# figure needs to be precise rather than directional.
IMAGE_PRICES: dict[str, float] = {
    "gpt-image-2": 0.03,
    "gpt-image-1.5": 0.04,
    "gpt-image-1-mini": 0.005,
    "gpt-image-1": 0.04,
    "dall-e-3": 0.04,
    "imagen-3.0-generate-002": 0.03,
}
DEFAULT_IMAGE_PRICE = 0.04


@dataclass
class ImageResult:
    data: bytes
    provider: str
    model: str
    provider_size: str

    @property
    def cost_usd(self) -> float:
        return price_for(self.model)


def price_for(model: str) -> float:
    """Price a model name, tolerating OpenAI's dated snapshots.

    Pinning a snapshot ("gpt-image-2-2026-04-21") is normal practice, and it
    would otherwise miss the table and silently bill at the default — which is
    the kind of wrong number nobody notices until margins look odd. Longest
    prefix wins so "gpt-image-1-mini" isn't matched by "gpt-image-1".
    """
    if model in IMAGE_PRICES:
        return IMAGE_PRICES[model]
    matches = [name for name in IMAGE_PRICES if model.startswith(name)]
    if matches:
        return IMAGE_PRICES[max(matches, key=len)]
    return DEFAULT_IMAGE_PRICE


def _missing_key_message(var: str, provider: str) -> str:
    """Say where the variable is missing, not just that it is.

    Image generation runs inside the Celery worker, which is deployed as its own
    service and does not inherit the engine API's environment. Setting the key on
    one service and seeing this from the other is the normal way to hit this, and
    "not set" alone sends people to re-check the place they already set it.
    """
    return (
        f"IMAGE_PROVIDER={provider} but {var} is empty in this process. "
        f"Image generation runs in the Celery worker, which is a separate "
        f"deployment from the engine API and does not share its variables: set "
        f"{var} on the worker service as well, then redeploy it so the process "
        f"restarts and picks the value up."
    )


def generate_image(prompt: str, provider_size: str) -> ImageResult:
    """Generate a single image. provider_size is a size the API supports."""
    settings = get_settings()
    provider = settings.image_provider.lower()

    if provider == "openai" or (provider != "google" and settings.openai_api_key):
        if not settings.openai_api_key:
            raise RuntimeError(_missing_key_message("OPENAI_API_KEY", "openai"))
        return _openai(prompt, provider_size)
    if provider == "google":
        if not settings.google_api_key:
            raise RuntimeError(_missing_key_message("GOOGLE_API_KEY", "google"))
        return _google(prompt, provider_size)

    raise RuntimeError(
        "No image provider configured — set OPENAI_API_KEY (or GOOGLE_API_KEY with "
        "IMAGE_PROVIDER=google) in .env to enable image generation"
    )


def _openai(prompt: str, provider_size: str) -> ImageResult:
    from openai import OpenAI

    settings = get_settings()
    # Bound the call explicitly. Left to the SDK defaults (600s, 2 retries) a
    # single stuck request occupies a worker slot for half an hour, and the
    # symptom is a spinner rather than an error, which tells nobody anything.
    client = OpenAI(
        api_key=settings.openai_api_key,
        timeout=settings.image_timeout_sec,
        max_retries=1,
    )
    response = client.images.generate(
        model=settings.openai_image_model,
        prompt=prompt,
        size=provider_size,
        n=1,
    )
    b64 = response.data[0].b64_json
    if not b64:
        raise RuntimeError("OpenAI returned no image data")
    return ImageResult(
        data=base64.b64decode(b64),
        provider="openai",
        model=settings.openai_image_model,
        provider_size=provider_size,
    )


def _google(prompt: str, provider_size: str) -> ImageResult:
    from google import genai

    settings = get_settings()
    client = genai.Client(api_key=settings.google_api_key)
    # Imagen takes an aspect ratio rather than an explicit pixel size.
    aspect = {
        "1024x1024": "1:1",
        "1536x1024": "16:9",
        "1024x1536": "9:16",
    }.get(provider_size, "1:1")
    response = client.models.generate_images(
        model=settings.google_image_model,
        prompt=prompt,
        config={"number_of_images": 1, "aspect_ratio": aspect},
    )
    image = response.generated_images[0].image
    return ImageResult(
        data=image.image_bytes,
        provider="google",
        model=settings.google_image_model,
        provider_size=provider_size,
    )
