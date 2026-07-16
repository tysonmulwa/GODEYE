import { Module } from "@nestjs/common";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { runSeoAuditSchema, type RunSeoAuditInput } from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { EngineService } from "../engine/engine.service";

@Injectable()
export class SeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly auditLog: AuditService,
  ) {}

  /** Kick off a site audit; the SEO Agent runs it in the engine. */
  async runAudit(orgId: string, userId: string, input: RunSeoAuditInput) {
    let url = input.url;
    if (!url) {
      const profile = await this.prisma.businessProfile.findUnique({
        where: { orgId },
        select: { website: true },
      });
      url = profile?.website ?? undefined;
    }
    if (!url) {
      throw new BadRequestException(
        "No URL provided and no website set on the business profile",
      );
    }

    const run = await this.prisma.agentRun.create({
      data: {
        orgId,
        agent: "SEO",
        status: "QUEUED",
        input: { url, maxPages: input.maxPages, requestedBy: userId },
      },
    });
    const audit = await this.prisma.seoAudit.create({
      data: { orgId, agentRunId: run.id, url },
    });

    try {
      const { taskId } = await this.engine.enqueueSeoAudit({
        agentRunId: run.id,
        orgId,
        auditId: audit.id,
        url,
        maxPages: input.maxPages,
      });
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { taskId } });
      this.auditLog.log({
        orgId,
        userId,
        action: "seo.audit_requested",
        targetType: "SeoAudit",
        targetId: audit.id,
        metadata: { url },
      });
      return { auditId: audit.id, agentRunId: run.id, taskId };
    } catch (e) {
      await Promise.all([
        this.prisma.agentRun.update({
          where: { id: run.id },
          data: { status: "FAILED", error: e instanceof Error ? e.message : "enqueue failed" },
        }),
        this.prisma.seoAudit.update({
          where: { id: audit.id },
          data: { status: "FAILED", error: e instanceof Error ? e.message : "enqueue failed" },
        }),
      ]);
      throw e;
    }
  }

  async list(orgId: string) {
    const rows = await this.prisma.seoAudit.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        url: true,
        status: true,
        score: true,
        pagesCrawled: true,
        error: true,
        createdAt: true,
        completedAt: true,
      },
    });
    return rows.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      completedAt: a.completedAt?.toISOString() ?? null,
    }));
  }

  async get(orgId: string, id: string) {
    const audit = await this.prisma.seoAudit.findFirst({ where: { id, orgId } });
    if (!audit) throw new NotFoundException("Audit not found");
    return {
      id: audit.id,
      url: audit.url,
      status: audit.status,
      score: audit.score,
      pagesCrawled: audit.pagesCrawled,
      findings: audit.findings ?? null,
      keywords: audit.keywords ?? null,
      metaSuggestions: audit.metaSuggestions ?? null,
      schemaMarkup: audit.schemaMarkup ?? null,
      hasSitemap: !!audit.sitemapXml,
      hasRobots: !!audit.robotsTxt,
      error: audit.error,
      createdAt: audit.createdAt.toISOString(),
      completedAt: audit.completedAt?.toISOString() ?? null,
    };
  }

  async getArtifact(orgId: string, id: string, kind: "sitemap" | "robots"): Promise<string> {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id, orgId },
      select: { sitemapXml: true, robotsTxt: true },
    });
    if (!audit) throw new NotFoundException("Audit not found");
    const content = kind === "sitemap" ? audit.sitemapXml : audit.robotsTxt;
    if (!content) throw new NotFoundException(`No ${kind} generated for this audit`);
    return content;
  }
}

@ApiTags("seo")
@Controller("seo")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @Post("audit")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Run a site SEO audit (crawl + rules + AI recommendations)" })
  runAudit(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(runSeoAuditSchema)) body: RunSeoAuditInput,
  ) {
    return this.seo.runAudit(auth.orgId, auth.sub, body);
  }

  @Get("audits")
  list(@CurrentAuth() auth: AccessTokenPayload) {
    return this.seo.list(auth.orgId);
  }

  @Get("audits/:id")
  get(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.get(auth.orgId, id);
  }

  @Get("audits/:id/sitemap.xml")
  @Header("Content-Type", "application/xml")
  @Header("Content-Disposition", 'attachment; filename="sitemap.xml"')
  sitemap(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.getArtifact(auth.orgId, id, "sitemap");
  }

  @Get("audits/:id/robots.txt")
  @Header("Content-Type", "text/plain")
  @Header("Content-Disposition", 'attachment; filename="robots.txt"')
  robots(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.getArtifact(auth.orgId, id, "robots");
  }
}

@Module({
  controllers: [SeoController],
  providers: [SeoService],
})
export class SeoModule {}
