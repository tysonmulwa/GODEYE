import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import Redis from "ioredis";
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
  tiktokAuthorizeUrl,
  tiktokExchangeCode,
  validateDiscord,
  validateTelegram,
  xAuthorizeUrl,
  xExchangeVerifier,
  xRequestToken,
} from "./platform-clients";

/**
 * Lifetime of the signed OAuth `state` token. It has to outlast the whole
 * detour through the provider, signing in, 2FA, choosing a page, granting
 * permissions, which routinely exceeds 10 minutes on a first connection and
 * then fails at the callback with an opaque "invalid state".
 */
const OAUTH_STATE_TTL = "30m";
/** The same window as OAUTH_STATE_TTL, in the unit Redis expects. */
const OAUTH_STATE_TTL_SECONDS = 30 * 60;

/**
 * How long a failure stays worth showing on a channel that is otherwise fine.
 *
 * lastError is stamped when a post fails and cleared when one succeeds, so a
 * channel that failed once and has not posted since keeps that message on
 * screen indefinitely. It sat on two workspaces for days, in red, describing
 * an attempt nobody remembered, next to a badge reading ACTIVE. That is not a
 * warning any more, it is furniture.
 *
 * A channel in a bad state still says so: status carries EXPIRED, ERROR and
 * DISCONNECTED, and those are shown however old they are. This only hides a
 * stale message on a channel the platform is still accepting.
 */
const ERROR_RELEVANT_HOURS = 24;

function currentError(c: { status: string; lastError: string | null; lastErrorAt: Date | null }) {
  if (!c.lastError) return null;
  if (c.status !== "ACTIVE") return c.lastError;
  if (!c.lastErrorAt) return null;
  const ageHours = (Date.now() - c.lastErrorAt.getTime()) / 3_600_000;
  return ageHours <= ERROR_RELEVANT_HOURS ? c.lastError : null;
}

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
      lastError: currentError(c),
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
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
    // The consumer keys identify this application and are the same for every
    // workspace, so they come from the server rather than from whoever is
    // connecting. Only the access token and secret name the account.
    if (!env.x.apiKey || !env.x.apiSecret) {
      throw new BadRequestException(
        "X is not configured on this server (X_API_KEY and X_API_SECRET missing)",
      );
    }
    const credentials = {
      apiKey: env.x.apiKey,
      apiSecret: env.x.apiSecret,
      accessToken: input.accessToken,
      accessSecret: input.accessSecret,
    };
    // Validated with the same four values that will be stored, so a connection
    // cannot pass a check and then fail on its first post.
    const account = await this.engine.validateX(credentials);
    return this.upsertConnection(orgId, userId, {
      platform: "X",
      externalId: account.id,
      displayName: `@${account.username}`,
      credentials,
    });
  }

  // ---------- X OAuth 1.0a (click-to-connect) ----------

  /**
   * X's return trip carries only the oauth_token, and signing the exchange
   * needs the secret that came with it, so the pair has to be parked between
   * the two requests. Redis rather than a Map because the customer can come
   * back to a different API instance than the one that sent them out, and an
   * in-process map would have lost them.
   *
   * Created on first use: nobody should need Redis reachable at boot to
   * connect a Telegram bot.
   */
  private xPendingClient?: Redis;

  private xPending(): Redis {
    if (!this.xPendingClient) {
      this.xPendingClient = new Redis(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 1000, 15_000),
      });
      this.xPendingClient.on("error", () => {
        // Errors surface on the command itself; without a listener ioredis
        // treats them as unhandled and takes the process down.
      });
    }
    return this.xPendingClient;
  }

  async xAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    const { oauthToken, oauthTokenSecret } = await xRequestToken();
    await this.xPending().set(
      `x_oauth:${oauthToken}`,
      JSON.stringify({ orgId, userId, oauthTokenSecret }),
      "EX",
      OAUTH_STATE_TTL_SECONDS,
    );
    return { url: xAuthorizeUrl(oauthToken) };
  }

  async xCallback(oauthToken: string, verifier: string): Promise<{ connected: number }> {
    const raw = await this.xPending().get(`x_oauth:${oauthToken}`);
    if (!raw) {
      throw new NotFoundException(
        "That X authorization has expired or was already used. Start again from Connections.",
      );
    }
    // Single use: the same oauth_token must never buy a second connection.
    await this.xPending().del(`x_oauth:${oauthToken}`);
    const pending = JSON.parse(raw) as {
      orgId: string;
      userId: string;
      oauthTokenSecret: string;
    };

    const account = await xExchangeVerifier(oauthToken, pending.oauthTokenSecret, verifier);
    await this.upsertConnection(pending.orgId, pending.userId, {
      platform: "X",
      externalId: account.userId,
      displayName: `@${account.username}`,
      // The consumer keys ride along because the engine signs every post with
      // all four values. OAuth 1.0a tokens do not expire, so no expiresAt.
      credentials: {
        apiKey: env.x.apiKey,
        apiSecret: env.x.apiSecret,
        accessToken: account.accessToken,
        accessSecret: account.accessSecret,
      },
    });
    return { connected: 1 };
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

  // ---------- TikTok OAuth ----------

  async tiktokAuthorize(orgId: string, userId: string): Promise<{ url: string }> {
    const state = await this.jwt.signAsync(
      { orgId, sub: userId, purpose: "tiktok_oauth" },
      { secret: env.jwtAccessSecret(), expiresIn: OAUTH_STATE_TTL },
    );
    return { url: tiktokAuthorizeUrl(state) };
  }

  async tiktokCallback(code: string, state: string): Promise<{ connected: number }> {
    const payload = await this.jwt.verifyAsync<{ orgId: string; sub: string; purpose: string }>(
      state,
      { secret: env.jwtAccessSecret() },
    );
    if (payload.purpose !== "tiktok_oauth") throw new NotFoundException("Invalid state");

    const account = await tiktokExchangeCode(code);
    await this.upsertConnection(payload.orgId, payload.sub, {
      platform: "TIKTOK",
      externalId: account.openId,
      displayName: `@${account.displayName}`,
      credentials: {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        openId: account.openId,
      },
      expiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
    });
    return { connected: 1 };
  }

  // ---------- Instagram OAuth (Instagram Login, no Facebook Page needed) ----------

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

  /**
   * Upsert the user's Facebook Pages as connections.
   *
   * Facebook connects Pages and nothing else. Instagram used to be created here
   * too, from the account linked to a Page, but that route needed permissions
   * we no longer request; a connection made that way would look ready on the
   * Connections page and then fail at publish time, which is worse than not
   * offering it. Instagram has its own button.
   */
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
      lastError: currentError(row),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
