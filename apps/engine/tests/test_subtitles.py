"""SRT subtitle builder."""

from godeye_engine.media import subtitles


class TestFormatTimestamp:
    def test_zero(self):
        assert subtitles.format_timestamp(0) == "00:00:00,000"

    def test_fractional_and_minutes(self):
        assert subtitles.format_timestamp(65.25) == "00:01:05,250"

    def test_hours(self):
        assert subtitles.format_timestamp(3723.5) == "01:02:03,500"

    def test_negative_clamped(self):
        assert subtitles.format_timestamp(-1) == "00:00:00,000"


class TestSplitNarration:
    def test_short_text_single_cue(self):
        assert subtitles.split_narration("Hello world") == ["Hello world"]

    def test_splits_on_word_boundaries(self):
        text = "the quick brown fox jumps over the lazy dog again and again"
        cues = subtitles.split_narration(text, max_chars=20)
        assert all(len(c) <= 20 for c in cues)
        assert " ".join(cues) == text


class TestBuildSrt:
    def test_basic_structure(self):
        srt = subtitles.build_srt([("Hello world", 2.0), ("Second scene here", 3.0)])
        blocks = [b for b in srt.strip().split("\n\n") if b]
        assert len(blocks) == 2
        assert blocks[0].startswith("1\n00:00:00,000 --> 00:00:02,000\nHello world")
        # second scene starts where the first ended
        assert "00:00:02,000 -->" in blocks[1]

    def test_long_narration_produces_multiple_cues_within_scene(self):
        narration = "word " * 40  # far beyond one cue
        srt = subtitles.build_srt([(narration.strip(), 10.0)])
        blocks = [b for b in srt.strip().split("\n\n") if b]
        assert len(blocks) > 1
        # last cue must not exceed the scene duration
        last_end = blocks[-1].split("\n")[1].split(" --> ")[1]
        assert last_end <= "00:00:10,000"

    def test_empty_scenes_produce_empty_srt(self):
        assert subtitles.build_srt([]) == ""

    def test_sequential_numbering(self):
        srt = subtitles.build_srt([("one two three", 1.0), ("four five six", 1.0)])
        numbers = [b.split("\n")[0] for b in srt.strip().split("\n\n")]
        assert numbers == ["1", "2"]
