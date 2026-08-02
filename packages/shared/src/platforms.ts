/** Platform registry — mirror of the Prisma `Platform` enum plus UI metadata. */

export const PLATFORMS = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "TIKTOK",
  "LINKEDIN",
  "PINTEREST",
  "SNAPCHAT",
  "YOUTUBE",
  "X",
  "TELEGRAM",
  "WHATSAPP_BUSINESS",
  "REDDIT",
  "DISCORD",
  "MEDIUM",
  "TUMBLR",
  "WORDPRESS",
  "SHOPIFY",
  "WOOCOMMERCE",
  "GOOGLE_BUSINESS",
  "GOOGLE_ANALYTICS",
  "GOOGLE_SEARCH_CONSOLE",
  "GOOGLE_ADS",
  "META_ADS",
  "TIKTOK_ADS",
  "MICROSOFT_ADS",
  "MAILCHIMP",
  "BREVO",
  "HUBSPOT",
  "ZAPIER",
  "SLACK",
  "NOTION",
  "GITHUB",
  "CLOUDFLARE",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export type PlatformCategory =
  | "social"
  | "messaging"
  | "publishing"
  | "commerce"
  | "analytics"
  | "ads"
  | "email"
  | "tools";

export interface PlatformInfo {
  id: Platform;
  label: string;
  category: PlatformCategory;
  /** true = users can connect it in the current build */
  available: boolean;
  /** max post body length where relevant */
  maxLength?: number;
}

export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  FACEBOOK: { id: "FACEBOOK", label: "Facebook", category: "social", available: true, maxLength: 63206 },
  INSTAGRAM: { id: "INSTAGRAM", label: "Instagram", category: "social", available: true, maxLength: 2200 },
  THREADS: { id: "THREADS", label: "Threads", category: "social", available: false, maxLength: 500 },
  TIKTOK: { id: "TIKTOK", label: "TikTok", category: "social", available: true, maxLength: 2200 },
  LINKEDIN: { id: "LINKEDIN", label: "LinkedIn", category: "social", available: true, maxLength: 3000 },
  PINTEREST: { id: "PINTEREST", label: "Pinterest", category: "social", available: false, maxLength: 500 },
  SNAPCHAT: { id: "SNAPCHAT", label: "Snapchat", category: "social", available: false },
  YOUTUBE: { id: "YOUTUBE", label: "YouTube", category: "social", available: false, maxLength: 5000 },
  X: { id: "X", label: "X (Twitter)", category: "social", available: true, maxLength: 280 },
  TELEGRAM: { id: "TELEGRAM", label: "Telegram", category: "messaging", available: true, maxLength: 4096 },
  WHATSAPP_BUSINESS: { id: "WHATSAPP_BUSINESS", label: "WhatsApp Business", category: "messaging", available: false },
  REDDIT: { id: "REDDIT", label: "Reddit", category: "social", available: true, maxLength: 40000 },
  DISCORD: { id: "DISCORD", label: "Discord", category: "messaging", available: true, maxLength: 2000 },
  MEDIUM: { id: "MEDIUM", label: "Medium", category: "publishing", available: false },
  TUMBLR: { id: "TUMBLR", label: "Tumblr", category: "publishing", available: false },
  WORDPRESS: { id: "WORDPRESS", label: "WordPress", category: "publishing", available: false },
  SHOPIFY: { id: "SHOPIFY", label: "Shopify", category: "commerce", available: false },
  WOOCOMMERCE: { id: "WOOCOMMERCE", label: "WooCommerce", category: "commerce", available: false },
  GOOGLE_BUSINESS: { id: "GOOGLE_BUSINESS", label: "Google Business Profile", category: "tools", available: false },
  GOOGLE_ANALYTICS: { id: "GOOGLE_ANALYTICS", label: "Google Analytics", category: "analytics", available: false },
  GOOGLE_SEARCH_CONSOLE: { id: "GOOGLE_SEARCH_CONSOLE", label: "Google Search Console", category: "analytics", available: false },
  GOOGLE_ADS: { id: "GOOGLE_ADS", label: "Google Ads", category: "ads", available: false },
  META_ADS: { id: "META_ADS", label: "Meta Ads", category: "ads", available: false },
  TIKTOK_ADS: { id: "TIKTOK_ADS", label: "TikTok Ads", category: "ads", available: false },
  MICROSOFT_ADS: { id: "MICROSOFT_ADS", label: "Microsoft Ads", category: "ads", available: false },
  MAILCHIMP: { id: "MAILCHIMP", label: "Mailchimp", category: "email", available: false },
  BREVO: { id: "BREVO", label: "Brevo", category: "email", available: false },
  HUBSPOT: { id: "HUBSPOT", label: "HubSpot", category: "email", available: false },
  ZAPIER: { id: "ZAPIER", label: "Zapier", category: "tools", available: false },
  SLACK: { id: "SLACK", label: "Slack", category: "tools", available: false },
  NOTION: { id: "NOTION", label: "Notion", category: "tools", available: false },
  GITHUB: { id: "GITHUB", label: "GitHub", category: "tools", available: false },
  CLOUDFLARE: { id: "CLOUDFLARE", label: "Cloudflare", category: "tools", available: false },
};

export const AVAILABLE_PLATFORMS = PLATFORMS.filter((p) => PLATFORM_INFO[p].available);
