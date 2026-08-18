import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { productSettingsSchema } from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";
import { ProductsService } from "./products.module";

describe("ProductsService", () => {
  let service: ProductsService;
  let prisma: {
    businessProfile: { findUnique: jest.Mock; update: jest.Mock };
    product: { count: jest.Mock; findMany: jest.Mock };
  };
  let engine: { enqueueImportProducts: jest.Mock };

  beforeEach(async () => {
    prisma = {
      businessProfile: { findUnique: jest.fn(), update: jest.fn() },
      product: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn() },
    };
    engine = { enqueueImportProducts: jest.fn().mockResolvedValue({ taskId: "t1" }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EngineService, useValue: engine },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(ProductsService);
  });

  describe("consent", () => {
    it("refuses to import before the workspace has allowed it", async () => {
      prisma.businessProfile.findUnique.mockResolvedValue({
        website: "https://shop.example",
        productImportConsentAt: null,
      });
      await expect(service.importNow("org1", "user1", { limit: 40 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(engine.enqueueImportProducts).not.toHaveBeenCalled();
    });

    it("imports once consent is recorded", async () => {
      prisma.businessProfile.findUnique.mockResolvedValue({
        website: "https://shop.example",
        productImportConsentAt: new Date(),
      });
      await service.importNow("org1", "user1", { limit: 40 });
      expect(engine.enqueueImportProducts).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org1" }),
      );
    });

    it("keeps the original consent date when other settings are saved", async () => {
      // Re-saving must not look like fresh consent, the date is the record of
      // when the user actually agreed.
      const agreedAt = new Date("2026-08-01T10:00:00Z");
      prisma.businessProfile.findUnique.mockResolvedValue({
        id: "bp1",
        productImportConsentAt: agreedAt,
      });
      prisma.businessProfile.update.mockResolvedValue({});
      await service.saveSettings("org1", "user1", {
        importConsent: true,
        autoImport: true,
        autoPost: false,
        postPlatforms: [],
      });
      expect(prisma.businessProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productImportConsentAt: agreedAt }),
        }),
      );
    });

    it("clears the consent date when it is withdrawn", async () => {
      prisma.businessProfile.findUnique.mockResolvedValue({
        id: "bp1",
        productImportConsentAt: new Date(),
      });
      prisma.businessProfile.update.mockResolvedValue({});
      await service.saveSettings("org1", "user1", {
        importConsent: false,
        autoImport: false,
        autoPost: false,
        postPlatforms: [],
      });
      expect(prisma.businessProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productImportConsentAt: null }),
        }),
      );
    });
  });

  describe("settings validation", () => {
    it("will not enable auto-post with nowhere to post", () => {
      // Posting to nowhere is indistinguishable from a feature that silently
      // does not work, and this one publishes unattended.
      const result = productSettingsSchema.safeParse({
        importConsent: true,
        autoImport: true,
        autoPost: true,
        postPlatforms: [],
      });
      expect(result.success).toBe(false);
    });

    it("accepts auto-post once a destination is chosen", () => {
      const result = productSettingsSchema.safeParse({
        importConsent: true,
        autoImport: true,
        autoPost: true,
        postPlatforms: ["INSTAGRAM"],
      });
      expect(result.success).toBe(true);
    });

    it("will not schedule an import the workspace has not allowed", () => {
      const result = productSettingsSchema.safeParse({
        importConsent: false,
        autoImport: true,
        autoPost: false,
        postPlatforms: [],
      });
      expect(result.success).toBe(false);
    });
  });

  it("returns prices as strings", async () => {
    // A float price is how a rounding error reaches a customer's feed.
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        title: "Boot",
        description: null,
        price: { toString: () => "7499.00" },
        currency: "KES",
        imageUrl: null,
        availability: "InStock",
        sku: null,
        sourceUrl: "https://shop/x",
        source: "jsonld",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastPostedAt: null,
        postCount: 0,
      },
    ]);
    const [product] = await service.list("org1");
    expect(product.price).toBe("7499.00");
    expect(typeof product.price).toBe("string");
  });
});
