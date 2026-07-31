"""Image post-processing with Pillow: resize/crop to preset, brand overlay."""

from __future__ import annotations

import io

from PIL import Image, ImageDraw

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


# A round badge in the corner, sized to be noticed and not to intrude. The
# previous treatment put the logo at a sixth of the image width and ran a
# full-width colour bar along the bottom, which on a photograph reads as a
# banner slapped over someone's face rather than as branding.
BADGE_WIDTH_RATIO = 10
BADGE_MARGIN_RATIO = 30
BADGE_MIN_PX = 56


def apply_brand(
    image_bytes: bytes,
    logo_bytes: bytes | None,
    accent_hex: str | None = None,
) -> bytes:
    """Composite a small round brand badge into the bottom-right corner."""
    base = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    if not logo_bytes and not accent_hex:
        return _to_png(base.convert("RGB"))

    diameter = max(BADGE_MIN_PX, base.width // BADGE_WIDTH_RATIO)
    diameter = min(diameter, base.width // 2, base.height // 2)
    margin = max(8, base.width // BADGE_MARGIN_RATIO)

    badge = _round_badge(diameter, logo_bytes, accent_hex)
    base.alpha_composite(
        badge, (base.width - diameter - margin, base.height - diameter - margin)
    )
    return _to_png(base.convert("RGB"))


def _round_badge(
    diameter: int, logo_bytes: bytes | None, accent_hex: str | None
) -> Image.Image:
    """A circular badge: soft backing, accent ring, logo centred and clipped.

    The backing exists so a logo stays legible over whatever the photograph put
    behind it, which for a generated image is not knowable in advance.
    """
    badge = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    draw = ImageDraw.Draw(badge)

    draw.ellipse((0, 0, diameter - 1, diameter - 1), fill=(255, 255, 255, 225))
    if accent_hex:
        ring = max(2, diameter // 22)
        draw.ellipse(
            (0, 0, diameter - 1, diameter - 1),
            outline=_hex_to_rgba(accent_hex, alpha=255),
            width=ring,
        )

    if logo_bytes:
        # Inset so the logo sits inside the ring rather than touching it.
        inner = int(diameter * 0.62)
        logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
        logo.thumbnail((inner, inner), Image.LANCZOS)
        badge.alpha_composite(
            logo, ((diameter - logo.width) // 2, (diameter - logo.height) // 2)
        )

    # Clip anything that strayed outside the circle, including a square logo's
    # own background if it shipped with one.
    mask = Image.new("L", (diameter, diameter), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, diameter - 1, diameter - 1), fill=255)
    badge.putalpha(Image.composite(badge.getchannel("A"), mask, mask))
    return badge


def _to_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# Quality 90 is visually indistinguishable from the source at these sizes and
# cuts a 1080x1080 frame from roughly 1.6 MB to a few hundred kB.
JPEG_QUALITY = 90


def to_jpeg(image_bytes: bytes, quality: int = JPEG_QUALITY) -> bytes:
    """Re-encode a finished frame as JPEG.

    TikTok's photo endpoint rejects PNG outright with file_format_check_failed,
    and every other network we publish to takes JPEG happily, so this is the
    format to leave the building in. Applied once at the end: the intermediate
    steps stay PNG so cropping and compositing are not re-compressed each time.

    Nothing is lost to the missing alpha channel, because the brand overlay
    already flattens to RGB before this point.
    """
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def _hex_to_rgba(hex_color: str, alpha: int = 235) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)
