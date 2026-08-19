import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Injectable,
  Module,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Cost } from "../common/throttler.guard";
import {
  importProductsSchema,
  productSettingsSchema,
  type ImportProductsInput,
  type ProductSettingsInput,
} from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { EngineService } from "../engine/engine.service";
import { MinRole } from "../common/roles.guard";

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly auditLog: AuditService,
  ) {}

  async getSettings(orgId: string) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
      select: {
        website: true,
        productImportConsentAt: true,
        lastProductImportAt: true,
        productAutoImport: true,
        productAutoPost: true,
        productPostPlatforms: true,
      },
    });
    const count = await this.prisma.product.count({ where: { orgId } });
    return {
      website: profile?.website ?? null,
      // The date, not just a flag: the user should be able to see when they
      // agreed to this, and withdraw it.
      importConsentAt: profile?.productImportConsentAt?.toISOString() ?? null,
      lastImportAt: profile?.lastProductImportAt?.toISOString() ?? null,
      autoImport: profile?.productAutoImport ?? false,
      autoPost: profile?.productAutoPost ?? false,
      postPlatforms: profile?.productPostPlatforms ?? [],
      productCount: count,
    };
  }

  async saveSettings(orgId: string, userId: string, input: ProductSettingsInput) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
      select: { id: true, productImportConsentAt: true },
    });
    if (!profile) {
      throw new BadRequestException(
        "Add your business profile first, product import reads the website set there",
      );
    }

    // Consent is stored as when it was given, so re-saving other settings does
    // not silently reset the date to now.
    const consentAt = input.importConsent
      ? (profile.productImportConsentAt ?? new Date())
      : null;

    await this.prisma.businessProfile.update({
      where: { orgId },
      data: {
        productImportConsentAt: consentAt,
        productImportConsentBy: input.importConsent ? userId : null,
        productAutoImport: input.autoImport,
        productAutoPost: input.autoPost,
        productPostPlatforms: input.postPlatforms,
      },
    });

    this.auditLog.log({
      orgId,
      userId,
      action: input.importConsent ? "products.import_allowed" : "products.import_withdrawn",
      targetType: "BusinessProfile",
      targetId: profile.id,
      metadata: {
        autoImport: input.autoImport,
        autoPost: input.autoPost,
        platforms: input.postPlatforms,
      },
    });
    return this.getSettings(orgId);
  }

  /** Read the shop now. The engine re-checks consent before it fetches. */
  async importNow(orgId: string, userId: string, input: ImportProductsInput) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
      select: { website: true, productImportConsentAt: true },
    });
    if (!profile?.productImportConsentAt) {
      throw new BadRequestException(
        "Allow GODEYE to read your website before importing products",
      );
    }
    if (!input.url && !profile.website) {
      throw new BadRequestException("No website is set for this workspace");
    }

    const { taskId } = await this.engine.enqueueImportProducts({
      orgId,
      url: input.url,
      limit: input.limit,
    });
    this.auditLog.log({
      orgId,
      userId,
      action: "products.import_requested",
      targetType: "BusinessProfile",
      targetId: orgId,
      metadata: { url: input.url ?? profile.website },
    });
    return { taskId };
  }

  /** Remove one product, or the whole catalogue. */
  async remove(orgId: string, userId: string, id?: string) {
    if (id) {
      const product = await this.prisma.product.findFirst({ where: { id, orgId } });
      if (!product) throw new NotFoundException("Product not found");
      await this.prisma.product.delete({ where: { id, orgId } });
      this.auditLog.log({
        orgId,
        userId,
        action: "products.deleted",
        targetType: "Product",
        targetId: id,
        metadata: { title: product.title },
      });
      return { deleted: 1 };
    }

    const { count } = await this.prisma.product.deleteMany({ where: { orgId } });
    this.auditLog.log({
      orgId,
      userId,
      action: "products.cleared",
      targetType: "Product",
      targetId: "*",
      metadata: { deleted: count },
    });
    return { deleted: count };
  }

  async list(orgId: string, limit = 100) {
    const rows = await this.prisma.product.findMany({
      where: { orgId },
      // Newest arrivals first: that is what a shop wants to talk about.
      orderBy: [{ firstSeenAt: "desc" }],
      take: Math.min(limit, 500),
    });
    return rows.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      // A string, not a number: a float price is how a rounding error reaches
      // a customer's feed.
      price: p.price?.toString() ?? null,
      currency: p.currency,
      imageUrl: p.imageUrl,
      availability: p.availability,
      sku: p.sku,
      sourceUrl: p.sourceUrl,
      source: p.source,
      firstSeenAt: p.firstSeenAt.toISOString(),
      lastSeenAt: p.lastSeenAt.toISOString(),
      lastPostedAt: p.lastPostedAt?.toISOString() ?? null,
      postCount: p.postCount,
    }));
  }
}

@ApiTags("products")
@Controller("products")
@ApiBearerAuth()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get("settings")
  @MinRole("VIEWER")
  @ApiOperation({ summary: "Whether this workspace allows its website to be read" })
  getSettings(@CurrentAuth() auth: AccessTokenPayload) {
    return this.products.getSettings(auth.orgId);
  }

  @Put("settings")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Allow or withdraw product import, and how it runs" })
  saveSettings(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(productSettingsSchema)) body: ProductSettingsInput,
  ) {
    return this.products.saveSettings(auth.orgId, auth.sub, body);
  }

  @Post("import")
  // Fetches and parses a storefront, sometimes through a headless browser.
  @Cost(10)
  @MinRole("ADMIN")
  // Each import is a crawl of someone's site; a few a minute is plenty.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Read the workspace's shop now" })
  importNow(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(importProductsSchema)) body: ImportProductsInput,
  ) {
    return this.products.importNow(auth.orgId, auth.sub, body);
  }

  @Get()
  @MinRole("VIEWER")
  @ApiOperation({ summary: "The imported catalogue" })
  list(@CurrentAuth() auth: AccessTokenPayload, @Query("limit") limit?: string) {
    return this.products.list(auth.orgId, limit ? Number(limit) : undefined);
  }

  @Delete(":id")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Remove one imported product" })
  removeOne(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.products.remove(auth.orgId, auth.sub, id);
  }

  @Delete()
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Remove the whole imported catalogue" })
  clear(@CurrentAuth() auth: AccessTokenPayload) {
    return this.products.remove(auth.orgId, auth.sub);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
