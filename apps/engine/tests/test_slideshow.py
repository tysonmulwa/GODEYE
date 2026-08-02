"""Slideshow assembly, without needing ffmpeg on the machine running the tests.

video.run is the only thing that touches the binary, so faking it leaves the
real assembly logic — clip count, durations, whether music is attached — under
test while the command builders are verified separately in test_video_ffmpeg.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from godeye_engine.media import slideshow, video

# TikTok rejects video shorter than this outright.
TIKTOK_MIN_SEC = 3.0


@pytest.fixture
def calls(monkeypatch):
    """Record every ffmpeg invocation and satisfy the output file it promised."""
    recorded: list[list[str]] = []

    def fake_run(args: list[str]) -> None:
        recorded.append(args)
        Path(args[-1]).write_bytes(b"FAKEMP4")

    monkeypatch.setattr(video, "locate_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(video, "run", fake_run)
    return recorded


def _durations(calls: list[list[str]]) -> list[float]:
    return [float(a[a.index("-t") + 1]) for a in calls if "-t" in a]


def test_a_single_image_clears_tiktoks_minimum_with_room(calls):
    """Autopilot attaches one image per post, so this is the common path. It
    once produced 3.2s against a 3.0s limit — a margin thinner than the
    encoder's own accuracy."""
    slideshow.build_slideshow([b"img"], music=b"mp3")
    held = _durations(calls)[0]
    assert held >= TIKTOK_MIN_SEC + 1.0, f"only {held}s, too close to the {TIKTOK_MIN_SEC}s limit"


def test_several_images_each_get_the_normal_hold(calls):
    slideshow.build_slideshow([b"a", b"b", b"c"], music=b"mp3")
    assert _durations(calls) == [slideshow.SECONDS_PER_IMAGE] * 3


def test_music_is_attached_as_a_final_pass(calls):
    slideshow.build_slideshow([b"a", b"b"], music=b"mp3")
    assert any("-shortest" in args for args in calls), "the track was never attached"


def test_without_music_it_is_still_a_video(calls):
    """Silent, but video — TikTok uploads video by file and photos only by URL
    from a verified domain, so the caller may still prefer this."""
    assert slideshow.build_slideshow([b"a"], music=None) == b"FAKEMP4"
    assert not any("-shortest" in args for args in calls)


def test_one_image_skips_the_concat_pass(calls):
    slideshow.build_slideshow([b"only"], music=None)
    assert not any("concat" in args for args in calls)


def test_no_images_is_rejected_before_touching_ffmpeg(calls):
    with pytest.raises(ValueError):
        slideshow.build_slideshow([], music=b"mp3")
    assert calls == []
