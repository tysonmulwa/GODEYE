"""ffmpeg command builders (pure, no ffmpeg binary needed)."""

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


class TestDurationTargeting:
    """duration_sec used to be a suggestion to the script writer. Whatever length
    the narration ran to was the length the user got, however far off it was."""

    def test_an_overrunning_script_is_sped_up(self):
        assert video.tempo_for_target(actual_sec=33.0, target_sec=30.0) == pytest.approx(1.1)

    def test_a_short_script_is_slowed_down(self):
        assert video.tempo_for_target(actual_sec=27.0, target_sec=30.0) == pytest.approx(0.9)

    def test_a_script_already_on_target_is_left_alone(self):
        assert video.tempo_for_target(30.0, 30.0) == 1.0

    def test_correction_is_capped_so_speech_stays_natural(self):
        """A script at double the target cannot be fixed by playback rate. Better
        a video that runs long than one nobody can listen to."""
        assert video.tempo_for_target(60.0, 30.0) == pytest.approx(1 + video.MAX_TEMPO_SHIFT)
        assert video.tempo_for_target(5.0, 30.0) == pytest.approx(1 - video.MAX_TEMPO_SHIFT)

    def test_nonsense_inputs_do_not_retime(self):
        assert video.tempo_for_target(0.0, 30.0) == 1.0
        assert video.tempo_for_target(30.0, 0.0) == 1.0

    def test_no_audio_filter_when_no_correction_is_needed(self):
        """The untimed path must stay exactly as it was."""
        cmd = video.scene_clip_cmd("i.png", "a.mp3", "o.mp4", 1080, 1920, 4.0, tempo=1.0)
        assert "atempo" not in " ".join(cmd)
        assert "1:a" in cmd

    def test_atempo_is_applied_and_mapped_when_retiming(self):
        cmd = video.scene_clip_cmd("i.png", "a.mp3", "o.mp4", 1080, 1920, 4.0, tempo=1.08)
        joined = " ".join(cmd)
        assert "atempo=1.0800" in joined
        assert "[a]" in cmd, "retimed audio must be the stream that gets mapped"
        assert "1:a" not in cmd, "the raw audio must not be mapped as well"
