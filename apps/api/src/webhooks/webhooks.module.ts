import {
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { WebhooksController } from "./webhooks.controller";

/** Meta events are kilobytes. See WebhooksController.MAX_BODY_BYTES. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * Refuse an oversized webhook body *before* it is read.
 *
 * The controller checks the parsed size too, but by then 30 MB of
 * unauthenticated bytes are already in memory — the global JSON limit is set
 * that high for base64 photo uploads, and it has no business applying to an
 * endpoint anyone on the internet can POST to (S-7).
 *
 * Registered as middleware rather than inline in main.ts so the test harness
 * gets it as well; a control that only exists in the composition root is a
 * control nothing can assert.
 */
@Injectable()
export class WebhookBodyLimitMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      throw new PayloadTooLargeException("Webhook payload too large");
    }
    next();
  }
}

@Module({
  controllers: [WebhooksController],
  providers: [WebhookBodyLimitMiddleware],
})
export class WebhooksModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WebhookBodyLimitMiddleware).forRoutes("webhooks");
  }
}
