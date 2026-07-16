"""Image post-processing with Pillow: resize/crop to preset, brand overlay."""

from __future__ import annotations

import io

from PIL import Image

from .presets import Preset


def fit_to_preset(image_bytes: bytes, preset: Preset) -> bytes:
    """Center-crop + resize an image to exactly the preset dimensions (cover)."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    target_ratio = preset.width / preset.height
    src_ratio = img.width / img.height

    if src_ratio > target_ratio:
        # source too wide -> crop width
        new_width = int(img.height * target_ratio)
        left = (img.width - new_width) // 2
        img = img.crop((left, 0, left + new_width, img.height))
    else:
        # source too tall -> crop height
        new_height = int(img.width / target_ratio)
        top = (img.height - new_height) // 2
        img = img.crop((0, top, img.width, top + new_height))

    img = img.resize((preset.width, preset.height), Image.LANCZOS)
    return _to_png(img)


def apply_brand(
    image_bytes: bytes,
    logo_bytes: bytes | None,
    accent_hex: str | None = None,
) -> bytes:
    """Composite a logo watermark (bottom-right) and an accent bar on the image."""
    base = Image.open(io.BytesIO(image_bytes)).convert("RGBA")

    if accent_hex:
        bar_height = max(6, base.height // 90)
        accent = Image.new("RGBA", (base.width, bar_height), _hex_to_rgba(accent_hex))
        base.alpha_composite(accent, (0, base.height - bar_height))

    if logo_bytes:
        logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
        target_w = max(48, base.width // 6)
        scale = target_w / logo.width
        logo = logo.resize((target_w, int(logo.height * scale)), Image.LANCZOS)
        margin = base.width // 40
        pos = (base.width - logo.width - margin, base.height - logo.height - margin * 2)
        base.alpha_composite(logo, pos)

    return _to_png(base.convert("RGB"))


def _to_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _hex_to_rgba(hex_color: str, alpha: int = 235) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)
