"""Turn a set of images into a short video with a soundtrack.

TikTok's own editor does this: pick photos, it makes a slideshow and puts music
under it. Through the API that editor does not exist, so a photo post published
directly is silent, and the only way to reach TikTok's music library is to have
a person open the app and finish the post by hand. For an automation product
that is not a trade worth making.

So GODEYE builds the slideshow itself. The result is a normal video with the
workspace's own licensed track already in it, which publishes with no human
involved and arrives with sound.

It also sidesteps a separate problem. Photo posts are PULL_FROM_URL only, and
the URL must sit under a domain verified on the TikTok app; video uses
FILE_UPLOAD and needs no verification at all.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from . import video

logger = logging.getLogger(__name__)

# Long enough to read an image, short enough to hold attention. Four images at
# this length lands around 13s, which is comfortably inside every network's
# limits and about where short-form engagement holds up.
SECONDS_PER_IMAGE = 3.2
# A single image is the common case, not the edge one — autopilot attaches one
# image per post — so this floor decides most posts. TikTok rejects anything
# under 3s, and 3.2 left a fifth of a second of margin against an encoder that
# does not land exactly on the requested length. It also reads as a glitch
# rather than a post. Five seconds is a slide, and it is a safe distance from
# the limit.
MIN_TOTAL_SEC = 5.0

# Lengths offered to the user. Short-form on every network comfortably accepts
# all three, and they are the lengths people actually think in.
ALLOWED_LENGTHS = (30, 45, 60)
DEFAULT_LENGTH_SEC = 30

# Filling a minute from two photos means showing them more than once. About
# four seconds is long enough to look deliberate and short enough to keep
# moving, but the slide count is capped as well: every slide is its own encode,
# and a worker that has already been killed once for memory should not be asked
# to run twenty of them for a single post.
TARGET_HOLD_SEC = 4.0
MAX_SLIDES = 12


def normalise_length(seconds: int | None) -> int:
    """Nearest offered length. Anything unrecognised becomes the default."""
    if not seconds:
        return DEFAULT_LENGTH_SEC
    return min(ALLOWED_LENGTHS, key=lambda choice: abs(choice - seconds))


def plan_slides(image_count: int, target_sec: float) -> tuple[int, float]:
    """How many slides to show, and how long each is held.

    Returns (slides, seconds_each) whose product is exactly ``target_sec``, so
    the finished video lands on the length that was asked for rather than near
    it. Images repeat in order when there are fewer of them than slides.
    """
    if image_count < 1:
        raise ValueError("A slideshow needs at least one image")
    wanted = round(target_sec / TARGET_HOLD_SEC)
    # Never drop an image the user attached, and never exceed the encode cap.
    slides = max(1, min(MAX_SLIDES, max(wanted, min(image_count, MAX_SLIDES))))
    return slides, target_sec / slides


def build_slideshow(
    images: list[bytes],
    music: bytes | None,
    width: int = 1080,
    height: int = 1920,
    seconds_each: float = SECONDS_PER_IMAGE,
    target_sec: float | None = None,
) -> bytes:
    """Render images into an mp4, with ``music`` underneath when given.

    ``target_sec`` sets the finished length; images repeat in order to fill it.
    Without it each image is held once, which is what a post looks like when
    nobody has chosen a length.

    Raises RuntimeError if ffmpeg is missing or fails, so the caller can fall
    back to whatever it would have done otherwise rather than lose the post.
    """
    if not images:
        raise ValueError("A slideshow needs at least one image")

    video.locate_ffmpeg()  # fail before spending time on temp files
    if target_sec:
        slides, per_image = plan_slides(len(images), target_sec)
        sequence = [images[index % len(images)] for index in range(slides)]
    else:
        # One image would still be shorter than TikTok accepts, so hold it longer.
        sequence = images
        per_image = max(seconds_each, MIN_TOTAL_SEC if len(images) == 1 else 0.0)

    with tempfile.TemporaryDirectory(prefix="godeye-slideshow-") as tmp:
        tmpdir = Path(tmp)
        clips: list[str] = []
        # Identical repeats are encoded once and reused: filling a minute from
        # two photos is otherwise a dozen encodes of the same few frames.
        encoded: dict[int, str] = {}
        for index, data in enumerate(sequence):
            source_index = index % len(images) if target_sec else index
            if source_index in encoded:
                clips.append(encoded[source_index])
                continue
            source = tmpdir / f"img{source_index}.jpg"
            source.write_bytes(data)
            clip = tmpdir / f"clip{source_index}.mp4"
            video.run(
                video.still_clip_cmd(str(source), str(clip), width, height, per_image)
            )
            encoded[source_index] = str(clip)
            clips.append(str(clip))

        joined = tmpdir / "joined.mp4"
        if len(clips) == 1:
            joined.write_bytes(Path(clips[0]).read_bytes())
        else:
            listing = tmpdir / "concat.txt"
            listing.write_text(video.concat_list_content(clips), encoding="utf-8")
            video.run(video.concat_cmd(str(listing), str(joined)))

        if not music:
            # Silent, but still a video: the caller decides whether that beats a
            # photo post, and for TikTok it does because of FILE_UPLOAD.
            return joined.read_bytes()

        music_path = tmpdir / "music.mp3"
        music_path.write_bytes(music)
        with_audio = tmpdir / "final.mp4"
        video.run(video.attach_music_cmd(str(joined), str(music_path), str(with_audio)))
        return with_audio.read_bytes()
