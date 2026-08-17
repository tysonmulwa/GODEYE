import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { BillingService } from "./billing.module";

const FREE_PLAN = {
  id: "plan-free",
  code: "PRO",
  name: "Free",
  priceMonthlyUsd: { toString: () => "0" },
  limits: { postsPerMonth: 30, aiTokensPerMonth: 100_000, connections: 3, seats: 1 },
};

function makePrisma() {
  return {
    subscription: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    plan: {
      findUnique: jest.fn().mockResolvedValue(FREE_PLAN),
      findMany: jest.fn().mockResolvedValue([FREE_PLAN]),
    },
    scheduledPost: { count: jest.fn().mockResolvedValue(0) },
    agentRun: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { inputTokens: 0, outputTokens: 0 } }),
    },
    socialConnection: { count: jest.fn().mockResolvedValue(0) },
    membership: { count: jest.fn().mockResolvedValue(1) },
    invitation: { count: jest.fn().mockResolvedValue(0) },
  };
}

describe("BillingService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new BillingService(
      prisma as never,
      { log: jest.fn() } as unknown as AuditService,
    );
  });

  it("falls back to the FREE plan when there is no subscription", async () => {
    const overview = await service.overview("org1");
    expect(overview.plan.code).toBe("PRO");
    expect(overview.limits.postsPerMonth).toBe(30);
    expect(overview.stripeConfigured).toBe(false);
  });

  it("treats a CANCELED subscription as FREE", async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      status: "CANCELED",
      plan: { ...FREE_PLAN, code: "PRO" },
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
    prisma.scheduledPost.count.mockResolvedValue(30); // at the FREE cap
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

  it("refuses checkout when Stripe is not configured", async () => {
    await expect(service.checkout("org1", "user1", "PRO")).rejects.toThrow(BadRequestException);
  });

  it("activates a subscription from checkout.session.completed", async () => {
    prisma.plan.findUnique.mockResolvedValue({ ...FREE_PLAN, id: "plan-pro", code: "PRO" });
    await service.handleStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "org1",
          metadata: { orgId: "org1", planCode: "PRO" },
          customer: "cus_1",
          subscription: "sub_1",
        },
      },
    });
    expect(prisma.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org1" },
        create: expect.objectContaining({ planId: "plan-pro", status: "ACTIVE" }),
      }),
    );
  });

  it("rejects webhook payloads with a bad signature", () => {
    expect(service.verifyStripeSignature(Buffer.from("{}"), "t=1,v1=deadbeef")).toBe(false);
    expect(service.verifyStripeSignature(undefined, undefined)).toBe(false);
  });
});
