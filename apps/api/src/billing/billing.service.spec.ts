import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { env } from "../common/env";
import { resetBreakers } from "../common/http-client";
import { BillingService } from "./billing.module";
import { WorkspaceAccessService } from "./workspace-access.service";

const ENTRY_PLAN = {
  id: "plan-pro",
  code: "PRO",
  name: "Pro",
  priceMonthlyUsd: { toString: () => "19" },
  limits: { postsPerMonth: 30, aiTokensPerMonth: 100_000, connections: 3, seats: 1 },
};

/** A stand-in for the (provider, reference) unique index, so a duplicate throws
 *  P2002 exactly as Postgres would. */
function makePaymentApplications() {
  const seen = new Set<string>();
  return {
    seen,
    create: jest.fn(async ({ data }: { data: { provider?: string; reference: string } }) => {
      const key = `${data.provider ?? "paystack"}:${data.reference}`;
      if (seen.has(key)) {
        const error = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        throw error;
      }
      seen.add(key);
      return { id: `pa_${seen.size}`, ...data };
    }),
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => null),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };
}

function makePrisma() {
  const applications = makePaymentApplications();
  return {
    /** Runs the callback against this same fake, which is what a real
     *  interactive transaction does with `tx`. */
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaRef.current)),
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    plan: {
      findUnique: jest.fn().mockResolvedValue(ENTRY_PLAN),
      findMany: jest.fn().mockResolvedValue([ENTRY_PLAN]),
    },
    scheduledPost: { count: jest.fn().mockResolvedValue(0) },
    agentRun: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { inputTokens: 0, outputTokens: 0 } }),
    },
    socialConnection: { count: jest.fn().mockResolvedValue(0) },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    /**
     * The idempotency marker (S-8), with its unique constraint modelled.
     *
     * The old fake was an AuditLog row that could be written twice without
     * complaint, so "credits a payment once" passed on a mechanism that did not
     * exist. A fake that cannot fail the way the database fails is not a test of
     * idempotency — it is a test of the happy path with an extra step.
     */
    paymentApplication: applications,
    membership: { count: jest.fn().mockResolvedValue(1) },
    invitation: { count: jest.fn().mockResolvedValue(0) },
    user: { findUnique: jest.fn().mockResolvedValue({ email: "jane@acme.com" }) },
  };
}

/** `$transaction` needs to hand the callback the same fake it lives on, and the
 *  object does not exist until makePrisma returns. */
const prismaRef: { current: unknown } = { current: null };

describe("BillingService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let access: { state: jest.Mock; invalidate: jest.Mock };
  let service: BillingService;

  beforeEach(() => {
    // The circuit breaker in http-client is module-global, which is right in a
    // process and wrong across tests: five deliberate Paystack failures in one
    // test would otherwise open the circuit for every test after it.
    resetBreakers();
    prisma = makePrisma();
    prismaRef.current = prisma;
    access = {
      state: jest.fn().mockResolvedValue({
        status: "TRIALING",
        locked: false,
        trialEndsAt: "2026-01-02T00:00:00.000Z",
        planCode: "PRO",
      }),
      invalidate: jest.fn(),
    };
    service = new BillingService(
      prisma as never,
      { log: jest.fn() } as unknown as AuditService,
      access as unknown as WorkspaceAccessService,
    );
  });

  it("falls back to the entry plan when there is no subscription", async () => {
    const overview = await service.overview("org1");
    expect(overview.plan.code).toBe("PRO");
    expect(overview.limits.postsPerMonth).toBe(30);
    expect(overview.paymentsConfigured).toBe(false);
  });

  it("reports the trial clock with the overview", async () => {
    const overview = await service.overview("org1");
    expect(overview.access).toEqual(
      expect.objectContaining({ status: "TRIALING", trialEndsAt: "2026-01-02T00:00:00.000Z" }),
    );
  });

  it("treats a CANCELED subscription as the entry plan", async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      status: "CANCELED",
      plan: ENTRY_PLAN,
    });
    const overview = await service.overview("org1");
    expect(overview.plan.code).toBe("PRO");
  });

  it("counts pending invites toward seats", async () => {
    prisma.membership.count.mockResolvedValue(1);
    prisma.invitation.count.mockResolvedValue(2);
    const usage = await service.usage("org1");
    expect(usage.seats).toBe(3);
  });

  it("blocks when a metric would exceed the plan limit", async () => {
    prisma.scheduledPost.count.mockResolvedValue(30); // at the entry cap
    await expect(service.assertWithinLimit("org1", "postsPerMonth")).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.assertWithinLimit("org1", "postsPerMonth")).rejects.toThrow(
      /Upgrade your plan/,
    );
  });

  it("allows usage under the limit", async () => {
    prisma.scheduledPost.count.mockResolvedValue(10);
    await expect(service.assertWithinLimit("org1", "postsPerMonth", 3)).resolves.toBeUndefined();
  });

  it("aiTokens gate with count 0 blocks only once the budget is spent", async () => {
    prisma.agentRun.aggregate.mockResolvedValue({
      _sum: { inputTokens: 60_000, outputTokens: 39_000 },
    });
    await expect(service.assertWithinLimit("org1", "aiTokensPerMonth", 0)).resolves.toBeUndefined();
    prisma.agentRun.aggregate.mockResolvedValue({
      _sum: { inputTokens: 60_000, outputTokens: 41_000 },
    });
    await expect(service.assertWithinLimit("org1", "aiTokensPerMonth", 0)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses checkout when Paystack is not configured", async () => {
    await expect(service.checkout("org1", "user1", "PRO")).rejects.toThrow(BadRequestException);
    await expect(service.checkout("org1", "user1", "PRO")).rejects.toThrow(/PAYSTACK_SECRET_KEY/);
  });

  describe("checkout against Paystack", () => {
    const realFetch = global.fetch;
    const realKey = env.paystack.secretKey;
    const realPlan = env.paystack.plans.PRO;

    /** The plan, then the transaction, in the order checkout calls them. */
    const respond = (...bodies: unknown[]) => {
      const fetchMock = jest.fn();
      for (const body of bodies) {
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
      }
      global.fetch = fetchMock as never;
      return fetchMock;
    };

    beforeEach(() => {
      env.paystack.secretKey = "sk_test_checkout";
      env.paystack.plans.PRO = "PLN_pro_code";
    });

    afterEach(() => {
      global.fetch = realFetch;
      env.paystack.secretKey = realKey;
      env.paystack.plans.PRO = realPlan;
    });

    it("bills the plan's own amount and currency, not a figure of our own", async () => {
      const fetchMock = respond(
        { status: true, data: { amount: 1900, currency: "KES", interval: "monthly" } },
        { status: true, data: { authorization_url: "https://checkout.paystack.com/abc" } },
      );

      await expect(service.checkout("org1", "user1", "PRO")).resolves.toEqual({
        url: "https://checkout.paystack.com/abc",
        reference: null,
      });

      // The plan is read first. Paystack answers "Invalid Amount Sent" to an
      // initialize that carries no amount, however valid the plan code is.
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.paystack.co/plan/PLN_pro_code");
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body).toEqual(
        expect.objectContaining({
          plan: "PLN_pro_code",
          amount: 1900,
          currency: "KES",
          email: "jane@acme.com",
          metadata: {
            orgId: "org1",
            planCode: "PRO",
            userId: "user1",
            method: "card",
            mode: "subscription",
          },
        }),
      );
    });

    it("names the variable to fix when Paystack does not know the plan code", async () => {
      respond({ status: false, message: "Plan not found" });
      await expect(service.checkout("org1", "user1", "PRO")).rejects.toThrow(
        /PAYSTACK_PLAN_PRO/,
      );
    });

    it("treats a zero-amount plan as unusable rather than charging nothing", async () => {
      respond({ status: true, data: { amount: 0, currency: "KES" } });
      await expect(service.checkout("org1", "user1", "PRO")).rejects.toThrow(BadRequestException);
    });

    it("omits the currency when Paystack states none", async () => {
      const fetchMock = respond(
        { status: true, data: { amount: 4900 } },
        { status: true, data: { authorization_url: "https://checkout.paystack.com/xyz" } },
      );
      await service.checkout("org1", "user1", "PRO");
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("currency");
    });
  });

  it("activates a subscription from a Paystack charge.success", async () => {
    await service.handlePaystackEvent({
      event: "charge.success",
      data: {
        reference: "ref_1",
        subscription_code: "SUB_1",
        next_payment_date: "2026-09-01T00:00:00.000Z",
        customer: { customer_code: "CUS_1" },
        metadata: { orgId: "org1", planCode: "PRO" },
      },
    });
    expect(prisma.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org1" },
        create: expect.objectContaining({ planId: "plan-pro", status: "ACTIVE" }),
      }),
    );
    const args = prisma.subscription.upsert.mock.calls[0][0];
    expect(args.update.providerCustomerId).toBe("CUS_1");
    expect(args.update.providerSubscriptionId).toBe("SUB_1");
    expect(args.update.currentPeriodEnd).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    // The workspace is paying now, it must not wait out a cached lock decision.
    expect(access.invalidate).toHaveBeenCalledWith("org1");
  });

  it("ignores a payment whose metadata names no workspace", async () => {
    await service.handlePaystackEvent({
      event: "charge.success",
      data: { reference: "ref_2", metadata: {} },
    });
    expect(prisma.subscription.upsert).not.toHaveBeenCalled();
  });

  it("cancels the subscription a disable event names", async () => {
    prisma.subscription.findFirst.mockResolvedValue({ id: "sub1", orgId: "org1" });
    await service.handlePaystackEvent({
      event: "subscription.disable",
      data: { subscription_code: "SUB_1" },
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: "sub1" },
      data: { status: "CANCELED" },
    });
    expect(access.invalidate).toHaveBeenCalledWith("org1");
  });

  describe("a month bought outright", () => {
    const realFetch = global.fetch;
    const realKey = env.paystack.secretKey;

    beforeEach(() => {
      env.paystack.secretKey = "sk_test_checkout";
    });
    afterEach(() => {
      global.fetch = realFetch;
      env.paystack.secretKey = realKey;
    });

    const started = () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/once" },
        }),
      });
      global.fetch = fetchMock as never;
      return fetchMock;
    };

    it("charges M-Pesa in shillings, because it settles in nothing else", async () => {
      const fetchMock = started();
      await service.checkout("org1", "user1", "PRO", "mpesa");

      // One call only: a one-off never reads the Paystack plan, because it is
      // not using one.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.amount).toBe(245100); // 2,451 KES in subunits
      expect(body.currency).toBe("KES");
      expect(body.plan).toBeUndefined();
      expect(body.channels).toEqual(["mobile_money"]);
      expect(body.metadata).toEqual({
        orgId: "org1",
        planCode: "PRO",
        userId: "user1",
        method: "mpesa",
        mode: "once",
      });
    });

    it("charges Apple Pay in dollars, the price the rest of the product quotes", async () => {
      const fetchMock = started();
      await service.checkout("org1", "user1", "PRO", "apple_pay");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.amount).toBe(1900);
      expect(body.currency).toBe("USD");
      expect(body.channels).toEqual(["apple_pay"]);
    });

    it("opens the sheet on the one method chosen, not a list to choose again", async () => {
      const fetchMock = started();
      await service.checkout("org1", "user1", "VIP", "apple_pay");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).channels).toHaveLength(1);
    });

    it("never puts a wallet on a plan, which would take money and not renew", async () => {
      const fetchMock = started();
      await service.checkout("org1", "user1", "VIP", "mpesa");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).plan).toBeUndefined();
    });

    it("refuses a method the server has turned off", async () => {
      const real = env.paystack.methods;
      env.paystack.methods = ["card"];
      try {
        await expect(service.checkout("org1", "user1", "PRO", "mpesa")).rejects.toThrow(
          /not available/,
        );
      } finally {
        env.paystack.methods = real;
      }
    });

    it("grants a month from now, and leaves no subscription code behind", async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      const before = Date.now();

      await service.handlePaystackEvent({
        event: "charge.success",
        data: {
          reference: "ref_once",
          customer: { customer_code: "CUS_1" },
          metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
        },
      });

      const args = prisma.subscription.upsert.mock.calls[0][0];
      expect(args.update.status).toBe("ACTIVE");
      // Null is what tells the guard this month ends rather than renews.
      expect(args.update.providerSubscriptionId).toBeNull();
      const days = (args.update.currentPeriodEnd.getTime() - before) / (24 * 3600 * 1000);
      expect(days).toBeGreaterThan(30.9);
      expect(days).toBeLessThan(31.1);
    });

    it("adds a month to one already paid for, rather than restarting it", async () => {
      // Paying a week early must buy a month, not throw the week away.
      const weekAway = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      prisma.subscription.findUnique.mockResolvedValue({ currentPeriodEnd: weekAway });

      await service.handlePaystackEvent({
        event: "charge.success",
        // A reference is now required: without one there is nothing to be
        // idempotent on, and a retry would credit the month again (S-8).
        data: { reference: "ref_early", metadata: { orgId: "org1", planCode: "PRO", mode: "once" } },
      });

      const { currentPeriodEnd } = prisma.subscription.upsert.mock.calls[0][0].update;
      const days = (currentPeriodEnd.getTime() - weekAway.getTime()) / (24 * 3600 * 1000);
      expect(days).toBeGreaterThan(30.9);
      expect(days).toBeLessThan(31.1);
    });

    it("still records a card subscription's own renewal date", async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      await service.handlePaystackEvent({
        event: "subscription.create",
        data: {
          reference: "ref_sub_1",
          subscription_code: "SUB_1",
          next_payment_date: "2026-09-17T00:00:00.000Z",
          metadata: { orgId: "org1", planCode: "PRO", mode: "subscription" },
        },
      });
      const { update } = prisma.subscription.upsert.mock.calls[0][0];
      expect(update.providerSubscriptionId).toBe("SUB_1");
      expect(update.currentPeriodEnd).toEqual(new Date("2026-09-17T00:00:00.000Z"));
    });
  });

  describe("confirming a payment without waiting for the webhook", () => {
    const realFetch = global.fetch;
    const realKey = env.paystack.secretKey;

    const paystackSays = (data: unknown) => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: true, data }),
      });
      global.fetch = fetchMock as never;
      return fetchMock;
    };

    beforeEach(() => {
      env.paystack.secretKey = "sk_test_verify";
    });
    afterEach(() => {
      global.fetch = realFetch;
      env.paystack.secretKey = realKey;
    });

    it("activates the plan the customer just paid for", async () => {
      const fetchMock = paystackSays({
        status: "success",
        reference: "ref_live_1",
        subscription_code: "SUB_9",
        customer: { customer_code: "CUS_9" },
        metadata: { orgId: "org1", planCode: "PRO", mode: "subscription" },
      });

      await expect(service.verifyPayment("org1", "ref_live_1")).resolves.toEqual({
        applied: true,
        status: "success",
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.paystack.co/transaction/verify/ref_live_1",
      );
      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ status: "ACTIVE" }) }),
      );
      expect(access.invalidate).toHaveBeenCalledWith("org1");
    });

    it("credits a payment once, however many times it is confirmed", async () => {
      // The webhook and the customer's return trip race each other on purpose.
      // A one-off adds a month, so crediting the same reference twice would
      // hand out a month nobody paid for.
      //
      // The refusal now comes from the DATABASE — a unique violation on the
      // marker — rather than from a prior read that another caller could have
      // been between. Previously this test primed `auditLog.findFirst`, i.e. it
      // asserted the read-then-write that WAS the race.
      paystackSays({
        status: "success",
        reference: "ref_live_1",
        metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
      });

      await expect(service.verifyPayment("org1", "ref_live_1")).resolves.toEqual({
        applied: true,
        status: "success",
      });
      expect(prisma.subscription.upsert).toHaveBeenCalledTimes(1);

      // Second confirmation of the same reference: refused, nothing extended.
      await expect(service.verifyPayment("org1", "ref_live_1")).resolves.toEqual({
        applied: false,
        status: "success",
      });
      expect(prisma.subscription.upsert).toHaveBeenCalledTimes(1);
    });

    it("writes the idempotency marker BEFORE it touches the subscription", async () => {
      // Order is the whole fix. The old code extended the period first and then
      // tried to record that it had, leaving a window in which a second caller
      // saw no marker but read the already-extended currentPeriodEnd.
      paystackSays({
        status: "success",
        reference: "ref_order",
        metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
      });
      await service.verifyPayment("org1", "ref_order");

      const markerAt = prisma.paymentApplication.create.mock.invocationCallOrder[0];
      const upsertAt = prisma.subscription.upsert.mock.invocationCallOrder[0];
      expect(markerAt).toBeLessThan(upsertAt);
    });

    it("does not swallow a marker write that fails for any other reason", async () => {
      // `.catch(() => undefined)` on this write meant a transient database error
      // silently removed the idempotency record, and Paystack's retry then
      // credited the customer a second time.
      prisma.paymentApplication.create.mockRejectedValueOnce(new Error("connection reset"));
      paystackSays({
        status: "success",
        reference: "ref_boom",
        metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
      });

      await expect(service.verifyPayment("org1", "ref_boom")).rejects.toThrow(/connection reset/);
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it("refuses a payment with no reference rather than crediting it unguarded", async () => {
      paystackSays({
        status: "success",
        metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
      });
      await expect(service.verifyPayment("org1", "ref_missing")).resolves.toEqual({
        applied: false,
        status: "success",
      });
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it("records the reference so the second attempt can see it", async () => {
      paystackSays({
        status: "success",
        reference: "ref_live_2",
        metadata: { orgId: "org1", planCode: "PRO", mode: "once" },
      });
      await service.verifyPayment("org1", "ref_live_2");
      // The marker, which is the constraint. The audit row still happens too,
      // but it is a record of what occurred, not the thing that decides.
      expect(prisma.paymentApplication.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ provider: "paystack", reference: "ref_live_2" }),
        }),
      );
    });

    it("refuses to activate a plan from another workspace's payment", async () => {
      // A reference is not a secret, so knowing one must not buy anything.
      paystackSays({
        status: "success",
        reference: "ref_live_3",
        metadata: { orgId: "someone-else", planCode: "VIP", mode: "once" },
      });
      await expect(service.verifyPayment("org1", "ref_live_3")).rejects.toThrow(
        /belongs to another workspace/,
      );
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it("changes nothing when the payment did not succeed", async () => {
      paystackSays({
        status: "abandoned",
        reference: "ref_live_4",
        metadata: { orgId: "org1", planCode: "PRO" },
      });
      await expect(service.verifyPayment("org1", "ref_live_4")).resolves.toEqual({
        applied: false,
        status: "abandoned",
      });
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });
  });

  it("rejects webhook payloads with a bad signature", () => {
    expect(service.verifyPaystackSignature(Buffer.from("{}"), "deadbeef")).toBe(false);
    expect(service.verifyPaystackSignature(undefined, undefined)).toBe(false);
  });
});
