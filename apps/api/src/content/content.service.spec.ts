import { BadRequestException } from "@nestjs/common";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { EngineService } from "../engine/engine.service";
import { ContentService } from "./content.service";

function makePrisma() {
  return {
    contentItem: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    scheduledPost: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

describe("ContentService approval workflow", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ContentService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ContentService(
      prisma as never,
      {} as EngineService,
      { log: jest.fn() } as unknown as AuditService,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as unknown as BillingService,
    );
    prisma.contentItem.update.mockImplementation(({ data }: never) =>
      Promise.resolve({
        id: "c1",
        type: "SOCIAL_POST",
        title: null,
        body: "post",
        hashtags: [],
        variants: null,
        aiGenerated: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(data as object),
      }),
    );
  });

  it("submits a DRAFT for review and clears any previous verdict", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "c1", status: "DRAFT" });
    const dto = await service.submitForReview("org1", "user1", "c1");
    expect(dto.status).toBe("PENDING_APPROVAL");
    const data = prisma.contentItem.update.mock.calls[0][0].data;
    expect(data.submittedById).toBe("user1");
    expect(data.reviewNote).toBeNull();
  });

  it("refuses to submit non-draft content", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "c1", status: "PUBLISHED" });
    await expect(service.submitForReview("org1", "user1", "c1")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("approves only PENDING_APPROVAL content", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "c1", status: "PENDING_APPROVAL" });
    const dto = await service.approve("org1", "admin1", "c1");
    expect(dto.status).toBe("APPROVED");

    prisma.contentItem.findFirst.mockResolvedValue({ id: "c1", status: "DRAFT" });
    await expect(service.approve("org1", "admin1", "c1")).rejects.toThrow(BadRequestException);
  });

  it("rejecting returns content to DRAFT with the note and cancels pending posts", async () => {
    prisma.contentItem.findFirst.mockResolvedValue({ id: "c1", status: "PENDING_APPROVAL" });
    const dto = await service.reject("org1", "admin1", "c1", "tone is off-brand");
    expect(dto.status).toBe("DRAFT");
    expect(dto.reviewNote).toBe("tone is off-brand");
    expect(prisma.scheduledPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentItemId: "c1", status: "PENDING" }),
        data: { status: "CANCELLED" },
      }),
    );
  });
});
