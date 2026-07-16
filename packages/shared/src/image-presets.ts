/** Per-platform image size presets. Mirrored in apps/engine/media/presets.py. */

export interface ImagePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  aspect: string;
}

export const IMAGE_PRESETS: Record<string, ImagePreset> = {
  SQUARE: { id: "SQUARE", label: "Square (feed)", width: 1080, height: 1080, aspect: "1:1" },
  INSTAGRAM_FEED: { id: "INSTAGRAM_FEED", label: "Instagram feed", width: 1080, height: 1080, aspect: "1:1" },
  INSTAGRAM_PORTRAIT: { id: "INSTAGRAM_PORTRAIT", label: "Instagram portrait", width: 1080, height: 1350, aspect: "4:5" },
  STORY: { id: "STORY", label: "Story / Reel (9:16)", width: 1080, height: 1920, aspect: "9:16" },
  FACEBOOK_FEED: { id: "FACEBOOK_FEED", label: "Facebook feed", width: 1200, height: 630, aspect: "1.91:1" },
  LINKEDIN_FEED: { id: "LINKEDIN_FEED", label: "LinkedIn feed", width: 1200, height: 627, aspect: "1.91:1" },
  X_FEED: { id: "X_FEED", label: "X (Twitter) post", width: 1600, height: 900, aspect: "16:9" },
  PINTEREST_PIN: { id: "PINTEREST_PIN", label: "Pinterest pin", width: 1000, height: 1500, aspect: "2:3" },
  BLOG_BANNER: { id: "BLOG_BANNER", label: "Blog / hero banner", width: 1600, height: 900, aspect: "16:9" },
};

/** Suggested default preset for a given platform. */
export const PLATFORM_DEFAULT_PRESET: Record<string, string> = {
  INSTAGRAM: "INSTAGRAM_FEED",
  FACEBOOK: "FACEBOOK_FEED",
  LINKEDIN: "LINKEDIN_FEED",
  X: "X_FEED",
  PINTEREST: "PINTEREST_PIN",
  TELEGRAM: "SQUARE",
  DISCORD: "SQUARE",
};

export const IMAGE_PRESET_IDS = Object.keys(IMAGE_PRESETS);
