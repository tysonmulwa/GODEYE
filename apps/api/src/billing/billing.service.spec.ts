import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { BillingService } from "./billing.module";
import { WorkspaceAccessService } from "./workspace-access.service";

const ENTRY_PLAN = {
  id: "plan-pro",
  code: "PRO",
  name: "Pro",
  priceMonthlyUsd: { toString: () => "19" },
  limits: { postsPerMonth: 30, aiTokensPerMonth: 100_000, connections: 3, seats: 1 },
};

function makePrisma() {
  return {
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
    membership: { count: jest.fn().mockResolvedValue(1) },
    invitation: { count: jest.fn().mockResolvedValue(0) },
    user: { findUnique: jest.fn().mockResolvedValue({ email: "jane@acme.com" }) },
  };
}

describe("BillingService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let access: { state: jest.Mock; invalidate: jest.Mock };
  let service: BillingService;

  beforeEach(() => {
    prisma = makePrisma();
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
    // The workspace is paying now — it must not wait out a cached lock decision.
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

  it("rejects webhook payloads with a bad signature", () => {
    expect(service.verifyPaystackSignature(Buffer.from("{}"), "deadbeef")).toBe(false);
    expect(service.verifyPaystackSignature(undefined, undefined)).toBe(false);
  });
});
