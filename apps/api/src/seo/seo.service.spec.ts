import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { EngineService } from "../engine/engine.service";
import { SeoService } from "./seo.module";

function makePrisma() {
  return {
    businessProfile: { findUnique: jest.fn() },
    agentRun: {
      create: jest.fn().mockResolvedValue({ id: "run1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    seoAudit: {
      create: jest.fn().mockResolvedValue({ id: "audit1" }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    seoFix: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: "fix1", status: "APPLIED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

describe("SeoService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let engine: {
    enqueueSeoAudit: jest.Mock;
    enqueueVerifySeoFixes: jest.Mock;
    submitIndexNow: jest.Mock;
    indexNowStatus: jest.Mock;
  };
  let service: SeoService;
  const audit = { log: jest.fn() } as unknown as AuditService;

  beforeEach(() => {
    prisma = makePrisma();
    engine = {
      enqueueSeoAudit: jest.fn().mockResolvedValue({ taskId: "task1" }),
      enqueueVerifySeoFixes: jest.fn().mockResolvedValue({ taskId: "task2" }),
      submitIndexNow: jest.fn().mockResolvedValue({ submitted: 2, status: "accepted" }),
      indexNowStatus: jest.fn().mockResolvedValue({ key: "k", keyFileUrl: "u", published: true }),
    };
    service = new SeoService(prisma as never, engine as unknown as EngineService, audit);
  });

  it("uses the explicit URL when provided", async () => {
    const result = await service.runAudit("org1", "user1", {
      url: "https://example.com",
      maxPages: 20,
      allowForeign: false,
    });
    expect(result).toEqual({ auditId: "audit1", agentRunId: "run1", taskId: "task1" });
    expect(engine.enqueueSeoAudit).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com", auditId: "audit1" }),
    );
  });

  it("blocks a site that isn't the org's registered website until confirmed", async () => {
    prisma.businessProfile.findUnique.mockResolvedValue({ website: "https://acme.co" });
    await expect(
      service.runAudit("org1", "user1", {
        url: "https://mjinicollection.com",
        maxPages: 20,
        allowForeign: false,
      }),
    ).rejects.toThrow(ConflictException);
    expect(engine.enqueueSeoAudit).not.toHaveBeenCalled();
  });

  it("scans a foreign site once allowForeign is set", async () => {
    prisma.businessProfile.findUnique.mockResolvedValue({ website: "https://acme.co" });
    await service.runAudit("org1", "user1", {
      url: "https://mjinicollection.com",
      maxPages: 20,
      allowForeign: true,
    });
    expect(engine.enqueueSeoAudit).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://mjinicollection.com" }),
    );
  });

  it("falls back to the business profile website", async () => {
    prisma.businessProfile.findUnique.mockResolvedValue({ website: "https://acme.co" });
    await service.runAudit("org1", "user1", { maxPages: 20 } as never);
    expect(engine.enqueueSeoAudit).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://acme.co" }),
    );
  });

  it("rejects when no URL is available anywhere", async () => {
    prisma.businessProfile.findUnique.mockResolvedValue({ website: null });
    await expect(service.runAudit("org1", "user1", { maxPages: 20 } as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("marks run and audit FAILED when the engine enqueue throws", async () => {
    engine.enqueueSeoAudit.mockRejectedValue(new Error("engine down"));
    await expect(
      service.runAudit("org1", "user1", {
        url: "https://example.com",
        maxPages: 20,
        allowForeign: false,
      }),
    ).rejects.toThrow("engine down");
    expect(prisma.seoAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("scopes artifact access to the org", async () => {
    prisma.seoAudit.findFirst.mockResolvedValue(null);
    await expect(service.getArtifact("org1", "someone-elses", "sitemap")).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.seoAudit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-elses", orgId: "org1" } }),
    );
  });

  describe("fixes", () => {
    beforeEach(() => {
      prisma.seoAudit.findFirst.mockResolvedValue({ id: "audit1", url: "https://example.com/" });
    });

    it("returns fixes worst-first, not in alphabetical severity order", async () => {
      prisma.seoFix.findMany.mockResolvedValue([
        { id: "a", severity: "info", title: "Polish" },
        { id: "b", severity: "critical", title: "Urgent" },
        { id: "c", severity: "warning", title: "Middling" },
      ]);
      const fixes = await service.listFixes("org1", "audit1");
      expect(fixes.map((f) => f.severity)).toEqual(["critical", "warning", "info"]);
    });

    it("clears a stale verification verdict when a fix is re-opened", async () => {
      prisma.seoFix.findFirst.mockResolvedValue({ id: "fix1", findingCode: "missing_title" });
      await service.updateFixStatus("org1", "fix1", "user1", "PROPOSED");
      expect(prisma.seoFix.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "PROPOSED", verifiedAt: null, error: null }),
        }),
      );
    });

    it("stamps appliedAt only when the status is APPLIED", async () => {
      prisma.seoFix.findFirst.mockResolvedValue({ id: "fix1", findingCode: "missing_title" });
      await service.updateFixStatus("org1", "fix1", "user1", "DISMISSED");
      const data = prisma.seoFix.update.mock.calls[0][0].data;
      expect(data.appliedAt).toBeNull();
    });

    it("refuses to update a fix belonging to another org", async () => {
      prisma.seoFix.findFirst.mockResolvedValue(null);
      await expect(
        service.updateFixStatus("org1", "someone-elses", "user1", "APPLIED"),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.seoFix.update).not.toHaveBeenCalled();
    });

    it("won't start a verification when nothing has been applied", async () => {
      prisma.seoFix.count.mockResolvedValue(0);
      await expect(service.verifyFixes("org1", "audit1", "user1")).rejects.toThrow(
        BadRequestException,
      );
      expect(engine.enqueueVerifySeoFixes).not.toHaveBeenCalled();
    });

    it("enqueues verification once there are applied fixes to check", async () => {
      prisma.seoFix.count.mockResolvedValue(3);
      const result = await service.verifyFixes("org1", "audit1", "user1");
      expect(result).toEqual({ taskId: "task2", checking: 3 });
    });

    it("submits only pages whose fixes were actually verified", async () => {
      prisma.seoFix.findMany.mockResolvedValue([
        { targetUrl: "https://example.com/a" },
        { targetUrl: "https://example.com/b" },
      ]);
      await service.submitIndexNow("org1", "audit1", "user1");
      expect(prisma.seoFix.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "VERIFIED" }),
        }),
      );
      expect(engine.submitIndexNow).toHaveBeenCalledWith(
        expect.objectContaining({
          urls: ["https://example.com/a", "https://example.com/b"],
        }),
      );
    });

    it("refuses to notify search engines about nothing", async () => {
      prisma.seoFix.findMany.mockResolvedValue([]);
      await expect(service.submitIndexNow("org1", "audit1", "user1")).rejects.toThrow(
        BadRequestException,
      );
      expect(engine.submitIndexNow).not.toHaveBeenCalled();
    });
  });
});
