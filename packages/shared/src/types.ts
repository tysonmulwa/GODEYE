import type { Platform } from "./platforms";

/** API-facing DTOs shared between the NestJS API and the Next.js frontend. */

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  mfaEnabled: boolean;
}

export type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
export type OrgType = "BUSINESS" | "CREATOR";

export interface ApiOrganization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  type?: OrgType;
  requireApproval?: boolean;
}

export interface ApiMember {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

export interface ApiInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: OrgRole;
  inviterName: string | null;
  /** true when an account with the invited email already exists */
  accountExists: boolean;
}

export interface ApiOrgMembership {
  orgId: string;
  name: string;
  slug: string;
  role: OrgRole;
}

export interface AuthResponse {
  user: ApiUser;
  organization: ApiOrganization;
  accessToken: string;
}

export interface ApiConnection {
  id: string;
  platform: Platform;
  status: "ACTIVE" | "EXPIRED" | "ERROR" | "DISCONNECTED";
  displayName: string;
  externalId: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface PlatformVariant {
  body: string;
  hashtags: string[];
}

export interface ApiContentItem {
  id: string;
  type: string;
  status: string;
  title: string | null;
  body: string;
  hashtags: string[];
  variants: Record<string, PlatformVariant> | null;
  aiGenerated: boolean;
  submittedAt?: string | null;
  submittedByName?: string | null;
  reviewedAt?: string | null;
  reviewedByName?: string | null;
  reviewNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiScheduledPost {
  id: string;
  contentItemId: string;
  connectionId: string;
  platform: Platform;
  connectionName: string;
  scheduledAt: string;
  timezone: string;
  status: "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED" | "CANCELLED";
  publishedAt: string | null;
  externalPostUrl: string | null;
  error: string | null;
  contentPreview: string;
}

export interface GenerateTaskResponse {
  agentRunId: string;
  taskId: string;
}

export interface ApiMediaAsset {
  id: string;
  kind: string;
  source: string;
  url: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  prompt: string | null;
  preset: string | null;
  contentItemId: string | null;
  createdAt: string;
}

export interface ApiBrandKit {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  fontFamily: string | null;
  watermarkEnabled: boolean;
}

export interface SeoFinding {
  severity: "critical" | "warning" | "info";
  code: string;
  page: string;
  message: string;
  recommendation: string;
}

export interface SeoKeywordCluster {
  topic: string;
  intent: string;
  keywords: string[];
}

export interface SeoMetaSuggestion {
  page: string;
  currentTitle: string | null;
  suggestedTitle: string;
  currentDescription: string | null;
  suggestedDescription: string;
}

export interface ApiSeoAudit {
  id: string;
  url: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  score: number | null;
  pagesCrawled: number;
  findings: SeoFinding[] | null;
  keywords: { clusters: SeoKeywordCluster[] } | null;
  metaSuggestions: SeoMetaSuggestion[] | null;
  schemaMarkup: Record<string, unknown> | null;
  hasSitemap: boolean;
  hasRobots: boolean;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Realtime events pushed over WebSocket (org room). */
export type RealtimeEvent =
  | { type: "agent_run.completed"; agentRunId: string; status: "SUCCEEDED" | "FAILED"; contentItemId?: string }
  | { type: "agent_run.progress"; agentRunId: string; step: string }
  | { type: "media_asset.created"; agentRunId: string; mediaAssetId: string; url: string | null }
  | { type: "scheduled_post.updated"; scheduledPostId: string; status: string; error?: string | null };
