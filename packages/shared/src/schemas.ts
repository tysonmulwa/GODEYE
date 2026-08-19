import { z } from "zod";
import { PLATFORMS } from "./platforms";
import { IMAGE_PRESET_IDS } from "./image-presets";
import { TTS_VOICES, VIDEO_PRESET_IDS } from "./video-presets";

/**
 * An email address, normalised. Finding B-2.
 *
 * `User.email` is `@unique` in Postgres, which is case-SENSITIVE, while
 * `changeEmail` already lowercased its input — and that mismatch is the tell.
 * Registering as `Tyson@example.com` and signing in as `tyson@example.com` gave
 * "Invalid email or password" with no way to discover why; two accounts could
 * exist for one person; and an invitation whose case did not match created a
 * second account instead of joining the existing one.
 *
 * Trim as well as lowercase: a trailing space pasted from an email client is the
 * same address to a human and a different one to a unique index.
 */
export const emailSchema = z.string().trim().toLowerCase().email();

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
    email: emailSchema,
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

// ---------- Your own account ----------

export const updateProfileSchema = z.object({
  name: z.string().min(2).max(80),
  avatarUrl: z.string().url().max(500).optional().or(z.literal("")),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    // Proving you know the old one is what stops a borrowed session from
    // locking the real owner out of their account.
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "The new password is the same as the current one",
    path: ["newPassword"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const changeEmailSchema = z.object({
  email: emailSchema,
  // An email address is how an account is recovered, so changing it is a
  // password-gated action rather than a profile edit.
  password: z.string().min(1),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------- Team & invitations ----------

/** Roles that can be granted to teammates. OWNER is never assignable. */
export const assignableRoleSchema = z.enum(["ADMIN", "EDITOR", "VIEWER"]);
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
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

// Only what belongs to the account being connected. The consumer keys are
// this application's and live on the server.
export const xConnectSchema = z.object({
  accessToken: z.string().min(20).describe("Access Token with Read and Write permission"),
  accessSecret: z.string().min(20),
});
export type XConnectInput = z.infer<typeof xConnectSchema>;

export const uploadMediaSchema = z.object({
  contentItemId: z.string().optional().describe("attach the upload to this content item"),
  // Video is here because TikTok accepts nothing else, and Reels/Shorts need it.
  contentType: z
    .string()
    .regex(
      /^(image\/(png|jpe?g|webp|gif)|video\/(mp4|quicktime))$/,
      "Only PNG, JPEG, WebP, GIF images or MP4/MOV video",
    ),
  dataBase64: z.string().min(1).describe("base64-encoded file bytes (no data: prefix)"),
  filename: z.string().max(200).optional(),
});
export type UploadMediaInput = z.infer<typeof uploadMediaSchema>;


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
  // intentionally not enforced yet, see SeoService.runAudit.
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

// ---------- How a photo post is rendered ----------

// Shared by the composer and by autopilot plans, which inherit it into every
// post they generate. It lives on the post rather than the workspace: length
// is a creative choice that changes with the content.
export const slideshowLengthSchema = z
  .union([z.literal(30), z.literal(45), z.literal(60)])
  .default(30);

// ---------- Product catalogue ----------

export const productSettingsSchema = z
  .object({
    // Reading a shop's own website is opt-in. Sending false withdraws it.
    importConsent: z.boolean(),
    autoImport: z.boolean().default(false),
    autoPost: z.boolean().default(false),
    postPlatforms: z.array(platformSchema).max(10).default([]),
  })
  .refine((value) => !value.autoPost || value.postPlatforms.length > 0, {
    // Posting to nowhere looks identical to a feature that silently does not
    // work, and this one publishes on its own.
    message: "Choose where product posts should go before turning auto-post on",
    path: ["postPlatforms"],
  })
  .refine((value) => value.importConsent || (!value.autoImport && !value.autoPost), {
    message: "Product import has to be allowed before it can run on a schedule",
    path: ["importConsent"],
  });
export type ProductSettingsInput = z.infer<typeof productSettingsSchema>;

export const importProductsSchema = z.object({
  // Defaults to the workspace's own website; a different URL still has to sit
  // under the consent the workspace gave.
  url: z.string().url().optional(),
  limit: z.number().int().min(1).max(200).default(40),
});
export type ImportProductsInput = z.infer<typeof importProductsSchema>;

export const renderOptionsSchema = z.object({
  slideshowSeconds: slideshowLengthSchema,
  // TikTok ignores this, its API takes no still post that can carry audio.
  // Everywhere else it picks between a still carousel and a Reel.
  renderAsVideo: z.boolean().default(true),
});

// ---------- Scheduling ----------

export const schedulePostSchema = z.object({
  contentItemId: z.string().min(1),
  connectionIds: z.array(z.string().min(1)).min(1),
  scheduledAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).default("UTC"),
  // Carried on the content item, but chosen here: the composer offers it once
  // the media is attached, which is the first moment the choice means
  // anything. Optional so a caller that does not care keeps what is stored.
  slideshowSeconds: slideshowLengthSchema.optional(),
  renderAsVideo: z.boolean().optional(),
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
  // Inherited by every post this plan generates.
  ...renderOptionsSchema.shape,
});
export type PostingPlanInput = z.infer<typeof postingPlanSchema>;

export const updatePostingPlanSchema = postingPlanSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdatePostingPlanInput = z.infer<typeof updatePostingPlanSchema>;
