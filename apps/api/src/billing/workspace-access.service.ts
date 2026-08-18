import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  BILLING_EXEMPT_SLUGS,
  TRIAL_HOURS,
  type PlanCode,
  type WorkspaceAccess,
} from "@godeye/shared";
import { PrismaService } from "../common/prisma.service";
import { env } from "../common/env";

const TRIAL_MS = TRIAL_HOURS * 3600 * 1000;

/**
 * How long a computed access decision is reused.
 *
 * Every write in the product asks this question, so it cannot be a database
 * round trip each time. Thirty seconds is short enough that a workspace which
 * has just paid is writing again almost immediately, and the payment webhook
 * clears the entry itself, so in practice it is instant.
 */
const CACHE_TTL_MS = 30_000;

/** How often expiry is written into the database. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/** Long enough for the database pool to be up, short enough to matter on boot. */
const FIRST_SWEEP_DELAY_MS = 10_000;

interface CacheEntry {
  expiresAt: number;
  value: WorkspaceAccess;
}

export interface SweepResult {
  /** Trials whose clock had run out, now recorded as PAST_DUE. */
  expired: number;
  /** Bought months that have run out, with no card behind them to renew. */
  lapsed: number;
  /** Workspaces that predate the trial and had no subscription row at all. */
  backfilled: number;
  /** Exempt workspaces put back to ACTIVE. */
  comped: number;
}

/**
 * Who may write, and for how much longer.
 *
 * Every new workspace gets {@link TRIAL_HOURS} of full Pro access, recorded as
 * a TRIALING subscription with `currentPeriodEnd` set at signup. When that
 * moment passes without payment the workspace goes read-only.
 *
 * Two things enforce it, deliberately:
 *
 *  - {@link state} *computes* the answer from `currentPeriodEnd`, so a trial
 *    that ran out one second ago is already locked. A product that only
 *    enforces what a periodic job has written gives away a free window as wide
 *    as the job's interval.
 *  - {@link sweep} *records* it, flipping expired trials to PAST_DUE. Without
 *    that the database says TRIALING forever and every report, export and
 *    support question has to re-derive the truth from a timestamp.
 *
 * The workspaces GODEYE itself runs (BILLING_EXEMPT_SLUGS) are never billed and
 * never locked, locking one would shut the owner out of their own product.
 */
@Injectable()
export class WorkspaceAccessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceAccessService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Tests drive sweep() directly; a timer there would outlive the suite and
    // hit a database that the test never configured.
    if (env.nodeEnv === "test") return;
    this.timer = setInterval(() => void this.safeSweep(), SWEEP_INTERVAL_MS);
    // Unreferenced so it can never be the reason the process refuses to exit.
    this.timer.unref?.();
    setTimeout(() => void this.safeSweep(), FIRST_SWEEP_DELAY_MS).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- The trial itself ----------

  /**
   * Put a brand new workspace on its trial.
   *
   * Upserts rather than creates, and leaves an existing row untouched: calling
   * this twice must never hand out a second 24 hours.
   *
   * Never throws. It is called from the middle of registration, and an
   * unseeded Plan table is not a reason to refuse somebody an account, the
   * sweeper backfills a missing subscription on its next pass.
   */
  async startTrial(orgId: string): Promise<Date | null> {
    try {
      const plan = await this.prisma.plan.findUnique({
        where: { code: "PRO" satisfies PlanCode },
        select: { id: true },
      });
      if (!plan) {
        this.logger.error(
          `No PRO plan in the database, so org ${orgId} starts with no trial. ` +
            `Run: pnpm --filter @godeye/db seed`,
        );
        return null;
      }
      const currentPeriodEnd = new Date(Date.now() + TRIAL_MS);
      await this.prisma.subscription.upsert({
        where: { orgId },
        update: {},
        create: { orgId, planId: plan.id, status: "TRIALING", currentPeriodEnd },
      });
      this.cache.delete(orgId);
      return currentPeriodEnd;
    } catch (e) {
      this.logger.error(`Could not start the trial for org ${orgId}: ${(e as Error).message}`);
      return null;
    }
  }

  // ---------- The read-only decision ----------

  /** Forget a cached decision, call after anything that changes what it would be. */
  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  async state(orgId: string): Promise<WorkspaceAccess> {
    const hit = this.cache.get(orgId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        slug: true,
        subscription: {
          select: {
            status: true,
            currentPeriodEnd: true,
            // Present only when Paystack holds a card it can charge again.
            // A month bought with M-Pesa or Apple Pay has none, and that
            // absence is what separates "renews itself" from "ends".
            providerSubscriptionId: true,
            plan: { select: { code: true } },
          },
        },
      },
    });

    const value = this.decide(org);
    // A decision is never cached past the moment it would change. Without this,
    // a trial expiring in two seconds would keep writing for another thirty,
    // and the same applies to the last minute of a month somebody bought.
    const trialEnd = value.trialEndsAt ? Date.parse(value.trialEndsAt) : Infinity;
    const boughtMonthEnd =
      org?.subscription && !org.subscription.providerSubscriptionId
        ? (org.subscription.currentPeriodEnd?.getTime() ?? Infinity)
        : Infinity;
    this.cache.set(orgId, {
      expiresAt: Math.min(Date.now() + CACHE_TTL_MS, trialEnd, boughtMonthEnd),
      value,
    });
    return value;
  }

  private decide(
    org: {
      slug: string;
      subscription: {
        status: string;
        currentPeriodEnd: Date | null;
        providerSubscriptionId: string | null;
        plan: { code: string } | null;
      } | null;
    } | null,
  ): WorkspaceAccess {
    // An access token for an organisation that no longer exists. Everything
    // else about the request is about to fail on its own; refusing here would
    // only mislabel it as a billing problem.
    if (!org) {
      return { status: "ACTIVE", locked: false, trialEndsAt: null, planCode: null };
    }

    const planCode = (org.subscription?.plan?.code ?? null) as PlanCode | null;

    if (BILLING_EXEMPT_SLUGS.includes(org.slug)) {
      return { status: "EXEMPT", locked: false, trialEndsAt: null, planCode };
    }

    const sub = org.subscription;
    // Workspaces that predate the trial have no subscription row. They are left
    // writing until the sweeper gives them one, locking somebody out because a
    // backfill has not run yet would be a bug they experience as a betrayal.
    if (!sub) {
      return { status: "TRIALING", locked: false, trialEndsAt: null, planCode: null };
    }

    if (sub.status === "TRIALING") {
      const endsAt = sub.currentPeriodEnd;
      const expired = !!endsAt && endsAt.getTime() <= Date.now();
      return {
        status: expired ? "LOCKED" : "TRIALING",
        locked: expired,
        trialEndsAt: endsAt?.toISOString() ?? null,
        planCode,
      };
    }

    if (sub.status === "ACTIVE") {
      // A month bought outright ends when it ends: there is no card to charge,
      // so nothing will extend it and the workspace goes read-only until the
      // next payment. A card subscription is left alone even a few days past
      // its renewal date. Paystack retries a failed charge, and its webhook
      // is what cancels. Locking a paying customer because a webhook was slow
      // is the worse error of the two.
      const boughtMonth = !sub.providerSubscriptionId;
      const ended = !!sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= Date.now();
      if (boughtMonth && ended) {
        return { status: "LOCKED", locked: true, trialEndsAt: null, planCode };
      }
      return { status: "ACTIVE", locked: false, trialEndsAt: null, planCode };
    }

    // PAST_DUE (an expired trial the sweeper has recorded, or a failed renewal)
    // and CANCELED both mean: nothing has been paid for.
    return { status: "LOCKED", locked: true, trialEndsAt: null, planCode };
  }

  // ---------- Recording expiry, rather than only computing it ----------

  private async safeSweep(): Promise<void> {
    if (this.sweeping) return; // a slow pass must not overlap the next tick
    this.sweeping = true;
    try {
      const result = await this.sweep();
      if (result.expired || result.lapsed || result.backfilled || result.comped) {
        this.logger.log(
          `Billing sweep: ${result.expired} trials expired, ${result.lapsed} bought ` +
            `months lapsed, ${result.backfilled} backfilled, ${result.comped} comped`,
        );
      }
    } catch (e) {
      this.logger.error(`Trial sweep failed: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Write down what the clock already says.
   *
   * Idempotent, so running it twice, or on two instances at once, changes
   * nothing the second time.
   */
  async sweep(now = new Date()): Promise<SweepResult> {
    const expired = await this.prisma.subscription.updateMany({
      where: {
        status: "TRIALING",
        currentPeriodEnd: { lte: now },
        org: { slug: { notIn: BILLING_EXEMPT_SLUGS } },
      },
      data: { status: "PAST_DUE" },
    });

    // Months bought outright with a wallet. Nothing renews them, so once the
    // date passes the workspace has stopped paying, the same state an expired
    // trial lands in. Card subscriptions are untouched here: theirs is a
    // renewal date, not a deadline, and Paystack's own webhook cancels them.
    const lapsed = await this.prisma.subscription.updateMany({
      where: {
        status: "ACTIVE",
        providerSubscriptionId: null,
        currentPeriodEnd: { lte: now },
        org: { slug: { notIn: BILLING_EXEMPT_SLUGS } },
      },
      data: { status: "PAST_DUE" },
    });

    // The workspaces GODEYE runs are comped. Saying so in the data means the
    // billing page and any export agree with the guard, instead of the exemption
    // living only in a list in code.
    const comped = await this.prisma.subscription.updateMany({
      where: { org: { slug: { in: BILLING_EXEMPT_SLUGS } }, status: { not: "ACTIVE" } },
      data: { status: "ACTIVE" },
    });

    const backfilled = await this.backfillMissing(now);

    if (expired.count || lapsed.count || comped.count || backfilled) this.cache.clear();
    return {
      expired: expired.count,
      lapsed: lapsed.count,
      backfilled,
      comped: comped.count,
    };
  }

  /**
   * Give a subscription to workspaces created before trials existed.
   *
   * Their clock starts now rather than at signup: dating it from `createdAt`
   * would lock every existing customer the moment this ships, which is not a
   * decision a backfill gets to make on its own.
   */
  private async backfillMissing(now: Date): Promise<number> {
    const orphans = await this.prisma.organization.findMany({
      where: { subscription: { is: null } },
      select: { id: true, slug: true },
    });
    if (orphans.length === 0) return 0;

    const [pro, vip] = await Promise.all([
      this.prisma.plan.findUnique({ where: { code: "PRO" }, select: { id: true } }),
      this.prisma.plan.findUnique({ where: { code: "VIP" }, select: { id: true } }),
    ]);
    if (!pro) {
      this.logger.error("No PRO plan in the database; cannot backfill trials");
      return 0;
    }

    const trialEnd = new Date(now.getTime() + TRIAL_MS);
    const created = await this.prisma.subscription.createMany({
      data: orphans.map((org) => {
        const exempt = BILLING_EXEMPT_SLUGS.includes(org.slug);
        return exempt
          ? { orgId: org.id, planId: vip?.id ?? pro.id, status: "ACTIVE" as const }
          : {
              orgId: org.id,
              planId: pro.id,
              status: "TRIALING" as const,
              currentPeriodEnd: trialEnd,
            };
      }),
      // Two instances sweeping at once would otherwise collide on orgId.
      skipDuplicates: true,
    });
    return created.count;
  }
}
