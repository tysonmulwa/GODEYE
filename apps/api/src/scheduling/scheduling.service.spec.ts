import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { EngineService } from "../engine/engine.service";
import { SchedulingService } from "./scheduling.service";

function makePrisma() {
  return {
    contentItem: {
      findFirst: jest.fn(),
      update: jest.fn().mockReturnValue({ then: undefined }),
    },
    organization: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ requireApproval: false }),
    },
    socialConnection: { findMany: jest.fn() },
    scheduledPost: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    analyticsSnapshot: { findMany: jest.fn().mockResolvedValue([]) },
    postingPlan: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

describe("SchedulingService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: SchedulingService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const future = new Date(Date.now() + 3600_000).toISOString();

  const engine = { bestTimes: jest.fn(), validateX: jest.fn() } as unknown as EngineService;
  const billing = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    prisma = makePrisma();
    billing.assertWithinLimit.mockClear();
    service = new SchedulingService(
      prisma as never,
      audit,
      engine,
      billing as unknown as BillingService,
    );
  });

  it("creates one scheduled post per connection", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1" });
    prisma.socialConnection.findMany.mockResolvedValue([
      { id: "conn1" },
      { id: "conn2" },
    ]);
    prisma.scheduledPost.create.mockImplementation(({ data }: never) =>
      Promise.resolve({ id: "sp", ...(data as object) }),
    );
    prisma.contentItem.update.mockResolvedValue({});

    await service.schedule("org1", "user1", {
      contentItemId: "content1",
      connectionIds: ["conn1", "conn2"],
      scheduledAt: future,
      timezone: "UTC",
    });

    expect(prisma.scheduledPost.create).toHaveBeenCalledTimes(2);
    expect(prisma.contentItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SCHEDULED" } }),
    );
  });

  it("rejects scheduling in the past", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1" });
    await expect(
      service.schedule("org1", "user1", {
        contentItemId: "content1",
        connectionIds: ["conn1"],
        scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
        timezone: "UTC",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects unknown content", async () => {
    prisma.contentItem.findFirst.mockResolvedValue(null);
    await expect(
      service.schedule("org1", "user1", {
        contentItemId: "nope",
        connectionIds: ["conn1"],
        scheduledAt: future,
        timezone: "UTC",
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects inactive or foreign connections", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1" });
    prisma.socialConnection.findMany.mockResolvedValue([{ id: "conn1" }]); // asked for 2
    await expect(
      service.schedule("org1", "user1", {
        contentItemId: "content1",
        connectionIds: ["conn1", "conn-other-org"],
        scheduledAt: future,
        timezone: "UTC",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("blocks scheduling unapproved content when the org requires approval", async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({ requireApproval: true });
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1", status: "DRAFT" });
    await expect(
      service.schedule("org1", "user1", {
        contentItemId: "content1",
        connectionIds: ["conn1"],
        scheduledAt: future,
        timezone: "UTC",
      }),
    ).rejects.toThrow(/requires approval/);
    expect(prisma.scheduledPost.create).not.toHaveBeenCalled();
  });

  it("schedules APPROVED content when the org requires approval", async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({ requireApproval: true });
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1", status: "APPROVED" });
    prisma.socialConnection.findMany.mockResolvedValue([{ id: "conn1" }]);
    prisma.scheduledPost.create.mockImplementation(({ data }: never) =>
      Promise.resolve({ id: "sp", ...(data as object) }),
    );
    prisma.contentItem.update.mockResolvedValue({});

    await service.schedule("org1", "user1", {
      contentItemId: "content1",
      connectionIds: ["conn1"],
      scheduledAt: future,
      timezone: "UTC",
    });
    expect(prisma.scheduledPost.create).toHaveBeenCalledTimes(1);
  });

  it("only cancels PENDING posts", async () => {
    prisma.scheduledPost.findFirst.mockResolvedValue({ id: "sp1", status: "PUBLISHED" });
    await expect(service.cancel("org1", "sp1", "user1")).rejects.toThrow(BadRequestException);
  });

  it("assigns A/B variant keys alternately when content has abVariants", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({
      id: "content1",
      abVariants: { A: { body: "a" }, B: { body: "b" } },
    });
    prisma.socialConnection.findMany.mockResolvedValue([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
    ]);
    prisma.scheduledPost.create.mockImplementation(({ data }: never) =>
      Promise.resolve({ id: "sp", ...(data as object) }),
    );
    prisma.contentItem.update.mockResolvedValue({});

    await service.schedule("org1", "user1", {
      contentItemId: "content1",
      connectionIds: ["c1", "c2", "c3"],
      scheduledAt: future,
      timezone: "UTC",
    });

    const keys = prisma.scheduledPost.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { variantKey: string | null } }).data.variantKey,
    );
    expect(keys).toEqual(["A", "B", "A"]);
  });

  it("computes an A/B report with a winner", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "content1" });
    prisma.scheduledPost.findMany.mockResolvedValue([
      { id: "spA", variantKey: "A", status: "PUBLISHED" },
      { id: "spB", variantKey: "B", status: "PUBLISHED" },
    ]);
    prisma.analyticsSnapshot.findMany.mockResolvedValue([
      { value: 100, dimensions: { scheduledPostId: "spB" }, capturedAt: new Date() },
      { value: 10, dimensions: { scheduledPostId: "spA" }, capturedAt: new Date() },
    ]);

    const report = await service.abReport("org1", "content1");
    expect(report.winner).toBe("B");
    const varA = report.variants.find((v) => v.variant === "A");
    expect(varA?.avgEngagement).toBe(10);
  });
});
