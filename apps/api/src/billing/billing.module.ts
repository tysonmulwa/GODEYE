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
  OnModuleInit,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import { PLANS, type PlanCode } from "@godeye/shared";
import { z } from "zod";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { env } from "../common/env";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { MinRole, RolesGuard } from "../common/roles.guard";
import { ZodPipe } from "../common/zod.pipe";
import { WorkspaceAccessService } from "./workspace-access.service";

export interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

export type UsageMetric = keyof PlanLimits;

const ENTRY_LIMITS: PlanLimits = {
  postsPerMonth: 30,
  aiTokensPerMonth: 100_000,
  connections: 3,
  seats: 1,
};

/**
 * How a workspace is paying for the month.
 *
 * `subscription` is a Paystack plan: a card, charged again automatically every
 * month. `once` is a single transaction for one month, which is the only way
 * Apple Pay and M-Pesa can be used at all. Paystack can re-charge a card
 * authorisation and nothing else, so a wallet on a plan would take money once
 * and never renew.
 */
const checkoutSchema = z.object({
  planCode: z.enum(["PRO", "PREMIUM", "VIP"]),
  mode: z.enum(["subscription", "once"]).default("subscription"),
});

/** Days a single payment buys. A month, erring on the customer's side. */
const ONE_MONTH_DAYS = 31;

function monthStart(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: WorkspaceAccessService,
  ) {}

  /**
   * Check the plan codes at boot, so a wrong one is a line in the deploy log
   * rather than a customer discovering it with their card out.
   *
   * Deliberately not awaited and never fatal: Paystack being slow or briefly
   * down is not a reason to refuse to start the API.
   */
  onModuleInit(): void {
    if (env.nodeEnv === "test" || !env.paystack.secretKey) return;
    void (async () => {
      this.logger.log(`Paystack keys are ${env.paystack.mode} mode`);
      for (const code of ["PRO", "PREMIUM", "VIP"] as PlanCode[]) {
        const configured = env.paystack.plans[code];
        if (!configured) {
          this.logger.warn(`PAYSTACK_PLAN_${code} is not set, that tier cannot be bought`);
          continue;
        }
        try {
          const { amount, currency, interval } = await this.paystackPlan(code, configured);
          this.logger.log(
            `Paystack plan ${code}: ${(amount / 100).toFixed(2)} ${currency ?? "?"} / ${interval ?? "?"}`,
          );
        } catch {
          // paystackPlan already logged which variable Paystack rejected.
        }
      }
    })();
  }

  /** The org's effective plan. CANCELED/absent subscriptions fall back to the entry plan. */
  async effectivePlan(orgId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { orgId },
      include: { plan: true },
    });
    if (sub && sub.status !== "CANCELED") {
      return { plan: sub.plan, subscription: sub };
    }
    const entry = await this.prisma.plan.findUnique({ where: { code: "PRO" } });
    return { plan: entry, subscription: sub };
  }

  private limitsOf(plan: { limits: unknown } | null): PlanLimits {
    const raw = (plan?.limits ?? {}) as Partial<PlanLimits>;
    return { ...ENTRY_LIMITS, ...raw };
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
    const [{ plan, subscription }, usage, plans, access] = await Promise.all([
      this.effectivePlan(orgId),
      this.usage(orgId),
      this.prisma.plan.findMany({ orderBy: { priceMonthlyUsd: "asc" } }),
      this.access.state(orgId),
    ]);
    return {
      plan: plan
        ? { code: plan.code, name: plan.name, priceMonthlyUsd: plan.priceMonthlyUsd.toString() }
        : { code: "PRO", name: "Pro", priceMonthlyUsd: "19" },
      subscriptionStatus: subscription?.status ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      /** Trial clock and read-only state, the same answer the API enforces. */
      access,
      limits: this.limitsOf(plan),
      usage,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        priceMonthlyUsd: p.priceMonthlyUsd.toString(),
        // What a single month costs in the wallet currency, so the page can
        // quote M-Pesa customers the figure they will actually be asked for
        // rather than a converted dollar amount.
        priceOnceMajor: this.oneOffPrice(p.code),
        priceOnceCurrency: env.paystack.oneOffCurrency,
        limits: this.limitsOf(p),
      })),
      /** Whether a one-off month can be bought, and with what. Empty when the
       *  server has no wallet channels enabled at all. */
      oneOffChannels: env.paystack.oneOffChannels,
      // What the billing page needs to know to show an upgrade button at all.
      // Reported as a boolean: the secret key must never leave the server.
      paymentsConfigured: !!env.paystack.secretKey,
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

  // ---------- Paystack ----------

  /**
   * The plan as Paystack itself holds it.
   *
   * Read at checkout rather than kept in configuration, because the number that
   * matters is the one Paystack will actually bill. Taking it from anywhere
   * else, our own USD catalogue, an amount in an env var, invents a second
   * source of truth for a price, and the two only ever disagree in front of a
   * paying customer.
   *
   * It doubles as the check on the plan code. A code that does not resolve is
   * the difference between "PAYSTACK_PLAN_PRO holds the wrong string" and
   * Paystack's own reply, which is the unhelpful "Invalid Amount Sent".
   */
  private async paystackPlan(planCode: PlanCode, code: string) {
    const res = await fetch(`https://api.paystack.co/plan/${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${env.paystack.secretKey}` },
    });
    const data = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: { amount?: number; currency?: string; interval?: string; name?: string };
    };
    const amount = data.data?.amount;
    if (!res.ok || !data.status || typeof amount !== "number" || amount <= 0) {
      this.logger.error(
        `Paystack rejected the plan code in PAYSTACK_PLAN_${planCode} ("${code}") ` +
          `using the ${env.paystack.mode} key: ${data.message}`,
      );
      throw new BadRequestException(
        `Paystack does not recognise the plan code in PAYSTACK_PLAN_${planCode}, using this ` +
          `server's ${env.paystack.mode} key. Plan codes belong to one mode: a plan created ` +
          `in test mode does not exist for a live key, and the other way round. Check that ` +
          `the plan was created with the dashboard's Test/Live switch set to ${env.paystack.mode}, ` +
          `and that the value is the code beginning with PLN_, not the plan's name or id.`,
      );
    }
    return { amount, currency: data.data?.currency, interval: data.data?.interval };
  }

  /**
   * Start a Paystack subscription checkout.
   *
   * The amount is the plan's own, fetched a moment earlier. Paystack's
   * documented example omits it when a plan code is passed, but the live API
   * answers "Invalid Amount Sent" without one, it treats a missing amount as
   * zero. Sending the plan's exact figure satisfies it and cannot disagree
   * with what the subscription then charges.
   */
  async checkout(
    orgId: string,
    userId: string,
    planCode: PlanCode,
    mode: "subscription" | "once" = "subscription",
  ) {
    if (!env.paystack.secretKey) {
      throw new BadRequestException(
        "Payments are not configured on this server yet. Set PAYSTACK_SECRET_KEY.",
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email) {
      throw new BadRequestException("Your account has no email address to bill");
    }

    const request =
      mode === "once"
        ? this.oneOffRequest(planCode)
        : await this.subscriptionRequest(planCode);

    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.paystack.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: user.email,
        ...request,
        // Paystack appends its own query string, so the page has to tolerate
        // extra params. It already does: it reads only `billing`.
        callback_url: `${env.webUrl.split(",")[0]}/billing?billing=success`,
        // The only link back to the workspace. The webhook arrives on its own,
        // with no session, so without this there is no way to know which
        // organisation just paid, or, for a one-off, what it bought.
        metadata: { orgId, planCode, userId, mode },
      }),
    });
    const data = (await res.json()) as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; reference?: string };
    };
    if (!res.ok || !data.status || !data.data?.authorization_url) {
      this.logger.error(`Paystack checkout failed (${mode}): ${data.message}`);
      throw new BadRequestException(data.message ?? "Could not start checkout");
    }

    this.audit.log({
      orgId,
      userId,
      action: "billing.checkout_started",
      metadata: { planCode, mode, provider: "paystack" },
    });
    // The reference travels back so the page can show a QR of this exact
    // checkout and name the payment it is waiting for. Nothing is charged on
    // it until the customer completes it, on this device or another.
    return { url: data.data.authorization_url, reference: data.data.reference ?? null };
  }

  /**
   * A card subscription: Paystack holds the plan and charges it again monthly.
   *
   * No `channels` list. Paystack already limits a plan transaction to what it
   * can re-charge, and naming channels here would only risk offering one it
   * cannot.
   */
  private async subscriptionRequest(planCode: PlanCode) {
    const plan = env.paystack.plans[planCode];
    if (!plan) {
      throw new BadRequestException(
        `No Paystack plan configured for ${planCode}. Create a recurring plan in ` +
          `the Paystack dashboard and set PAYSTACK_PLAN_${planCode} to its plan code.`,
      );
    }
    const { amount, currency } = await this.paystackPlan(planCode, plan);
    return {
      plan,
      amount,
      // Only when Paystack stated one. A plan priced in a currency the
      // merchant does not have enabled fails at checkout, and guessing a
      // default here would hide which of the two is actually wrong.
      ...(currency ? { currency } : {}),
    };
  }

  /**
   * One month, bought outright.
   *
   * This exists because Paystack can only re-charge a card. A customer paying
   * with M-Pesa or Apple Pay has no reusable authorisation, so there is nothing
   * to renew, putting them on a plan would take their money once and then let
   * the workspace lock while they believed they were subscribed. Buying a
   * month at a time is the honest version of what those channels can do.
   *
   * Priced in shillings from the shared catalogue, because M-Pesa settles in
   * KES and a transaction carries exactly one currency.
   */
  private oneOffRequest(planCode: PlanCode) {
    return {
      amount: this.oneOffPrice(planCode) * 100,
      currency: env.paystack.oneOffCurrency,
      channels: env.paystack.oneOffChannels,
    };
  }

  /**
   * A single month's price in major units of the wallet currency.
   *
   * Read from the shared catalogue, never converted here: a rate applied at
   * checkout would quote one figure on the billing page and charge another at
   * the till, and the customer only finds out on their statement.
   */
  private oneOffPrice(planCode: string): number {
    const plan = PLANS.find((p) => p.code === planCode);
    if (!plan) throw new BadRequestException(`Unknown plan ${planCode}`);
    return env.paystack.oneOffCurrency === "KES" ? plan.priceMonthlyKes : plan.priceMonthlyUsd;
  }

  /**
   * Paystack signs with HMAC SHA512 over the raw body, keyed by the SECRET key
   * rather than a separate webhook secret. Verified against the exact bytes
   * received: re-serialising parsed JSON reorders keys and changes the digest,
   * so the check would fail on every genuine event.
   */
  verifyPaystackSignature(raw: Buffer | undefined, header: string | undefined): boolean {
    if (!raw || !header || !env.paystack.secretKey) return false;
    const expected = createHmac("sha512", env.paystack.secretKey).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    // Length-checked first: timingSafeEqual throws on a mismatch rather than
    // returning false, and a thrown error here would read as a server fault
    // instead of a rejected forgery.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handlePaystackEvent(event: {
    event?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const data = event.data ?? {};
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const orgId = typeof metadata.orgId === "string" ? metadata.orgId : null;

    if (event.event === "charge.success" || event.event === "subscription.create") {
      const planCode = typeof metadata.planCode === "string" ? metadata.planCode : null;
      if (!orgId || !planCode) {
        // Loud, because the money has already moved. A payment that cannot be
        // matched to a workspace is a customer who paid and got nothing.
        this.logger.error(
          `Paystack ${event.event} carried no orgId/planCode metadata; ` +
            `cannot activate a plan. Reference: ${String(data.reference ?? "unknown")}`,
        );
        return;
      }
      const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
      if (!plan) {
        this.logger.error(`Paystack event names plan ${planCode}, which does not exist`);
        return;
      }
      const customer = (data.customer ?? {}) as Record<string, unknown>;
      const once = metadata.mode === "once";
      const existing = await this.prisma.subscription.findUnique({
        where: { orgId },
        select: { currentPeriodEnd: true },
      });

      // A one-off buys a month from where the current one ends, not from now:
      // somebody who pays a week early has bought a month, not lost a week.
      // A subscription takes Paystack's own next charge date instead.
      const paidUntil = once
        ? new Date(
            Math.max(Date.now(), existing?.currentPeriodEnd?.getTime() ?? 0) +
              ONE_MONTH_DAYS * 24 * 3600 * 1000,
          )
        : this.parseDate(data.next_payment_date);

      const fields = {
        planId: plan.id,
        status: "ACTIVE" as const,
        providerCustomerId: (customer.customer_code as string) ?? null,
        // Deliberately left null for a one-off. Nothing renews it, and that
        // absence is what tells the read-only guard this month has a hard end
        // rather than a card behind it.
        providerSubscriptionId: once ? null : ((data.subscription_code as string) ?? null),
        // Only overwritten when there is a date to write. Clearing it on a
        // plain charge.success would erase the renewal date that the
        // subscription.create event had already recorded.
        ...(paidUntil ? { currentPeriodEnd: paidUntil } : {}),
      };
      await this.prisma.subscription.upsert({
        where: { orgId },
        create: { orgId, ...fields },
        update: fields,
      });
      // The workspace is paying as of this instant, it must not wait out a
      // cached read-only decision before it can publish again.
      this.access.invalidate(orgId);
      this.audit.log({
        orgId,
        action: "billing.subscription_activated",
        metadata: {
          planCode,
          provider: "paystack",
          mode: once ? "once" : "subscription",
          paidUntil: paidUntil?.toISOString() ?? null,
        },
      });
      this.logger.log(
        `Paystack activated ${planCode} for org ${orgId}` +
          (once ? ` until ${paidUntil?.toISOString()} (one-off month)` : " (subscription)"),
      );
      return;
    }

    if (event.event === "subscription.disable" || event.event === "subscription.not_renew") {
      const code = data.subscription_code as string | undefined;
      if (!code) return;
      const sub = await this.prisma.subscription.findFirst({
        where: { providerSubscriptionId: code },
      });
      if (sub) {
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { status: "CANCELED" },
        });
        this.access.invalidate(sub.orgId);
        this.audit.log({ orgId: sub.orgId, action: "billing.subscription_canceled" });
        this.logger.log(`Paystack cancelled the subscription for org ${sub.orgId}`);
      }
    }
  }

  /** Paystack sends dates as "2026-09-01T00:00:00.000Z" or "2026-09-01 00:00:00". */
  private parseDate(value: unknown): Date | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = new Date(value.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

@ApiTags("billing")
@Controller("billing")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({ summary: "Current plan, trial state, limits, and this month's usage" })
  overview(@CurrentAuth() auth: AccessTokenPayload) {
    return this.billing.overview(auth.orgId);
  }

  @Post("checkout")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Start a Paystack checkout: a card subscription that renews, or one month " +
      "bought outright (the only mode Apple Pay and M-Pesa can use)",
  })
  checkout(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.billing.checkout(auth.orgId, auth.sub, body.planCode, body.mode);
  }
}

@ApiTags("webhooks")
@Controller("webhooks")
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(private readonly billing: BillingService) {}

  /**
   * Paystack events.
   *
   * Answers 200 as soon as the signature checks out. Paystack retries anything
   * that is slow or non-200, and a retried charge.success would be a second
   * activation for a payment that already happened.
   */
  @Post("paystack")
  @HttpCode(200)
  @ApiOperation({ summary: "Paystack events (signature-verified)" })
  async paystack(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-paystack-signature") signature: string | undefined,
  ) {
    if (!this.billing.verifyPaystackSignature(req.rawBody, signature)) {
      this.logger.warn("Paystack webhook with invalid signature rejected");
      throw new BadRequestException("Invalid signature");
    }
    await this.billing.handlePaystackEvent(
      JSON.parse(req.rawBody!.toString("utf8")) as {
        event?: string;
        data?: Record<string, unknown>;
      },
    );
    return { received: true };
  }
}

@Global()
@Module({
  controllers: [BillingController, PaystackWebhookController],
  // TrialLockInterceptor is not listed here: AppModule registers it as a global
  // APP_INTERCEPTOR, and providing it twice would build two of them.
  providers: [BillingService, WorkspaceAccessService, RolesGuard],
  exports: [BillingService, WorkspaceAccessService],
})
export class BillingModule {}
