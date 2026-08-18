import { WorkspaceAccessService } from "./workspace-access.service";

const HOUR = 3600 * 1000;

function makePrisma() {
  return {
    organization: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    subscription: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    plan: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { code: string } }) =>
        Promise.resolve({ id: `plan-${where.code.toLowerCase()}` }),
      ),
    },
  };
}

/**
 * An org row shaped the way `state()` selects it.
 *
 * `subscriptionCode` is the load-bearing one: present means a card Paystack can
 * charge again, absent means a month bought with a wallet that simply ends.
 */
function orgRow(
  slug: string,
  sub: {
    status: string;
    currentPeriodEnd: Date | null;
    code?: string;
    subscriptionCode?: string | null;
  } | null,
) {
  return {
    slug,
    subscription: sub
      ? {
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          providerSubscriptionId: sub.subscriptionCode ?? null,
          plan: { code: sub.code ?? "PRO" },
        }
      : null,
  };
}

describe("WorkspaceAccessService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: WorkspaceAccessService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new WorkspaceAccessService(prisma as never);
  });

  describe("startTrial", () => {
    it("records a TRIALING subscription ending 24 hours out", async () => {
      const before = Date.now();
      const endsAt = await service.startTrial("org1");

      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: "org1" },
          create: expect.objectContaining({ planId: "plan-pro", status: "TRIALING" }),
        }),
      );
      const { create } = prisma.subscription.upsert.mock.calls[0][0];
      expect(create.currentPeriodEnd.getTime() - before).toBeGreaterThanOrEqual(24 * HOUR - 1000);
      expect(create.currentPeriodEnd.getTime() - before).toBeLessThanOrEqual(24 * HOUR + 1000);
      expect(endsAt).toEqual(create.currentPeriodEnd);
    });

    it("leaves an existing subscription alone, so nobody gets a second trial", async () => {
      await service.startTrial("org1");
      expect(prisma.subscription.upsert.mock.calls[0][0].update).toEqual({});
    });

    it("never breaks registration when the plans are not seeded", async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expect(service.startTrial("org1")).resolves.toBeNull();
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });
  });

  describe("state", () => {
    it("keeps a running trial writing", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "TRIALING", currentPeriodEnd: new Date(Date.now() + HOUR) }),
      );
      const state = await service.state("org1");
      expect(state.status).toBe("TRIALING");
      expect(state.locked).toBe(false);
      expect(state.trialEndsAt).not.toBeNull();
    });

    it("locks the moment the trial runs out, without waiting for the sweeper", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "TRIALING", currentPeriodEnd: new Date(Date.now() - 1000) }),
      );
      const state = await service.state("org1");
      expect(state.status).toBe("LOCKED");
      expect(state.locked).toBe(true);
    });

    it("locks a subscription the sweeper has already marked PAST_DUE", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "PAST_DUE", currentPeriodEnd: new Date(Date.now() - HOUR) }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ status: "LOCKED", locked: true }),
      );
    });

    it("locks a cancelled subscription", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "CANCELED", currentPeriodEnd: null }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ locked: true }),
      );
    });

    it("never locks a paying workspace", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "ACTIVE", currentPeriodEnd: null, code: "PREMIUM" }),
      );
      const state = await service.state("org1");
      expect(state).toEqual(
        expect.objectContaining({ status: "ACTIVE", locked: false, planCode: "PREMIUM" }),
      );
    });

    it("locks a bought month once it runs out, because nothing renews it", async () => {
      // M-Pesa and Apple Pay leave no reusable authorisation, so the month the
      // customer paid for is the whole of what they bought.
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", {
          status: "ACTIVE",
          currentPeriodEnd: new Date(Date.now() - 1000),
          subscriptionCode: null,
        }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ status: "LOCKED", locked: true }),
      );
    });

    it("keeps a bought month writing until the moment it ends", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", {
          status: "ACTIVE",
          currentPeriodEnd: new Date(Date.now() + HOUR),
          subscriptionCode: null,
        }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ status: "ACTIVE", locked: false }),
      );
    });

    it("does not lock a card subscription that is past its renewal date", async () => {
      // Paystack retries a failed renewal and cancels by webhook. Locking a
      // paying customer because a webhook was slow is the worse mistake, so
      // this date is a renewal, not a deadline.
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", {
          status: "ACTIVE",
          currentPeriodEnd: new Date(Date.now() - 3 * 24 * HOUR),
          subscriptionCode: "SUB_1",
        }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ status: "ACTIVE", locked: false }),
      );
    });

    it("does not cache past the end of a bought month", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", {
          status: "ACTIVE",
          currentPeriodEnd: new Date(Date.now() + 2000),
          subscriptionCode: null,
        }),
      );
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ locked: false }),
      );

      const threeSecondsOn = Date.now() + 3000;
      jest.spyOn(Date, "now").mockReturnValue(threeSecondsOn);
      try {
        await expect(service.state("org1")).resolves.toEqual(
          expect.objectContaining({ locked: true }),
        );
      } finally {
        jest.restoreAllMocks();
      }
    });

    it.each(["godeye", "patampoa", "mjini-collection"])(
      "never locks %s, whatever its subscription says",
      async (slug) => {
        prisma.organization.findUnique.mockResolvedValue(
          orgRow(slug, { status: "PAST_DUE", currentPeriodEnd: new Date(0) }),
        );
        const state = await service.state(`org-${slug}`);
        expect(state.status).toBe("EXEMPT");
        expect(state.locked).toBe(false);
      },
    );

    it("leaves a workspace that predates the trial writing until it is backfilled", async () => {
      prisma.organization.findUnique.mockResolvedValue(orgRow("older-org", null));
      await expect(service.state("org1")).resolves.toEqual(
        expect.objectContaining({ locked: false }),
      );
    });

    it("reuses the answer rather than asking the database on every write", async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "ACTIVE", currentPeriodEnd: null }),
      );
      await service.state("org1");
      await service.state("org1");
      expect(prisma.organization.findUnique).toHaveBeenCalledTimes(1);

      service.invalidate("org1");
      await service.state("org1");
      expect(prisma.organization.findUnique).toHaveBeenCalledTimes(2);
    });

    it("does not cache a decision past the moment the trial ends", async () => {
      // Two seconds of trial left is less than the cache TTL, so the entry must
      // expire with the trial rather than outliving it.
      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "TRIALING", currentPeriodEnd: new Date(Date.now() + 2000) }),
      );
      await service.state("org1");

      prisma.organization.findUnique.mockResolvedValue(
        orgRow("acme", { status: "TRIALING", currentPeriodEnd: new Date(Date.now() - 1) }),
      );
      const threeSecondsOn = Date.now() + 3000;
      jest.spyOn(Date, "now").mockReturnValue(threeSecondsOn);
      try {
        await expect(service.state("org1")).resolves.toEqual(
          expect.objectContaining({ locked: true }),
        );
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe("sweep", () => {
    it("writes expiry down instead of leaving it to be computed forever", async () => {
      prisma.subscription.updateMany.mockResolvedValueOnce({ count: 3 });
      const now = new Date("2026-08-17T12:00:00.000Z");
      const result = await service.sweep(now);

      expect(prisma.subscription.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          status: "TRIALING",
          currentPeriodEnd: { lte: now },
          org: { slug: { notIn: ["godeye", "patampoa", "mjini-collection"] } },
        },
        data: { status: "PAST_DUE" },
      });
      expect(result.expired).toBe(3);
    });

    it("puts the workspaces GODEYE runs back to ACTIVE", async () => {
      await service.sweep(new Date());
      expect(prisma.subscription.updateMany).toHaveBeenNthCalledWith(3, {
        where: {
          org: { slug: { in: ["godeye", "patampoa", "mjini-collection"] } },
          status: { not: "ACTIVE" },
        },
        data: { status: "ACTIVE" },
      });
    });

    it("records a bought month that has run out, but not a card's renewal date", async () => {
      const now = new Date("2026-08-17T12:00:00.000Z");
      await service.sweep(now);
      expect(prisma.subscription.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          status: "ACTIVE",
          // The whole point: only where no card stands behind it. A card
          // subscription past its renewal date is Paystack's to retry.
          providerSubscriptionId: null,
          currentPeriodEnd: { lte: now },
          org: { slug: { notIn: ["godeye", "patampoa", "mjini-collection"] } },
        },
        data: { status: "PAST_DUE" },
      });
    });

    it("backfills a trial for workspaces created before trials existed", async () => {
      prisma.organization.findMany.mockResolvedValue([
        { id: "org-old", slug: "older-org" },
        { id: "org-godeye", slug: "godeye" },
      ]);
      prisma.subscription.createMany.mockResolvedValue({ count: 2 });

      const now = new Date("2026-08-17T12:00:00.000Z");
      await service.sweep(now);

      const { data, skipDuplicates } = prisma.subscription.createMany.mock.calls[0][0];
      expect(skipDuplicates).toBe(true);
      expect(data).toEqual([
        {
          orgId: "org-old",
          planId: "plan-pro",
          status: "TRIALING",
          currentPeriodEnd: new Date(now.getTime() + 24 * HOUR),
        },
        // Exempt: comped outright rather than put on a clock that would lock it.
        { orgId: "org-godeye", planId: "plan-vip", status: "ACTIVE" },
      ]);
    });

    it("is safe to run when there is nothing to do", async () => {
      await expect(service.sweep(new Date())).resolves.toEqual({
        expired: 0,
        lapsed: 0,
        backfilled: 0,
        comped: 0,
      });
      expect(prisma.subscription.createMany).not.toHaveBeenCalled();
    });
  });
});
