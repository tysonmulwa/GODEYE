import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { env } from "../common/env";
import { PrismaService } from "../common/prisma.service";
import { Public } from "../common/public.decorator";

@ApiExcludeController()
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Meta webhook subscription verification (GET with hub.challenge). */
  @Get("meta")
  @Public()
  verifyMeta(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") verifyToken: string,
    @Query("hub.challenge") challenge: string,
  ) {
    if (mode === "subscribe" && verifyToken === env.meta.webhookVerifyToken) {
      return challenge;
    }
    throw new BadRequestException("Verification failed");
  }

  /** Meta event delivery. HMAC-validated with the app secret. */
  @Post("meta")
  @Public()
  @HttpCode(200)
  async receiveMeta(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ) {
    const raw = req.rawBody;
    const valid = this.validSignature(raw, signature);
    if (!valid) this.logger.warn("Meta webhook with invalid signature stored for review");

    await this.prisma.webhookEvent.create({
      data: {
        platform: "FACEBOOK",
        payload: (req.body ?? {}) as never,
        signatureValid: valid,
      },
    });
    return { received: true };
  }

  private validSignature(raw: Buffer | undefined, signature: string | undefined): boolean {
    if (!raw || !signature?.startsWith("sha256=") || !env.meta.appSecret) return false;
    const expected = createHmac("sha256", env.meta.appSecret).update(raw).digest("hex");
    const provided = signature.slice("sha256=".length);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  }
}
