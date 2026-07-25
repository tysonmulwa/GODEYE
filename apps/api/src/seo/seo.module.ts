import { Module } from "@nestjs/common";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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

/** Bare hostname (no protocol, no www) for comparing site ownership. */
function hostOf(u?: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

@Injectable()
export class SeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly auditLog: AuditService,
  ) {}

  /** Kick off a site audit; the SEO Agent runs it in the engine. */
  async runAudit(orgId: string, userId: string, input: RunSeoAuditInput) {
    const profile = await this.prisma.businessProfile.findUnique({
      where: { orgId },
      select: { website: true },
    });
    const url = input.url ?? profile?.website ?? undefined;
    if (!url) {
      throw new BadRequestException(
        "No URL provided and no website set on the business profile",
      );
    }

    // Ownership gate: if the URL isn't the org's registered website, ask the user
    // to confirm before scanning a site they don't own. Plan-based limits on how
    // many sites a workspace may add (e.g. premium 2, vip 3) are intentionally
    // NOT enforced yet — kept inactive while billing is still under test.
    const ownedHost = hostOf(profile?.website);
    const requestedHost = hostOf(url);
    const isForeign = !!ownedHost && !!requestedHost && ownedHost !== requestedHost;
    if (isForeign && !input.allowForeign) {
      throw new ConflictException({
        code: "SITE_NOT_OWNED",
        message: `${requestedHost} isn't your registered site (${ownedHost}). Scan it anyway?`,
      });
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

  /** Wipe every audit (and its agent run) for the workspace, so the user can start clean. */
  async clearAll(orgId: string, userId: string) {
    const audits = await this.prisma.seoAudit.findMany({
      where: { orgId },
      select: { agentRunId: true },
    });
    const agentRunIds = audits
      .map((a) => a.agentRunId)
      .filter((id): id is string => !!id);

    // Delete the audits first (children), then their agent runs (parents).
    const { count } = await this.prisma.seoAudit.deleteMany({ where: { orgId } });
    if (agentRunIds.length > 0) {
      await this.prisma.agentRun.deleteMany({
        where: { id: { in: agentRunIds }, orgId },
      });
    }

    this.auditLog.log({
      orgId,
      userId,
      action: "seo.cleared",
      targetType: "SeoAudit",
      targetId: "*",
      metadata: { deleted: count },
    });
    return { deleted: count };
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

  @Delete("audits")
  @ApiOperation({ summary: "Delete all SEO audits for the workspace" })
  clear(@CurrentAuth() auth: AccessTokenPayload) {
    return this.seo.clearAll(auth.orgId, auth.sub);
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
