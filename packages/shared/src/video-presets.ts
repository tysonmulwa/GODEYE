/** Video presets + voice options. Mirrored in apps/engine/media/video.py. */

export interface VideoPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  aspect: string;
  platforms: string[];
}

export const VIDEO_PRESETS: Record<string, VideoPreset> = {
  VERTICAL: {
    id: "VERTICAL",
    label: "Vertical 9:16 (TikTok / Reels / Shorts)",
    width: 1080,
    height: 1920,
    aspect: "9:16",
    platforms: ["TIKTOK", "INSTAGRAM", "FACEBOOK", "YOUTUBE", "SNAPCHAT", "PINTEREST"],
  },
  SQUARE_VIDEO: {
    id: "SQUARE_VIDEO",
    label: "Square 1:1 (feed video)",
    width: 1080,
    height: 1080,
    aspect: "1:1",
    platforms: ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "X"],
  },
  LANDSCAPE: {
    id: "LANDSCAPE",
    label: "Landscape 16:9 (YouTube / X)",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    platforms: ["YOUTUBE", "X", "LINKEDIN"],
  },
};

export const VIDEO_PRESET_IDS = Object.keys(VIDEO_PRESETS);

/** OpenAI TTS voices offered in the UI. */
export const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export const VIDEO_DURATIONS = [15, 30, 45, 60] as const;
