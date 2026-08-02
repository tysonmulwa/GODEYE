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


class TestEncodeFitsASmallContainer:
    """x264 was SIGKILLed one second into the first clip on the deployed
    worker. It reserves frame buffers per thread plus a lookahead queue before
    encoding anything, sized from the host's core count rather than the
    container's share — so the encode has to bound that explicitly."""

    def _commands(self):
        return [
            video.still_clip_cmd("i.jpg", "o.mp4", 1080, 1920, 5.0),
            video.scene_clip_cmd("i.jpg", "a.mp3", "o.mp4", 1080, 1920, 5.0),
            video.burn_subtitles_cmd("i.mp4", "s.srt", "o.mp4", 1920),
        ]

    def test_every_encode_caps_its_thread_count(self):
        for cmd in self._commands():
            assert "-threads" in cmd, f"unbounded thread count in {cmd[:6]}"
            assert int(cmd[cmd.index("-threads") + 1]) <= 4

    def test_no_encode_uses_a_preset_with_a_deep_lookahead(self):
        """medium keeps 40 frames of 1080x1920 in flight before it starts."""
        for cmd in self._commands():
            preset = cmd[cmd.index("-preset") + 1]
            assert preset in {"ultrafast", "superfast", "veryfast", "faster"}, (
                f"{preset} reserves too much up front for a small container"
            )


class TestRenderSelfTest:
    """Proving the worker can encode, by making it encode. The whole value is
    in what it reports when the render fails, so it must never raise."""

    def test_a_failed_render_is_reported_not_raised(self, monkeypatch):
        from godeye_engine.media import selftest

        monkeypatch.setattr(selftest, "_test_audio", lambda *a, **kw: b"mp3")
        monkeypatch.setattr(
            selftest.slideshow, "build_slideshow",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("ffmpeg failed (137): Killed")),
        )
        result = selftest.render_selftest()
        assert result["ok"] is False
        assert result["stage"] == "render"
        # 137 is a kernel OOM kill, and that is the difference between a
        # container that can render and one that cannot.
        assert "137" in result["error"]

    def test_missing_ffmpeg_is_reported_against_the_input_stage(self, monkeypatch):
        from godeye_engine.media import selftest

        monkeypatch.setattr(
            selftest.video, "locate_ffmpeg",
            lambda: (_ for _ in ()).throw(RuntimeError("ffmpeg not found")),
        )
        result = selftest.render_selftest()
        assert result["ok"] is False
        assert "ffmpeg not found" in result["error"]

    def test_a_video_without_audio_is_not_a_pass(self, monkeypatch):
        """The symptom being chased is a post that publishes with no sound, so
        a render that produces a silent file has reproduced the bug, not
        disproved it."""
        from godeye_engine.media import selftest

        monkeypatch.setattr(selftest, "_test_audio", lambda *a, **kw: b"mp3")
        monkeypatch.setattr(selftest, "_test_image", lambda *a, **kw: b"jpg")
        monkeypatch.setattr(selftest.slideshow, "build_slideshow", lambda *a, **kw: b"MP4")
        monkeypatch.setattr(selftest.video, "probe_duration", lambda p: 6.4)
        monkeypatch.setattr(selftest.video, "locate_ffprobe", lambda: "ffprobe")
        monkeypatch.setattr(
            selftest.subprocess, "run",
            lambda *a, **kw: type("R", (), {"stdout": "h264,video", "returncode": 0})(),
        )
        assert selftest.render_selftest()["ok"] is False
