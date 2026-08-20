import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  PayloadTooLargeException,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { env } from "../common/env";
import { PrismaService } from "../common/prisma.service";
import { Public } from "../common/public.decorator";
import { CsrfExempt } from "../common/csrf.guard";

/**
 * Meta's webhook endpoint. Finding S-7.
 *
 * It used to log a warning on an invalid signature and then **persist the row
 * anyway**. Any unauthenticated client could POST arbitrary JSON up to the
 * global 30 MB body limit and have it written to Postgres permanently — and,
 * with S-4, every caller shared one rate-limit bucket, so a single host could
 * push gigabytes in.
 *
 * Two smaller bugs travelled with it. The verifier length-checked hex strings
 * and then called timingSafeEqual on the *decoded* buffers, so a 64-character
 * non-hex signature decoded to a zero-length buffer and threw — a 500 where a
 * 401 belonged. And nothing ever set `processedAt`, so "stored for review"
 * meant "stored forever, read by nobody".
 */
@ApiExcludeController()
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  /**
   * A Meta event is a handful of kilobytes. The global 30 MB limit exists for
   * base64 photo uploads and has no business applying to an endpoint that
   * accepts unauthenticated bytes.
   */
  private static readonly MAX_BODY_BYTES = 1024 * 1024;

  constructor(private readonly prisma: PrismaService) {}

  /** Meta webhook subscription verification (GET with hub.challenge). */
  @Get("meta")
  @Public()
  verifyMeta(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") verifyToken: string,
    @Query("hub.challenge") challenge: string,
  ) {
    // env.meta.webhookVerifyToken throws when the variable is unset or is the
    // value published in this repository (S-5), so a misconfigured deployment
    // cannot be subscribed to by whoever read the default on GitHub.
    //
    // Caught rather than propagated: an unconfigured server must answer 401,
    // not 500. A 500 both leaks that the server is misconfigured and reads as
    // an outage rather than a refusal. validateConfig() makes this unreachable
    // in a correctly-started process — it is the belt to that brace.
    let expected: string | null = null;
    try {
      expected = env.meta.webhookVerifyToken;
    } catch (e) {
      this.logger.error(
        `Meta webhook verification refused: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (mode === "subscribe" && expected && constantTimeEquals(verifyToken, expected)) {
      return challenge;
    }
    // 401, not 400: this is a failed authentication and should read as one.
    throw new UnauthorizedException("Verification failed");
  }

  /** Meta event delivery. HMAC-validated with the app secret; unsigned is refused. */
  @Post("meta")
  @Public()
  @CsrfExempt("Meta posts server-to-server and is authenticated by x-hub-signature-256")
  @HttpCode(200)
  async receiveMeta(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ) {
    const raw = req.rawBody;
    if (raw && raw.length > WebhooksController.MAX_BODY_BYTES) {
      throw new PayloadTooLargeException("Webhook payload too large");
    }
    if (!this.validSignature(raw, signature)) {
      this.logger.warn("Meta webhook rejected: invalid or missing signature");
      // Nothing is written. "Stored for review" was an unauthenticated,
      // unbounded write to the primary database.
      throw new UnauthorizedException("Invalid signature");
    }

    const body = (req.body ?? {}) as { entry?: { id?: string; time?: number }[] };
    const externalId = eventId(body);

    // Replay protection. Meta retries, and a retried delivery is the same event.
    if (externalId) {
      const seen = await this.prisma.webhookEvent.findFirst({
        where: { platform: "FACEBOOK", externalId },
        select: { id: true },
      });
      if (seen) return { received: true, duplicate: true };
    }

    await this.prisma.webhookEvent.create({
      data: {
        platform: "FACEBOOK",
        externalId,
        payload: body as never,
        signatureValid: true,
      },
    });
    return { received: true };
  }

  /**
   * HMAC-SHA256 over the exact bytes received.
   *
   * Never over a re-serialised body: JSON.stringify does not reproduce the
   * provider's byte order or whitespace, so the digest would differ for a
   * payload that is genuine.
   */
  private validSignature(raw: Buffer | undefined, signature: string | undefined): boolean {
    if (!raw || !signature?.startsWith("sha256=")) return false;
    let appSecret: string;
    try {
      appSecret = env.meta.appSecret;
    } catch {
      return false;
    }
    if (!appSecret) return false;

    const provided = signature.slice("sha256=".length);
    // Validate the shape BEFORE decoding. Buffer.from(x, "hex") silently
    // truncates at the first non-hex character, so a 64-character non-hex
    // signature used to decode to an empty buffer and make timingSafeEqual
    // throw — a 500 instead of a rejection.
    if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

    const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
    return constantTimeEquals(expected.toLowerCase(), provided.toLowerCase());
  }
}

/**
 * A stable id for one delivery.
 *
 * Meta does not send a delivery id, so this is built from the entry ids and
 * their timestamps — the same batch redelivered carries the same values.
 */
function eventId(body: { entry?: { id?: string; time?: number }[] }): string | null {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const parts = entries
    .map((e) => (e && e.id !== undefined ? `${e.id}:${e.time ?? ""}` : ""))
    .filter(Boolean);
  return parts.length ? parts.join("|").slice(0, 191) : null;
}

/** Length-checked first: timingSafeEqual raises on a mismatch rather than
 *  returning false, which turns a rejected forgery into a server fault. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a ?? "");
  const right = Buffer.from(b ?? "");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
