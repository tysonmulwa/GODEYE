import { z } from "zod";
import { PLATFORMS } from "./platforms";
import { IMAGE_PRESET_IDS } from "./image-presets";
import { TTS_VOICES, VIDEO_PRESET_IDS } from "./video-presets";

export const platformSchema = z.enum(PLATFORMS);
export const imagePresetSchema = z.enum(IMAGE_PRESET_IDS as [string, ...string[]]);
export const videoPresetSchema = z.enum(VIDEO_PRESET_IDS as [string, ...string[]]);
export const ttsVoiceSchema = z.enum(TTS_VOICES);

// ---------- Auth ----------

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128)
  .regex(/[a-z]/, "Must include a lowercase letter")
  .regex(/[A-Z0-9]/, "Must include an uppercase letter or digit");

/** Solo creators get a personal workspace; businesses name their organization. */
export const accountTypeSchema = z.enum(["CREATOR", "BUSINESS"]);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const registerSchema = z
  .object({
    name: z.string().min(2).max(80),
    email: z.string().email(),
    password: passwordSchema,
    accountType: accountTypeSchema.default("BUSINESS"),
    // Optional for creators (defaults to their own name); required for businesses.
    organizationName: z.string().min(2).max(80).optional().or(z.literal("")),
  })
  .refine((v) => v.accountType === "CREATOR" || (v.organizationName ?? "").trim().length >= 2, {
    message: "Business / organization name is required",
    path: ["organizationName"],
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------- Team & invitations ----------

/** Roles that can be granted to teammates. OWNER is never assignable. */
export const assignableRoleSchema = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: assignableRoleSchema.default("EDITOR"),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: assignableRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
  // New accounts: name + password (complexity enforced server-side on create).
  // Existing accounts: current password (+ MFA code when enabled).
  name: z.string().min(2).max(80).optional(),
  password: z.string().min(1).max(128),
  mfaCode: z.string().min(6).max(8).optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const switchOrgSchema = z.object({
  orgId: z.string().min(1),
});
export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;

export const orgSettingsSchema = z.object({
  requireApproval: z.boolean(),
});
export type OrgSettingsInput = z.infer<typeof orgSettingsSchema>;

// ---------- Content approval ----------

export const reviewContentSchema = z.object({
  note: z.string().max(1000).optional(),
});
export type ReviewContentInput = z.infer<typeof reviewContentSchema>;

// ---------- Business profile ----------

export const businessProfileSchema = z.object({
  businessName: z.string().min(1).max(120),
  industry: z.string().min(1).max(120),
  description: z.string().min(10).max(4000),
  targetAudience: z.string().min(5).max(2000),
  location: z.string().max(200).optional().or(z.literal("")),
  website: z.string().url().optional().or(z.literal("")),
  products: z.array(z.string().min(1).max(200)).max(50).default([]),
  services: z.array(z.string().min(1).max(200)).max(50).default([]),
  goals: z.array(z.string().min(1).max(300)).min(1).max(20),
  brandVoice: z.string().max(1000).optional().or(z.literal("")),
  competitors: z.array(z.string().min(1).max(120)).max(20).default([]),
  seasonalNotes: z.string().max(2000).optional().or(z.literal("")),
});
export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

// ---------- Connections ----------

export const telegramConnectSchema = z.object({
  botToken: z.string().regex(/^\d+:[\w-]{30,}$/, "Invalid Telegram bot token"),
  chatId: z.string().min(1, "Channel/chat id required (e.g. @mychannel or -100123456789)"),
});
export type TelegramConnectInput = z.infer<typeof telegramConnectSchema>;

export const discordConnectSchema = z.object({
  botToken: z.string().min(50, "Invalid Discord bot token"),
  channelId: z.string().regex(/^\d{15,25}$/, "Invalid Discord channel id"),
});
export type DiscordConnectInput = z.infer<typeof discordConnectSchema>;

export const redditConnectSchema = z.object({
  username: z.string().min(3).max(20),
  password: z.string().min(1),
  subreddit: z.string().min(2).max(30).describe("Default subreddit to post to (without r/)"),
});
export type RedditConnectInput = z.infer<typeof redditConnectSchema>;

export const xConnectSchema = z.object({
  apiKey: z.string().min(10).describe("Consumer API Key from developer.x.com"),
  apiSecret: z.string().min(20),
  accessToken: z.string().min(20).describe("Access Token with Read and Write permission"),
  accessSecret: z.string().min(20),
});
export type XConnectInput = z.infer<typeof xConnectSchema>;

export const metaTokenConnectSchema = z.object({
  accessToken: z
    .string()
    .min(20)
    .describe("A Facebook User or Page access token (e.g. from the Graph API Explorer)"),
});
export type MetaTokenConnectInput = z.infer<typeof metaTokenConnectSchema>;

// ---------- Content generation ----------

export const generateContentSchema = z.object({
  goal: z.string().min(3).max(1000).describe("What should this post achieve?"),
  platforms: z.array(platformSchema).min(1).max(10),
  tone: z.string().max(200).optional(),
  topic: z.string().max(500).optional(),
  callToAction: z.string().max(300).optional(),
  // Generate two competing angles (A/B) for split testing
  abTest: z.boolean().default(false),
});
export type GenerateContentInput = z.infer<typeof generateContentSchema>;

// ---------- Image generation ----------

export const generateImageSchema = z.object({
  prompt: z.string().min(3).max(2000).describe("What the image should depict"),
  preset: imagePresetSchema.default("SQUARE"),
  style: z.string().max(200).optional().describe("e.g. photorealistic, flat illustration, 3D"),
  contentItemId: z.string().optional().describe("attach the result to this content item"),
  applyBrand: z.boolean().default(false).describe("composite the org's logo/watermark"),
});
export type GenerateImageInput = z.infer<typeof generateImageSchema>;

export const generateVideoSchema = z.object({
  brief: z.string().min(3).max(2000).describe("What the video should be about"),
  preset: videoPresetSchema.default("VERTICAL"),
  durationSec: z.number().int().min(10).max(90).default(30),
  voice: ttsVoiceSchema.default("nova"),
  style: z.string().max(200).optional().describe("visual style for scene images"),
  includeCaptions: z.boolean().default(true),
  contentItemId: z.string().optional().describe("attach the result to this content item"),
});
export type GenerateVideoInput = z.infer<typeof generateVideoSchema>;

// ---------- SEO ----------

export const runSeoAuditSchema = z.object({
  url: z.string().url().optional().describe("defaults to the business profile website"),
  maxPages: z.number().int().min(1).max(50).default(20),
  // Set true to scan a site that isn't the org's registered website (the UI asks
  // for confirmation first). Plan-based limits on how many sites you can add are
  // intentionally not enforced yet — see SeoService.runAudit.
  allowForeign: z.boolean().default(false),
});
export type RunSeoAuditInput = z.infer<typeof runSeoAuditSchema>;

export const brandKitSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6366F1"),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0EA5E9"),
  fontFamily: z.string().max(120).optional().or(z.literal("")),
  watermarkEnabled: z.boolean().default(false),
});
export type BrandKitInput = z.infer<typeof brandKitSchema>;

// ---------- Scheduling ----------

export const schedulePostSchema = z.object({
  contentItemId: z.string().min(1),
  connectionIds: z.array(z.string().min(1)).min(1),
  scheduledAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).default("UTC"),
});
export type SchedulePostInput = z.infer<typeof schedulePostSchema>;

export const postingPlanSchema = z.object({
  name: z.string().min(1).max(120),
  cadence: z.enum(["DAILY_1", "DAILY_2", "DAILY_3", "HOURLY", "WEEKENDS", "CUSTOM"]),
  customCron: z.string().max(100).optional(),
  timezone: z.string().min(1).default("UTC"),
  platforms: z.array(platformSchema).min(1),
  // Empty preferredTimes = engine picks best times from engagement data
  preferredTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(24).default([]),
  autoGenerate: z.boolean().default(false),
  topics: z.array(z.string().min(2).max(300)).max(50).default([]),
  abTesting: z.boolean().default(false),
  recycleEvergreen: z.boolean().default(false),
  generateImages: z.boolean().default(false),
});
export type PostingPlanInput = z.infer<typeof postingPlanSchema>;

export const updatePostingPlanSchema = postingPlanSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdatePostingPlanInput = z.infer<typeof updatePostingPlanSchema>;
