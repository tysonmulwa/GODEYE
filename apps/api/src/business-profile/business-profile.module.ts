import { Module } from "@nestjs/common";
import {
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { businessProfileSchema, type BusinessProfileInput } from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { MinRole } from "../common/roles.guard";

@Injectable()
export class BusinessProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(orgId: string) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { orgId } });
    if (!profile) throw new NotFoundException("Business profile not set up yet");
    return profile;
  }

  async upsert(orgId: string, userId: string, input: BusinessProfileInput) {
    const data = {
      businessName: input.businessName,
      industry: input.industry,
      description: input.description,
      targetAudience: input.targetAudience,
      location: input.location || null,
      website: input.website || null,
      products: input.products,
      services: input.services,
      goals: input.goals,
      brandVoice: input.brandVoice || null,
      competitors: input.competitors,
      seasonalNotes: input.seasonalNotes || null,
    };
    const profile = await this.prisma.businessProfile.upsert({
      where: { orgId },
      update: data,
      create: { orgId, ...data },
    });
    this.audit.log({
      orgId,
      userId,
      action: "business_profile.saved",
      targetType: "BusinessProfile",
      targetId: profile.id,
    });
    return profile;
  }
}

@ApiTags("business-profile")
@Controller("business-profile")
@ApiBearerAuth()
export class BusinessProfileController {
  constructor(private readonly service: BusinessProfileService) {}

  @Get()
  @MinRole("VIEWER")
  get(@CurrentAuth() auth: AccessTokenPayload) {
    return this.service.get(auth.orgId);
  }

  @Put()
  @MinRole("ADMIN")
  upsert(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(businessProfileSchema)) body: BusinessProfileInput,
  ) {
    return this.service.upsert(auth.orgId, auth.sub, body);
  }
}

@Module({
  controllers: [BusinessProfileController],
  providers: [BusinessProfileService],
})
export class BusinessProfileModule {}
