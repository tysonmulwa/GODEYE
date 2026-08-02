"""ffmpeg-based video assembly: scene clips → concat → burn subtitles → music.

Command builders are pure functions (unit-testable without ffmpeg installed);
only run() and probe_duration() touch the binary. ffmpeg is located via the
FFMPEG_PATH env var or the system PATH.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..config import get_settings

FPS = 30

# x264 was killed by the kernel one second into the first clip of a 1080x1920
# slideshow (-9, on a container that reported a perfectly healthy ffmpeg). It
# allocates frame buffers per thread plus a lookahead queue *before* encoding
# anything, and it sizes the thread count from the cores the host advertises
# rather than the share the container may use. On a small instance that is
# hundreds of megabytes reserved up front, and an instant SIGKILL.
#
# Both settings target that allocation rather than the encode itself:
#   threads  caps the per-thread buffers, which is the part that scales with
#            a machine we do not control
#   veryfast drops the lookahead from 40 frames to 10 and turns off b-frames
#
# The cost is a slightly larger file at the same CRF, which for a few seconds
# of stills is not visible. The alternative was a post published in silence.
ENCODE_THREADS = 2
ENCODE_PRESET = "veryfast"

INSTALL_HINT = (
    "ffmpeg not found — install it (Windows: `winget install Gyan.FFmpeg`, then restart "
    "the terminal) or set FFMPEG_PATH in .env to the ffmpeg executable"
)


@dataclass(frozen=True)
class VideoPreset:
    id: str
    width: int
    height: int


# Mirror of packages/shared/src/video-presets.ts
VIDEO_PRESETS: dict[str, VideoPreset] = {
    "VERTICAL": VideoPreset("VERTICAL", 1080, 1920),
    "SQUARE_VIDEO": VideoPreset("SQUARE_VIDEO", 1080, 1080),
    "LANDSCAPE": VideoPreset("LANDSCAPE", 1920, 1080),
}


def get_video_preset(preset_id: str) -> VideoPreset:
    return VIDEO_PRESETS.get(preset_id, VIDEO_PRESETS["VERTICAL"])


def locate_ffmpeg() -> str:
    settings = get_settings()
    if settings.ffmpeg_path:
        return settings.ffmpeg_path
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError(INSTALL_HINT)
    return found


def locate_ffprobe() -> str:
    settings = get_settings()
    if settings.ffmpeg_path:
        sibling = Path(settings.ffmpeg_path).with_name("ffprobe.exe")
        if sibling.exists():
            return str(sibling)
        sibling = Path(settings.ffmpeg_path).with_name("ffprobe")
        if sibling.exists():
            return str(sibling)
    found = shutil.which("ffprobe")
    if not found:
        raise RuntimeError(INSTALL_HINT.replace("ffmpeg", "ffprobe"))
    return found


# ---------- pure command builders ----------


# How far narration may be sped up or slowed to hit a requested length. Beyond
# roughly a tenth either way the change stops being a pace adjustment and starts
# being audible, so past this the honest answer is to return the length we got.
MAX_TEMPO_SHIFT = 0.12


def tempo_for_target(actual_sec: float, target_sec: float) -> float:
    """Playback rate that brings a narration of ``actual_sec`` toward the target.

    Returns 1.0 when no correction is possible or warranted. Above 1.0 speeds
    up (the script over-ran), below 1.0 slows down. Clamped, because a video
    that is a few seconds long is better than one that sounds like a chipmunk.
    """
    if actual_sec <= 0 or target_sec <= 0:
        return 1.0
    factor = actual_sec / target_sec
    return max(1.0 - MAX_TEMPO_SHIFT, min(1.0 + MAX_TEMPO_SHIFT, factor))


def scene_clip_cmd(
    image_path: str,
    audio_path: str,
    out_path: str,
    width: int,
    height: int,
    duration: float,
    tempo: float = 1.0,
) -> list[str]:
    """Still image + narration audio → motion clip (subtle Ken Burns zoom).

    ``tempo`` retimes the narration so the finished video lands on the length
    the user asked for. atempo preserves pitch, so a correction this small is
    heard as pace rather than as distortion. ``duration`` must already account
    for it, or the still would outlast the audio.
    """
    frames = max(1, int(round(duration * FPS)))
    zoom_filter = (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='min(zoom+0.0010,1.15)':d={frames}"
        f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":s={width}x{height}:fps={FPS}[v]"
    )
    # Only build an audio filter when there is something to correct, so the
    # untimed path stays byte-identical to what it was.
    filter_complex = zoom_filter
    audio_map = "1:a"
    if abs(tempo - 1.0) > 0.001:
        filter_complex = f"{zoom_filter};[1:a]atempo={tempo:.4f}[a]"
        audio_map = "[a]"
    return [
        "-y",
        "-loop", "1",
        "-i", image_path,
        "-i", audio_path,
        "-filter_complex", filter_complex,
        "-map", "[v]",
        "-map", audio_map,
        "-c:v", "libx264",
        "-preset", ENCODE_PRESET,
        "-threads", str(ENCODE_THREADS),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-ar", "44100",
        "-t", f"{duration:.3f}",
        "-r", str(FPS),
        out_path,
    ]


def still_clip_cmd(
    image_path: str, out_path: str, width: int, height: int, duration: float
) -> list[str]:
    """A still held for ``duration`` with a slow push in, and no audio.

    scene_clip_cmd needs a narration track per scene. A slideshow has one piece
    of music across the whole thing, so the clips are built silent and the audio
    is attached once at the end.
    """
    frames = max(1, int(round(duration * FPS)))
    return [
        "-y",
        "-loop", "1",
        "-i", image_path,
        "-filter_complex",
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='min(zoom+0.0008,1.12)':d={frames}"
        f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":s={width}x{height}:fps={FPS}[v]",
        "-map", "[v]",
        "-c:v", "libx264",
        "-preset", ENCODE_PRESET,
        "-threads", str(ENCODE_THREADS),
        "-pix_fmt", "yuv420p",
        "-t", f"{duration:.3f}",
        "-r", str(FPS),
        out_path,
    ]


def attach_music_cmd(video_in: str, music_path: str, out_path: str) -> list[str]:
    """Give a silent video a soundtrack, cut to the video's own length.

    Distinct from mix_music_cmd, which blends a bed under existing narration.
    There is nothing to blend with here, and amix against a stream that does not
    exist fails outright.
    """
    return [
        "-y",
        "-i", video_in,
        # -shortest ends on whichever stream runs out first, so a track shorter
        # than the video silently truncated the post instead of the music. Now
        # that the length is the user's choice, a 20 second track and a minute
        # of slides is an ordinary thing to ask for. Looping makes the audio
        # the one stream that cannot be the shorter of the two.
        "-stream_loop", "-1",
        "-i", music_path,
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        # An MP3's ID3 tags arrive as a bin_data stream and its title travels
        # with the file. Neither belongs in a post, and platforms are happier
        # with a plain video and audio pair.
        "-dn",
        "-map_metadata", "-1",
        # The track is almost always longer than the slideshow; end with the video.
        "-shortest",
        out_path,
    ]


def concat_list_content(clip_paths: list[str]) -> str:
    """concat-demuxer list file: forward slashes, quotes escaped."""
    lines = []
    for path in clip_paths:
        safe = path.replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{safe}'")
    return "\n".join(lines) + "\n"


def concat_cmd(list_file: str, out_path: str) -> list[str]:
    return ["-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", out_path]


def escape_filter_path(path: str) -> str:
    """Escape a path for use inside an ffmpeg filter argument (Windows-safe)."""
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def burn_subtitles_cmd(
    video_in: str, srt_path: str, out_path: str, height: int, font_size: int | None = None
) -> list[str]:
    size = font_size or max(12, height // 32)
    style = (
        f"FontSize={size},PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,"
        "Outline=2,Shadow=0,Bold=1,Alignment=2,MarginV=90"
    )
    vf = f"subtitles='{escape_filter_path(srt_path)}':force_style='{style}'"
    return [
        "-y",
        "-i", video_in,
        "-vf", vf,
        "-c:v", "libx264",
        # Burning subtitles re-encodes the whole video at full resolution, so
        # it carries the same allocation that got the slideshow killed.
        "-preset", ENCODE_PRESET,
        "-threads", str(ENCODE_THREADS),
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        out_path,
    ]


def mix_music_cmd(video_in: str, music_path: str, out_path: str, volume: float = 0.15) -> list[str]:
    return [
        "-y",
        "-i", video_in,
        "-i", music_path,
        "-filter_complex",
        f"[1:a]volume={volume}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]",
        "-map", "0:v",
        "-map", "[a]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "160k",
        out_path,
    ]


# ---------- runners ----------


def run(args: list[str]) -> None:
    cmd = [locate_ffmpeg(), *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else "no stderr"
        raise RuntimeError(f"ffmpeg failed ({result.returncode}): {tail}")


def probe_duration(path: str) -> float:
    cmd = [
        locate_ffprobe(),
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[-300:]}")
    return float(result.stdout.strip())
