"""ffmpeg command builders (pure — no ffmpeg binary needed)."""

import pytest

from godeye_engine.config import get_settings
from godeye_engine.media import video


class TestPresets:
    def test_vertical_default(self):
        preset = video.get_video_preset("VERTICAL")
        assert (preset.width, preset.height) == (1080, 1920)

    def test_unknown_falls_back_to_vertical(self):
        assert video.get_video_preset("NOPE").id == "VERTICAL"


class TestSceneClipCmd:
    def test_contains_size_duration_and_kenburns(self):
        cmd = video.scene_clip_cmd("img.png", "audio.mp3", "out.mp4", 1080, 1920, 4.5)
        joined = " ".join(cmd)
        assert "zoompan" in joined
        assert "s=1080x1920" in joined
        assert "-t 4.500" in joined
        assert cmd[-1] == "out.mp4"
        assert "-pix_fmt" in cmd  # broad player compatibility

    def test_frame_count_matches_duration(self):
        cmd = video.scene_clip_cmd("i.png", "a.mp3", "o.mp4", 1080, 1080, 2.0)
        assert f"d={2 * video.FPS}" in " ".join(cmd)


class TestConcat:
    def test_list_content_uses_forward_slashes(self):
        content = video.concat_list_content([r"C:\tmp\clip0.mp4", r"C:\tmp\clip1.mp4"])
        assert "file 'C:/tmp/clip0.mp4'" in content
        assert "\\" not in content

    def test_concat_cmd_uses_copy(self):
        cmd = video.concat_cmd("list.txt", "joined.mp4")
        assert "-f" in cmd and "concat" in cmd
        assert "copy" in cmd


class TestSubtitlesCmd:
    def test_windows_path_escaped_in_filter(self):
        cmd = video.burn_subtitles_cmd("in.mp4", r"C:\tmp\cap.srt", "out.mp4", 1920)
        vf = cmd[cmd.index("-vf") + 1]
        assert "C\\:/tmp/cap.srt" in vf
        assert "force_style=" in vf

    def test_font_scales_with_height(self):
        vf_small = video.burn_subtitles_cmd("i.mp4", "c.srt", "o.mp4", 1080)
        vf_large = video.burn_subtitles_cmd("i.mp4", "c.srt", "o.mp4", 1920)
        assert "FontSize=33" in " ".join(vf_small)  # 1080 // 32
        assert "FontSize=60" in " ".join(vf_large)  # 1920 // 32


class TestMusicCmd:
    def test_music_mixed_at_low_volume(self):
        cmd = video.mix_music_cmd("v.mp4", "m.mp3", "o.mp4", volume=0.2)
        joined = " ".join(cmd)
        assert "volume=0.2" in joined
        assert "amix=inputs=2" in joined


class TestLocateFfmpeg:
    def test_env_override_wins(self, monkeypatch):
        monkeypatch.setenv("FFMPEG_PATH", r"C:\tools\ffmpeg.exe")
        get_settings.cache_clear()
        assert video.locate_ffmpeg() == r"C:\tools\ffmpeg.exe"
        get_settings.cache_clear()

    def test_missing_binary_raises_with_hint(self, monkeypatch):
        monkeypatch.setenv("FFMPEG_PATH", "")
        get_settings.cache_clear()
        monkeypatch.setattr(video.shutil, "which", lambda name: None)
        with pytest.raises(RuntimeError, match="winget install"):
            video.locate_ffmpeg()
        get_settings.cache_clear()
