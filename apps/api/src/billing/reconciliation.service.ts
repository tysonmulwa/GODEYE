import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { env } from "../common/env";
import { httpRequest, TIMEOUTS } from "../common/http-client";
import { LeaderLock } from "../common/leader-lock";
import { PrismaService } from "../common/prisma.service";

/**
 * Daily comparison of Paystack's record against ours.
 *
 * Idempotency (S-8) stops one payment being credited twice. It does nothing
 * about a payment that was never credited at all — a webhook Paystack gave up
 * retrying, a deploy that restarted mid-request, a customer who closed the tab
 * before the return trip. Those are silent: the money moved and the workspace
 * is still locked, and the first anyone hears is a support ticket.
 *
 * So money gets reconciliation as well as idempotency. This reads back what the
 * provider says happened and reports anything we do not have a
 * `PaymentApplication` row for.
 *
 * It deliberately **reports** rather than repairs. Automatically granting a
 * plan from a transaction this system never processed is exactly the operation
 * that should have a human in it — the divergence might be a payment we missed,
 * or it might be a payment that belongs to a different environment sharing the
 * same Paystack account.
 */

const DAY_MS = 24 * 3600 * 1000;
/** Two days of overlap, so a transaction near a boundary is never missed. */
const LOOKBACK_MS = 2 * DAY_MS;

interface PaystackTransaction {
  id?: number | string;
  reference?: string;
  status?: string;
  amount?: number;
  currency?: string;
  paid_at?: string;
  metadata?: { orgId?: string; planCode?: string } | null;
}

@Injectable()
export class BillingReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Tests drive reconcile() directly; a timer there would outlive the suite.
    if (env.nodeEnv === "test") return;
    if (!env.paystack.secretKey) {
      this.logger.warn("Payments are not configured; reconciliation is not scheduled");
      return;
    }
    this.timer = setInterval(() => void this.runAsLeader(), DAY_MS);
    this.timer.unref?.();
    // A first pass shortly after boot, so a deploy is also a check.
    setTimeout(() => void this.runAsLeader(), 5 * 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runAsLeader(): Promise<void> {
    await LeaderLock.runExclusively("billing-reconciliation", 10 * 60_000, async () => {
      try {
        const report = await this.reconcile();
        if (report.missing.length) {
          // ERROR, not WARN: somebody paid and did not get what they paid for.
          this.logger.error(
            `Reconciliation found ${report.missing.length} successful Paystack ` +
              `transaction(s) with no PaymentApplication row: ${report.missing.join(", ")}`,
          );
        } else {
          this.logger.log(`Reconciliation clean: ${report.checked} transaction(s) checked`);
        }
      } catch (e) {
        this.logger.error(
          `Reconciliation failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
  }

  /**
   * Compare the provider's successful transactions in the lookback window
   * against our own records. Returns what is missing; changes nothing.
   */
  async reconcile(now: Date = new Date()): Promise<{ checked: number; missing: string[] }> {
    const from = new Date(now.getTime() - LOOKBACK_MS).toISOString();
    const params = new URLSearchParams({ status: "success", from, perPage: "200" });

    const res = await httpRequest(`https://api.paystack.co/transaction?${params}`, {
      headers: { Authorization: `Bearer ${env.paystack.secretKey}` },
      timeoutMs: TIMEOUTS.paystack,
      retries: 2, // read-only, so retrying is safe
      upstream: "paystack",
    });
    if (!res.ok) {
      throw new Error(`Paystack transaction list returned ${res.status}`);
    }
    const body = (await res.json()) as { data?: PaystackTransaction[] };
    const transactions = (body.data ?? []).filter(
      (t) => t.status === "success" && typeof t.reference === "string",
    );
    if (!transactions.length) return { checked: 0, missing: [] };

    const references = transactions.map((t) => t.reference as string);
    const known = await this.prisma.paymentApplication.findMany({
      where: { provider: "paystack", reference: { in: references } },
      select: { reference: true },
      // `references` is already capped at Paystack's page size; this bounds the
      // query even if that ever changes underneath us.
      take: 500,
    });
    const seen = new Set(known.map((k) => k.reference));

    return {
      checked: transactions.length,
      // Only transactions that name a workspace: a payment carrying no orgId
      // was never ours to apply, and reporting it every day would train whoever
      // reads this to ignore it.
      missing: transactions
        .filter((t) => !seen.has(t.reference as string) && t.metadata?.orgId)
        .map((t) => t.reference as string),
    };
  }
}
