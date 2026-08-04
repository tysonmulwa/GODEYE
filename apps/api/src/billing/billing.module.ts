import { Global, Module } from "@nestjs/common";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { z } from "zod";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { env } from "../common/env";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { MinRole, RolesGuard } from "../common/roles.guard";
import { ZodPipe } from "../common/zod.pipe";

export interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

export type UsageMetric = keyof PlanLimits;

const FREE_LIMITS: PlanLimits = {
  postsPerMonth: 30,
  aiTokensPerMonth: 100_000,
  connections: 3,
  seats: 1,
};

const checkoutSchema = z.object({ planCode: z.enum(["PRO", "SCALE"]) });

function monthStart(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The org's effective plan — CANCELED/absent subscriptions fall back to FREE. */
  async effectivePlan(orgId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { orgId },
      include: { plan: true },
    });
    if (sub && sub.status !== "CANCELED") {
      return { plan: sub.plan, subscription: sub };
    }
    const free = await this.prisma.plan.findUnique({ where: { code: "FREE" } });
    return { plan: free, subscription: sub };
  }

  private limitsOf(plan: { limits: unknown } | null): PlanLimits {
    const raw = (plan?.limits ?? {}) as Partial<PlanLimits>;
    return { ...FREE_LIMITS, ...raw };
  }

  async usage(orgId: string) {
    const since = monthStart();
    const [posts, tokenAgg, connections, seats, pendingInvites] = await Promise.all([
      this.prisma.scheduledPost.count({ where: { orgId, createdAt: { gte: since } } }),
      this.prisma.agentRun.aggregate({
        where: { orgId, createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.prisma.socialConnection.count({
        where: { orgId, status: { not: "DISCONNECTED" } },
      }),
      this.prisma.membership.count({ where: { orgId } }),
      this.prisma.invitation.count({
        where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    return {
      postsPerMonth: posts,
      aiTokensPerMonth:
        (tokenAgg._sum.inputTokens ?? 0) + (tokenAgg._sum.outputTokens ?? 0),
      connections,
      seats: seats + pendingInvites,
    };
  }

  async overview(orgId: string) {
    const [{ plan, subscription }, usage, plans] = await Promise.all([
      this.effectivePlan(orgId),
      this.usage(orgId),
      this.prisma.plan.findMany({ orderBy: { priceMonthlyUsd: "asc" } }),
    ]);
    return {
      plan: plan
        ? { code: plan.code, name: plan.name, priceMonthlyUsd: plan.priceMonthlyUsd.toString() }
        : { code: "FREE", name: "Free", priceMonthlyUsd: "0" },
      subscriptionStatus: subscription?.status ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      limits: this.limitsOf(plan),
      usage,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        priceMonthlyUsd: p.priceMonthlyUsd.toString(),
        limits: this.limitsOf(p),
      })),
      stripeConfigured: !!env.stripe.secretKey,
    };
  }

  /**
   * Throws when adding `count` more of `metric` would exceed the plan.
   * Called from the schedule/generate/invite/connect paths.
   */
  async assertWithinLimit(orgId: string, metric: UsageMetric, count = 1): Promise<void> {
    const { plan } = await this.effectivePlan(orgId);
    const limit = this.limitsOf(plan)[metric];
    const used = (await this.usage(orgId))[metric];
    if (used + count > limit) {
      const label: Record<UsageMetric, string> = {
        postsPerMonth: `posts this month (${used}/${limit})`,
        aiTokensPerMonth: `AI tokens this month (${used.toLocaleString()}/${limit.toLocaleString()})`,
        connections: `connected channels (${used}/${limit})`,
        seats: `team seats (${used}/${limit})`,
      };
      throw new ForbiddenException(
        `Plan limit reached: ${label[metric]}. Upgrade your plan in Settings to continue.`,
      );
    }
  }

  // ---------- Stripe (activates when STRIPE_SECRET_KEY is set) ----------

  async checkout(orgId: string, userId: string, planCode: "PRO" | "SCALE") {
    if (!env.stripe.secretKey) {
      throw new BadRequestException("Payments are not configured yet on this server");
    }
    const price = env.stripe.prices[planCode];
    if (!price) {
      throw new BadRequestException(`No Stripe price configured for the ${planCode} plan`);
    }

    const params = new URLSearchParams({
      mode: "subscription",
      client_reference_id: orgId,
      // Back to the page they started from, which now exists and shows the new
      // plan. It used to return to /settings, where nothing reported the
      // outcome of the payment either way.
      success_url: `${env.webUrl}/billing?billing=success`,
      cancel_url: `${env.webUrl}/billing?billing=cancelled`,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      "metadata[orgId]": orgId,
      "metadata[planCode]": planCode,
      "subscription_data[metadata][orgId]": orgId,
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.stripe.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !data.url) {
      this.logger.error(`Stripe checkout failed: ${data.error?.message}`);
      throw new BadRequestException(data.error?.message ?? "Could not start checkout");
    }

    this.audit.log({
      orgId,
      userId,
      action: "billing.checkout_started",
      metadata: { planCode },
    });
    return { url: data.url };
  }

  verifyStripeSignature(raw: Buffer | undefined, header: string | undefined): boolean {
    if (!raw || !header || !env.stripe.webhookSecret) return false;
    const parts = Object.fromEntries(
      header.split(",").map((kv) => kv.split("=") as [string, string]),
    );
    const timestamp = parts["t"];
    const provided = parts["v1"];
    if (!timestamp || !provided) return false;
    const expected = createHmac("sha256", env.stripe.webhookSecret)
      .update(`${timestamp}.${raw.toString("utf8")}`)
      .digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    } catch {
      return false;
    }
  }

  async handleStripeEvent(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<void> {
    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      const orgId =
        (obj.client_reference_id as string | null) ??
        ((obj.metadata as Record<string, string> | null)?.orgId ?? null);
      const planCode = (obj.metadata as Record<string, string> | null)?.planCode;
      if (!orgId || !planCode) return;
      const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
      if (!plan) return;
      await this.prisma.subscription.upsert({
        where: { orgId },
        update: {
          planId: plan.id,
          status: "ACTIVE",
          stripeCustomerId: (obj.customer as string) ?? null,
          stripeSubscriptionId: (obj.subscription as string) ?? null,
        },
        create: {
          orgId,
          planId: plan.id,
          status: "ACTIVE",
          stripeCustomerId: (obj.customer as string) ?? null,
          stripeSubscriptionId: (obj.subscription as string) ?? null,
        },
      });
      this.audit.log({ orgId, action: "billing.subscription_activated", metadata: { planCode } });
      this.logger.log(`Org ${orgId} upgraded to ${planCode}`);
    } else if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.canceled"
    ) {
      const stripeSubscriptionId = obj.id as string;
      const sub = await this.prisma.subscription.findFirst({ where: { stripeSubscriptionId } });
      if (!sub) return;
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "CANCELED" },
      });
      this.audit.log({ orgId: sub.orgId, action: "billing.subscription_canceled" });
    }
  }
}

@ApiTags("billing")
@Controller("billing")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({ summary: "Current plan, limits, and this month's usage" })
  overview(@CurrentAuth() auth: AccessTokenPayload) {
    return this.billing.overview(auth.orgId);
  }

  @Post("checkout")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Start a Stripe Checkout session for a paid plan" })
  checkout(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.billing.checkout(auth.orgId, auth.sub, body.planCode);
  }
}

@ApiTags("webhooks")
@Controller("webhooks")
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly billing: BillingService) {}

  @Post("stripe")
  @HttpCode(200)
  @ApiOperation({ summary: "Stripe events (signature-verified)" })
  async stripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
  ) {
    if (!this.billing.verifyStripeSignature(req.rawBody, signature)) {
      this.logger.warn("Stripe webhook with invalid signature rejected");
      throw new BadRequestException("Invalid signature");
    }
    await this.billing.handleStripeEvent(
      JSON.parse(req.rawBody!.toString("utf8")) as {
        type: string;
        data: { object: Record<string, unknown> };
      },
    );
    return { received: true };
  }
}

@Global()
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, RolesGuard],
  exports: [BillingService],
})
export class BillingModule {}
