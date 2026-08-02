"""Render a throwaway slideshow to prove the worker can actually do it.

Publishing exercises this path, but only ever reports success: when the render
fails the publisher falls back to a silent photo carousel and the post still
goes out. Reproducing it meant asking someone to publish again and read a
container log.

This runs the same encode — same resolution, same codec, same filters — on
inputs it makes itself, so it needs no workspace data and no credentials, and
it can be triggered on demand. It answers one question: can this container do
the work, or is the environment the reason posts arrive silent.
"""

from __future__ import annotations

import io
import subprocess
import tempfile
import time
from pathlib import Path

from . import slideshow, video


def _test_image(seed: int, width: int = 1280, height: int = 1280) -> bytes:
    """A JPEG that costs about what a photograph costs to encode.

    Flat colour compresses to nothing and would let a container that cannot
    handle a real image still pass. Per-pixel noise is the opposite mistake —
    it is far harder to encode than any photo, so a slow machine fails the test
    while handling real posts fine.

    Drawing small and scaling up gives smooth gradients with genuine detail,
    and skips a million-iteration Python loop that dominated the runtime.
    """
    from PIL import Image

    small = Image.new("RGB", (32, 32))
    pixels = small.load()
    for y in range(32):
        for x in range(32):
            pixels[x, y] = (
                (x * 8 + seed * 40) % 256,
                (y * 8 + seed * 90) % 256,
                ((x + y) * 4 + seed * 140) % 256,
            )
    buffer = io.BytesIO()
    small.resize((width, height), Image.BICUBIC).save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()


def _test_audio(seconds: float = 8.0) -> bytes:
    """A short tone, encoded by the same ffmpeg that will mux it."""
    ffmpeg = video.locate_ffmpeg()
    with tempfile.TemporaryDirectory(prefix="godeye-selftest-") as tmp:
        out = Path(tmp) / "tone.mp3"
        subprocess.run(
            [ffmpeg, "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
             "-c:a", "libmp3lame", "-b:a", "128k", str(out)],
            capture_output=True, check=True, timeout=120,
        )
        return out.read_bytes()


def render_selftest() -> dict:
    """Build a two-image slideshow with audio and report what happened.

    Never raises: the failure is the answer.
    """
    started = time.monotonic()
    try:
        images = [_test_image(1), _test_image(2)]
        audio = _test_audio()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "stage": "inputs", "error": f"{type(e).__name__}: {e}"}

    try:
        mp4 = slideshow.build_slideshow(images, audio)
    except Exception as e:  # noqa: BLE001
        # An ffmpeg killed by the kernel for memory exits 137, and that is the
        # difference between a machine that can render and one that cannot.
        return {
            "ok": False,
            "stage": "render",
            "error": f"{type(e).__name__}: {e}"[:400],
            "seconds": round(time.monotonic() - started, 1),
        }

    result = {"ok": True, "bytes": len(mp4), "seconds": round(time.monotonic() - started, 1)}
    try:
        with tempfile.TemporaryDirectory(prefix="godeye-selftest-") as tmp:
            path = Path(tmp) / "out.mp4"
            path.write_bytes(mp4)
            result["duration"] = round(video.probe_duration(str(path)), 2)
            streams = subprocess.run(
                [video.locate_ffprobe(), "-v", "error", "-show_entries",
                 "stream=codec_type,codec_name", "-of", "csv=p=0", str(path)],
                capture_output=True, text=True, timeout=60,
            ).stdout.split()
            result["streams"] = ",".join(streams)
            # A video with no audio stream is exactly the symptom being chased,
            # so a render that "succeeds" without one is not a success.
            result["ok"] = any("audio" in s for s in streams)
    except Exception as e:  # noqa: BLE001
        result["probe"] = f"{type(e).__name__}: {e}"
    return result
