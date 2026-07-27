import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type {
  DiscordConnectInput,
  TelegramConnectInput,
  XConnectInput,
} from "@godeye/shared";
import type { Platform, Prisma } from "@godeye/db";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { env } from "../common/env";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";
import {
  instagramAuthorizeUrl,
  instagramExchangeCode,
  linkedinAuthorizeUrl,
  linkedinExchangeCode,
  metaAuthorizeUrl,
  metaExchangeCode,
  metaListPages,
  type MetaPage,
  redditAuthorizeUrl,
  redditExchangeCode,
  validateDiscord,
  validateTelegram,
} from "./platform-clients";

/**
 * Lifetime of the signed OAuth `state` token. It has to outlast the whole
 * detour through the provider — signing in, 2FA, choosing a page, granting
 * permissions — which routinely exceeds 10 minutes on a first connection and
 * then fails at the callback with an opaque "invalid state".
 */
const OAUTH_STATE_TTL = "30m";

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly engine: EngineService,
    private readonly billing: BillingService,
  ) {}

  async list(orgId: string) {
    const rows = await this.prisma.socialConnection.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((c) => ({
      id: c.id,
      platform: c.platform,
      status: c.status,
      displayName: c.displayName,
      externalId: c.externalId,
      lastError: c.lastError,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async remove(orgId: string, id: string, userId: string) {
    const conn = await this.prisma.socialConnection.findFirst({ where: { id, orgId } });
    if (!conn) throw new NotFoundException("Connection not found");
    await this.prisma.socialConnection.delete({ where: { id } });
    this.audit.log({
      orgId,
      userId,
      action: "connection.deleted",
      targetType: "SocialConnection",
      targetId: id,
      metadata: { platform: conn.platform },
    });
    return { ok: true };
  }

  // ---------- Direct-credential platforms ----------

  async connectTelegram(orgId: string, userId: string, input: TelegramConnectInput) {
    const v = await validateTelegram(input.botToken, input.chatId);
    return this.upsertConnection(orgId, userId, {
      platform: "TELEGRAM",
      externalId: v.chatId,
      displayName: `@${v.botUsername} → ${v.chatTitle}`,
      credentials: { botToken: input.botToken, chatId: v.chatId },
    });
  }

  async connectDiscord(orgId: string, userId: string, input: DiscordConnectInput) {
    const v = await validateDiscord(input.botToken, input.channelId);
    return this.upsertConnection(orgId, userId, {
      platform: "DISCORD",
      externalId: v.channelId,
      displayName: `${v.botName} → #${v.channelName}`,
      credentials: { botToken: input.botToken, channelId: v.channelId },
    });
  }

  async connectX(orgId: string, userId: string, input: XConnectInput) {
    const account = await this.engine.validateX(input);
    return this.upsertConnection(orgId, userId, {
      platform: "X",
      externalId: account.id,
      displayName: `@${account.username}`,
      credentials: {
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
        accessToken: input.accessToken,
        accessSecret: input.accessSecret,
      },
    });
  }

  // ---------- Reddit OAuth (click-to-connect) ----------

  async redditAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    const state = await this.jwt.signAsync(
      { orgId, sub: userId, purpose: "reddit_oauth" },
      { secret: env.jwtAccessSecret(), expiresIn: OAUTH_STATE_TTL },
    );
    return { url: redditAuthorizeUrl(state) };
  }

  async redditCallback(code: string, state: string): Promise<{ connected: number }> {
    const payload = await this.jwt.verifyAsync<{ orgId: string; sub: string; purpose: string }>(
      state,
      { secret: env.jwtAccessSecret() },
    );
    if (payload.purpose !== "reddit_oauth") throw new NotFoundException("Invalid state");

    const account = await redditExchangeCode(code);
    await this.upsertConnection(payload.orgId, payload.sub, {
      platform: "REDDIT",
      externalId: account.username,
      // Zero-config default: posts go to the user's own Reddit profile (u/<name>),
      // which always accepts self-posts. A target subreddit can be set later.
      displayName: `u/${account.username}`,
      credentials: {
        refreshToken: account.refreshToken,
        accessToken: account.accessToken,
        subreddit: `u_${account.username}`,
        username: account.username,
      },
      expiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
    });
    return { connected: 1 };
  }

  // ---------- LinkedIn OAuth ----------

  async linkedinAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    if (!env.linkedin.clientId) {
      throw new NotFoundException(
        "LinkedIn is not configured on this server (LINKEDIN_CLIENT_ID missing)",
      );
    }
    const state = await this.jwt.signAsync(
      { orgId, sub: userId, purpose: "linkedin_oauth" },
      { secret: env.jwtAccessSecret(), expiresIn: OAUTH_STATE_TTL },
    );
    return { url: linkedinAuthorizeUrl(state) };
  }

  async linkedinCallback(code: string, state: string): Promise<{ connected: number }> {
    const payload = await this.jwt.verifyAsync<{ orgId: string; sub: string; purpose: string }>(
      state,
      { secret: env.jwtAccessSecret() },
    );
    if (payload.purpose !== "linkedin_oauth") throw new NotFoundException("Invalid state");

    const account = await linkedinExchangeCode(code);
    await this.upsertConnection(payload.orgId, payload.sub, {
      platform: "LINKEDIN",
      externalId: account.memberUrn,
      displayName: account.name,
      credentials: { accessToken: account.accessToken, memberUrn: account.memberUrn },
      expiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
    });
    return { connected: 1 };
  }

  // ---------- Instagram OAuth (Instagram Login — no Facebook Page needed) ----------

  async instagramAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    if (!env.instagram.appId) {
      throw new NotFoundException(
        "Instagram direct login is not configured on this server (INSTAGRAM_APP_ID missing)",
      );
    }
    const state = await this.jwt.signAsync(
      { orgId, sub: userId, purpose: "instagram_oauth" },
      { secret: env.jwtAccessSecret(), expiresIn: OAUTH_STATE_TTL },
    );
    return { url: instagramAuthorizeUrl(state) };
  }

  async instagramCallback(code: string, state: string): Promise<{ connected: number }> {
    const payload = await this.jwt.verifyAsync<{ orgId: string; sub: string; purpose: string }>(
      state,
      { secret: env.jwtAccessSecret() },
    );
    if (payload.purpose !== "instagram_oauth") throw new NotFoundException("Invalid state");

    const account = await instagramExchangeCode(code);
    await this.upsertConnection(payload.orgId, payload.sub, {
      platform: "INSTAGRAM",
      externalId: account.igUserId,
      displayName: `@${account.username}`,
      // authMethod tells the publisher to use graph.instagram.com with this
      // token, rather than the Facebook Graph host with a page token.
      credentials: {
        accessToken: account.accessToken,
        igUserId: account.igUserId,
        authMethod: "instagram_login",
      },
      expiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
    });
    return { connected: 1 };
  }

  // ---------- Meta OAuth ----------

  async metaAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    const state = await this.jwt.signAsync(
      { orgId, sub: userId, purpose: "meta_oauth" },
      { secret: env.jwtAccessSecret(), expiresIn: OAUTH_STATE_TTL },
    );
    return { url: metaAuthorizeUrl(state) };
  }

  /** Handles the browser redirect from Facebook. Returns pages connected. */
  async metaCallback(code: string, state: string): Promise<{ connected: number }> {
    const payload = await this.jwt.verifyAsync<{ orgId: string; sub: string; purpose: string }>(
      state,
      { secret: env.jwtAccessSecret() },
    );
    if (payload.purpose !== "meta_oauth") throw new NotFoundException("Invalid state");

    const userToken = await metaExchangeCode(code);
    const pages = await metaListPages(userToken);
    return { connected: await this.storeMetaPages(payload.orgId, payload.sub, pages) };
  }

  /** Upsert Facebook Pages (and any linked Instagram accounts) as connections. */
  private async storeMetaPages(
    orgId: string,
    userId: string,
    pages: MetaPage[],
  ): Promise<number> {
    let connected = 0;
    for (const page of pages) {
      await this.upsertConnection(orgId, userId, {
        platform: "FACEBOOK",
        externalId: page.pageId,
        displayName: page.pageName,
        credentials: { pageAccessToken: page.pageAccessToken, pageId: page.pageId },
      });
      connected++;
      if (page.igUserId) {
        await this.upsertConnection(orgId, userId, {
          platform: "INSTAGRAM",
          externalId: page.igUserId,
          displayName: `@${page.igUsername ?? page.igUserId}`,
          credentials: { pageAccessToken: page.pageAccessToken, igUserId: page.igUserId },
        });
        connected++;
      }
    }
    return connected;
  }

  // ---------- Internals ----------

  private async upsertConnection(
    orgId: string,
    userId: string,
    data: {
      platform: Platform;
      externalId: string;
      displayName: string;
      credentials: Record<string, string>;
      metadata?: Prisma.InputJsonValue;
      expiresAt?: Date;
    },
  ) {
    const encryptedCredentials = this.crypto.encryptJson(data.credentials);
    const existing = await this.prisma.socialConnection.findFirst({
      where: { orgId, platform: data.platform, externalId: data.externalId },
    });
    if (!existing) await this.billing.assertWithinLimit(orgId, "connections");
    const row = existing
      ? await this.prisma.socialConnection.update({
          where: { id: existing.id },
          data: {
            displayName: data.displayName,
            encryptedCredentials,
            status: "ACTIVE",
            lastError: null,
            lastErrorAt: null,
            lastCheckedAt: new Date(),
            metadata: data.metadata,
            expiresAt: data.expiresAt,
          },
        })
      : await this.prisma.socialConnection.create({
          data: {
            orgId,
            platform: data.platform,
            externalId: data.externalId,
            displayName: data.displayName,
            encryptedCredentials,
            lastCheckedAt: new Date(),
            metadata: data.metadata,
            expiresAt: data.expiresAt,
          },
        });

    this.audit.log({
      orgId,
      userId,
      action: existing ? "connection.updated" : "connection.created",
      targetType: "SocialConnection",
      targetId: row.id,
      metadata: { platform: data.platform, displayName: data.displayName },
    });

    return {
      id: row.id,
      platform: row.platform,
      status: row.status,
      displayName: row.displayName,
      externalId: row.externalId,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
