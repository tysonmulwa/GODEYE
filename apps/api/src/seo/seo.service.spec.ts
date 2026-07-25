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
  };
}

describe("SeoService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let engine: { enqueueSeoAudit: jest.Mock };
  let service: SeoService;
  const audit = { log: jest.fn() } as unknown as AuditService;

  beforeEach(() => {
    prisma = makePrisma();
    engine = { enqueueSeoAudit: jest.fn().mockResolvedValue({ taskId: "task1" }) };
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
});
