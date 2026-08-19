import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { CookieOptions, Request, Response } from "express";
import Redis from "ioredis";
import { env } from "../common/env";
import { signToken, verifyToken } from "../common/tokens";

/**
 * The OAuth `state` parameter, done properly.
 *
 * Three findings meet here.
 *
 * C-1  `state` was a JWT signed with JWT_ACCESS_SECRET, and JwtAuthGuard
 *      accepted it as a session. It is now signed with OAUTH_STATE_SECRET and
 *      typed `oauth_state`; the guard refuses it twice over.
 *
 * S-11 `state` carried the initiator's orgId but was not bound to the browser
 *      completing the flow. An attacker could mint a state for *their own*
 *      workspace, build the provider's authorize URL with it, and get a victim
 *      to complete consent — attaching the victim's Facebook Pages to the
 *      attacker's workspace, with publish rights. Fixed by a cookie-bound
 *      nonce: the state carries SHA-256(nonce), the browser holds the nonce,
 *      and the callback compares them in constant time (RFC 9700 §4.7).
 *
 * P0-1 A signed, unexpired state was replayable for its whole lifetime. Each
 *      one now has a 128-bit `jti` held in Redis and consumed with GETDEL, so
 *      it works exactly once. The X flow already did this; the other five now
 *      match it.
 *
 * If Redis is unreachable the flow **fails**. It does not fall back to an
 * unprotected state — that is the fail-closed rule, and availability is not a
 * reason to skip an authorization control.
 */

/** 30 minutes was enough time for a leaked parameter to be worth stealing. */
const STATE_TTL_SECONDS = 10 * 60;
const STATE_TTL = `${STATE_TTL_SECONDS}s`;

/** One cookie per provider, so two flows in two tabs do not overwrite each other. */
export const NONCE_COOKIE_PREFIX = "godeye_oauth_";

export type OAuthProvider = "meta" | "instagram" | "tiktok" | "linkedin" | "reddit";

/**
 * Which providers document support for PKCE (RFC 7636).
 *
 * TikTok v2 accepts `code_challenge` + `code_challenge_method=S256` on the web
 * flow. Meta, Instagram Login, LinkedIn and Reddit do **not** document it for
 * the server-side authorization-code flow, and sending it to them is a live
 * risk on a production integration rather than a hardening measure. The
 * plumbing below is provider-agnostic, so each one flips to true the day its
 * provider supports it — see docs/security/OAUTH.md.
 */
const PKCE_SUPPORTED: Record<OAuthProvider, boolean> = {
  tiktok: true,
  meta: false,
  instagram: false,
  linkedin: false,
  reddit: false,
};

interface StateClaims {
  orgId: string;
  sub: string;
  provider: OAuthProvider;
  jti: string;
  /** SHA-256 of the nonce held in the browser's cookie. */
  nch: string;
}

export interface IssuedState {
  state: string;
  /** Present only for providers that support PKCE. */
  codeChallenge?: string;
}

export interface ConsumedState {
  orgId: string;
  userId: string;
  codeVerifier?: string;
}

/**
 * Where single-use state records live.
 *
 * An interface, not a Redis client, for one reason: the security property under
 * test is "a state works exactly once, and only in the browser that started
 * it". Requiring a running Redis to assert that would mean the test is skipped
 * on most machines, and a skipped security test is worse than none. The default
 * implementation is Redis, and it is what production runs.
 */
export interface StateStore {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

export const STATE_STORE = "OAUTH_STATE_STORE";

@Injectable()
export class RedisStateStore implements StateStore {
  private client?: Redis;

  /**
   * Created on first use, not at boot: nobody should need Redis reachable to
   * connect a Telegram bot. Once an OAuth flow starts, though, it is required.
   */
  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
      });
      this.client.on("error", () => {
        // Surfaced on the command itself; without a listener ioredis treats the
        // error as unhandled and takes the process down.
      });
    }
    return this.client;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis().set(key, value, "EX", ttlSeconds);
  }

  /** GETDEL, so two concurrent callbacks cannot both read the same state. */
  async take(key: string): Promise<string | null> {
    return this.redis().getdel(key);
  }

  async onModuleDestroy(): Promise<void> {
    // lint-rules:allow — shutdown. The connection is being discarded either
    // way, and a failure to close one has no consequence to report.
    await this.client?.quit().catch(() => undefined);
  }
}

@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);

  constructor(
    private readonly jwt: JwtService,
    @Inject(STATE_STORE) private readonly store: StateStore,
  ) {}

  private cookieName(provider: OAuthProvider): string {
    return `${NONCE_COOKIE_PREFIX}${provider}`;
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: env.nodeEnv === "production",
      // Lax is enough and is the safer choice: the callback arrives as a
      // top-level GET navigation, which Lax permits. None is used only when the
      // web app and the API are on different registrable domains, because then
      // the authorize XHR itself is cross-site and Lax would drop the cookie.
      sameSite: env.isCrossSite ? "none" : "lax",
      path: "/connections",
      maxAge: STATE_TTL_SECONDS * 1000,
    };
  }

  /**
   * Mint a state token, park its single-use record, and set the binding cookie.
   *
   * Returns the state to put in the provider's authorize URL, plus the PKCE
   * challenge where the provider supports one.
   */
  async issue(
    res: Response,
    provider: OAuthProvider,
    orgId: string,
    userId: string,
  ): Promise<IssuedState> {
    const jti = randomBytes(16).toString("hex"); // 128-bit
    const nonce = randomBytes(32).toString("hex");
    const codeVerifier = PKCE_SUPPORTED[provider]
      ? randomBytes(32).toString("base64url")
      : undefined;

    // Redis first. If the record cannot be stored the state must not exist,
    // or the callback would have nothing to consume and would either fail
    // confusingly or, worse, be written to skip the check.
    const record = JSON.stringify({ orgId, userId, codeVerifier });
    try {
      await this.store.put(`oauth:state:${jti}`, record, STATE_TTL_SECONDS);
    } catch (e) {
      this.logger.error(
        `Cannot reach Redis to store OAuth state for ${provider}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ServiceUnavailableException(
        "Cannot start the connection right now — the session store is unreachable. Try again in a moment.",
      );
    }

    const claims: StateClaims = {
      orgId,
      sub: userId,
      provider,
      jti,
      nch: sha256(nonce),
    };
    const state = await signToken(this.jwt, "oauth_state", claims, STATE_TTL);
    res.cookie(this.cookieName(provider), nonce, this.cookieOptions());

    return {
      state,
      codeChallenge: codeVerifier ? sha256base64url(codeVerifier) : undefined,
    };
  }

  /**
   * Verify and consume a state. Every failure is a hard rejection: no
   * connection is created, nothing is written.
   *
   * Checks, in order: signature + type + issuer + audience, the provider it was
   * minted for, the browser-bound nonce, and finally single use.
   */
  async consume(
    req: Request,
    res: Response,
    provider: OAuthProvider,
    state: string,
  ): Promise<ConsumedState> {
    let claims: StateClaims;
    try {
      claims = await verifyToken<StateClaims>(this.jwt, "oauth_state", state);
    } catch {
      throw new BadRequestException(
        "That authorization link is not valid. Start again from Connections.",
      );
    }
    if (claims.provider !== provider) {
      throw new BadRequestException("That authorization was started for a different platform.");
    }

    // The browser binding. A state obtained by an attacker and completed in a
    // victim's browser fails here, because the victim's browser never held the
    // matching nonce (S-11).
    const nonce = (req.cookies?.[this.cookieName(provider)] as string | undefined) ?? "";
    if (!nonce || !constantTimeEquals(sha256(nonce), claims.nch)) {
      throw new BadRequestException(
        "This authorization was not started in this browser. Start again from Connections.",
      );
    }
    res.clearCookie(this.cookieName(provider), { ...this.cookieOptions(), maxAge: undefined });

    // Single use, atomically (GETDEL in the Redis implementation): two
    // concurrent callbacks with the same state must not both read it as valid.
    let raw: string | null;
    try {
      raw = await this.store.take(`oauth:state:${claims.jti}`);
    } catch (e) {
      this.logger.error(
        `Cannot reach Redis to consume OAuth state for ${provider}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ServiceUnavailableException(
        "Cannot finish the connection right now — the session store is unreachable.",
      );
    }
    if (!raw) {
      throw new BadRequestException(
        "That authorization has expired or was already used. Start again from Connections.",
      );
    }

    const record = JSON.parse(raw) as { orgId: string; userId: string; codeVerifier?: string };
    // The Redis record is the authority on who started the flow; the JWT is
    // only how it travelled. They must agree.
    if (record.orgId !== claims.orgId || record.userId !== claims.sub) {
      throw new BadRequestException("That authorization does not match the session that began it.");
    }
    return { orgId: record.orgId, userId: record.userId, codeVerifier: record.codeVerifier };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length check first, and it cannot throw: timingSafeEqual requires equal
  // lengths and raises otherwise, which is how a comparison meant to be
  // constant-time becomes a 500 (see the same bug in the Meta webhook, S-7).
  return left.length === right.length && timingSafeEqual(left, right);
}
