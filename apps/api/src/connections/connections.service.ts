import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";
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
import { OAuthStateService, type OAuthProvider } from "./oauth-state.service";
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
 * How long X's request-token pair is parked between the two legs of OAuth 1.0a.
 *
 * The OAuth 2.0 flows no longer keep a TTL here: OAuthStateService owns it, and
 * it is 10 minutes rather than the 30 this used to be. Thirty minutes was long
 * enough that a `state` leaked through a provider's logs or a Referer header
 * was still worth stealing when somebody got round to reading them.
 */
const X_PENDING_TTL_SECONDS = 10 * 60;

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
    private readonly oauthState: OAuthStateService,
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
    // orgId in the write, not only in the read above: ownership is part of the
    // query rather than a check that a later refactor could drop (OWASP API1).
    await this.prisma.socialConnection.delete({ where: { id, orgId } });
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
      X_PENDING_TTL_SECONDS,
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

  // ---------- OAuth 2.0 flows (Reddit, LinkedIn, TikTok, Instagram, Meta) ----------
  //
  // All five share one shape now. Each `authorize` mints a single-use, browser
  // bound state through OAuthStateService and each `callback` consumes it. The
  // five used to differ only in the string they put in `purpose`, and all five
  // signed that state with the session key — which is C-1.

  async redditAuthorize(res: Response, orgId: string, userId: string): Promise<{ url: string }> {
    const { state } = await this.oauthState.issue(res, "reddit", orgId, userId);
    return { url: redditAuthorizeUrl(state) };
  }

  async redditCallback(
    req: Request,
    res: Response,
    code: string,
    state: string,
  ): Promise<{ connected: number }> {
    const { orgId, userId } = await this.beginCallback(req, res, "reddit", state);
    const account = await redditExchangeCode(code);
    await this.upsertConnection(orgId, userId, {
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

  async linkedinAuthorize(res: Response, orgId: string, userId: string): Promise<{ url: string }> {
    if (!env.linkedin.clientId) {
      throw new NotFoundException(
        "LinkedIn is not configured on this server (LINKEDIN_CLIENT_ID missing)",
      );
    }
    const { state } = await this.oauthState.issue(res, "linkedin", orgId, userId);
    return { url: linkedinAuthorizeUrl(state) };
  }

  async linkedinCallback(
    req: Request,
    res: Response,
    code: string,
    state: string,
  ): Promise<{ connected: number }> {
    const { orgId, userId } = await this.beginCallback(req, res, "linkedin", state);
    const account = await linkedinExchangeCode(code);
    await this.upsertConnection(orgId, userId, {
      platform: "LINKEDIN",
      externalId: account.memberUrn,
      displayName: account.name,
      credentials: { accessToken: account.accessToken, memberUrn: account.memberUrn },
      expiresAt: new Date(Date.now() + account.expiresInSeconds * 1000),
    });
    return { connected: 1 };
  }

  async tiktokAuthorize(res: Response, orgId: string, userId: string): Promise<{ url: string }> {
    const { state, codeChallenge } = await this.oauthState.issue(res, "tiktok", orgId, userId);
    return { url: tiktokAuthorizeUrl(state, codeChallenge) };
  }

  async tiktokCallback(
    req: Request,
    res: Response,
    code: string,
    state: string,
  ): Promise<{ connected: number }> {
    const { orgId, userId, codeVerifier } = await this.beginCallback(req, res, "tiktok", state);
    const account = await tiktokExchangeCode(code, codeVerifier);
    await this.upsertConnection(orgId, userId, {
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

  async instagramAuthorize(res: Response, orgId: string, userId: string): Promise<{ url: string }> {
    if (!env.instagram.appId) {
      throw new NotFoundException(
        "Instagram direct login is not configured on this server (INSTAGRAM_APP_ID missing)",
      );
    }
    const { state } = await this.oauthState.issue(res, "instagram", orgId, userId);
    return { url: instagramAuthorizeUrl(state) };
  }

  async instagramCallback(
    req: Request,
    res: Response,
    code: string,
    state: string,
  ): Promise<{ connected: number }> {
    const { orgId, userId } = await this.beginCallback(req, res, "instagram", state);
    const account = await instagramExchangeCode(code);
    await this.upsertConnection(orgId, userId, {
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

  async metaAuthorize(res: Response, orgId: string, userId: string): Promise<{ url: string }> {
    const { state } = await this.oauthState.issue(res, "meta", orgId, userId);
    return { url: metaAuthorizeUrl(state) };
  }

  /** Handles the browser redirect from Facebook. Returns pages connected. */
  async metaCallback(
    req: Request,
    res: Response,
    code: string,
    state: string,
  ): Promise<{ connected: number }> {
    const { orgId, userId } = await this.beginCallback(req, res, "meta", state);
    const userToken = await metaExchangeCode(code);
    const pages = await metaListPages(userToken);
    return { connected: await this.storeMetaPages(orgId, userId, pages) };
  }

  /**
   * Consume the state, then re-check that the person who started the flow may
   * still finish it.
   *
   * The membership re-check matters because a state lives up to ten minutes, and
   * in that window somebody can be demoted or removed. Without it, a member
   * removed mid-flow could still attach a channel to the workspace they just
   * left. RFC 9700 §4.7 covers the state binding; this is the authorization half
   * of the same idea.
   */
  private async beginCallback(
    req: Request,
    res: Response,
    provider: OAuthProvider,
    state: string,
  ): Promise<{ orgId: string; userId: string; codeVerifier?: string }> {
    const consumed = await this.oauthState.consume(req, res, provider, state);
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId: consumed.userId, orgId: consumed.orgId } },
      select: { role: true },
    });
    if (!membership) {
      throw new ForbiddenException("You are no longer a member of that workspace.");
    }
    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
      throw new ForbiddenException("Connecting a channel needs the Admin role.");
    }
    return consumed;
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
    // AAD binds the ciphertext to the workspace it belongs to, so a row copied
    // between tenants no longer decrypts (NIST SP 800-38D).
    const encryptedCredentials = this.crypto.encryptJson(data.credentials, `org:${orgId}`);
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
