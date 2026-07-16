"""Provider-agnostic image generation: OpenAI gpt-image-1 or Google Imagen.

Anthropic does not generate images, so this uses OPENAI_API_KEY (default) or
GOOGLE_API_KEY. Raises a clear error when neither is configured.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from ..config import get_settings

# USD per generated image (approximate, standard quality) for cost accounting.
IMAGE_PRICES: dict[str, float] = {
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
        return IMAGE_PRICES.get(self.model, DEFAULT_IMAGE_PRICE)


def generate_image(prompt: str, provider_size: str) -> ImageResult:
    """Generate a single image. provider_size is a size the API supports."""
    settings = get_settings()
    provider = settings.image_provider.lower()

    if provider == "openai" or (provider != "google" and settings.openai_api_key):
        if not settings.openai_api_key:
            raise RuntimeError("IMAGE_PROVIDER=openai but OPENAI_API_KEY is not set")
        return _openai(prompt, provider_size)
    if provider == "google":
        if not settings.google_api_key:
            raise RuntimeError("IMAGE_PROVIDER=google but GOOGLE_API_KEY is not set")
        return _google(prompt, provider_size)

    raise RuntimeError(
        "No image provider configured — set OPENAI_API_KEY (or GOOGLE_API_KEY with "
        "IMAGE_PROVIDER=google) in .env to enable image generation"
    )


def _openai(prompt: str, provider_size: str) -> ImageResult:
    from openai import OpenAI

    settings = get_settings()
    client = OpenAI(api_key=settings.openai_api_key)
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
