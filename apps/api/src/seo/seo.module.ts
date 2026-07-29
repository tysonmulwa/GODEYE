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
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { runSeoAuditSchema, type RunSeoAuditInput } from "@godeye/shared";
import { z } from "zod";
import { AuditService } from "../common/audit.service";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { ZodPipe } from "../common/zod.pipe";
import { EngineService } from "../engine/engine.service";
import { renderFixPack } from "./fix-pack";

const updateFixSchema = z.object({
  status: z.enum(["PROPOSED", "APPLIED", "DISMISSED"]),
});

const bulkFixSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  status: z.enum(["PROPOSED", "APPLIED", "DISMISSED"]),
});

const indexNowSchema = z.object({
  urls: z.array(z.string().url()).max(1000).optional(),
});

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
      platform: audit.platform,
      hasSitemap: !!audit.sitemapXml,
      hasRobots: !!audit.robotsTxt,
      error: audit.error,
      createdAt: audit.createdAt.toISOString(),
      completedAt: audit.completedAt?.toISOString() ?? null,
    };
  }

  // ---------- Fixes ----------

  /** The actionable changes derived from an audit, worst first. */
  async listFixes(orgId: string, auditId: string) {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id: auditId, orgId },
      select: { id: true },
    });
    if (!audit) throw new NotFoundException("Audit not found");

    const rows = await this.prisma.seoFix.findMany({
      where: { auditId, orgId },
      orderBy: { createdAt: "asc" },
    });
    // Severity is a string, and "critical" < "info" < "warning" alphabetically,
    // which is not the order a human wants to read them in — so rank in code.
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return rows
      .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
      .map((f) => ({
        id: f.id,
        findingCode: f.findingCode,
        kind: f.kind,
        channel: f.channel,
        status: f.status,
        severity: f.severity,
        targetUrl: f.targetUrl,
        title: f.title,
        before: f.before,
        after: f.after,
        filePath: f.filePath,
        guidance: f.guidance,
        appliedAt: f.appliedAt?.toISOString() ?? null,
        verifiedAt: f.verifiedAt?.toISOString() ?? null,
        error: f.error,
      }));
  }

  /**
   * Move a fix through the loop. VERIFIED is deliberately not settable here —
   * only a re-crawl that no longer reports the finding can award it.
   */
  async updateFixStatus(
    orgId: string,
    id: string,
    userId: string,
    status: "PROPOSED" | "APPLIED" | "DISMISSED",
  ) {
    const fix = await this.prisma.seoFix.findFirst({ where: { id, orgId } });
    if (!fix) throw new NotFoundException("Fix not found");
    const updated = await this.prisma.seoFix.update({
      where: { id },
      data: {
        status,
        appliedAt: status === "APPLIED" ? new Date() : null,
        // Re-opening or dismissing clears a stale verification verdict.
        verifiedAt: null,
        error: null,
      },
    });
    this.auditLog.log({
      orgId,
      userId,
      action: "seo.fix_status_changed",
      targetType: "SeoFix",
      targetId: id,
      metadata: { status, findingCode: fix.findingCode },
    });
    return { id: updated.id, status: updated.status };
  }

  /** Same transition for a batch — "I've done all of these" is the common case. */
  async bulkUpdateFixStatus(
    orgId: string,
    userId: string,
    ids: string[],
    status: "PROPOSED" | "APPLIED" | "DISMISSED",
  ) {
    const { count } = await this.prisma.seoFix.updateMany({
      where: { id: { in: ids }, orgId },
      data: {
        status,
        appliedAt: status === "APPLIED" ? new Date() : null,
        verifiedAt: null,
        error: null,
      },
    });
    this.auditLog.log({
      orgId,
      userId,
      action: "seo.fixes_bulk_status_changed",
      targetType: "SeoFix",
      targetId: "*",
      metadata: { status, count },
    });
    return { updated: count };
  }

  /** Re-crawl the pages applied fixes touched and record whether they took. */
  async verifyFixes(orgId: string, auditId: string, userId: string) {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id: auditId, orgId },
      select: { id: true },
    });
    if (!audit) throw new NotFoundException("Audit not found");

    const pending = await this.prisma.seoFix.count({
      where: { auditId, orgId, status: { in: ["APPLIED", "FAILED"] } },
    });
    if (pending === 0) {
      throw new BadRequestException(
        "Nothing to verify yet — mark the fixes you've made as applied first",
      );
    }

    const { taskId } = await this.engine.enqueueVerifySeoFixes({ orgId, auditId });
    this.auditLog.log({
      orgId,
      userId,
      action: "seo.fixes_verification_requested",
      targetType: "SeoAudit",
      targetId: auditId,
      metadata: { pending },
    });
    return { taskId, checking: pending };
  }

  async fixPack(orgId: string, auditId: string): Promise<string> {
    const audit = await this.prisma.seoAudit.findFirst({ where: { id: auditId, orgId } });
    if (!audit) throw new NotFoundException("Audit not found");
    const fixes = await this.prisma.seoFix.findMany({
      where: { auditId, orgId },
      orderBy: { createdAt: "asc" },
    });
    return renderFixPack(audit, fixes);
  }

  // ---------- IndexNow ----------

  async indexNowStatus(orgId: string, auditId: string) {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id: auditId, orgId },
      select: { url: true },
    });
    if (!audit) throw new NotFoundException("Audit not found");
    return this.engine.indexNowStatus(orgId, audit.url);
  }

  /**
   * Push URLs to IndexNow. With no explicit list, submits the pages whose fixes
   * are verified — those are the ones we know actually changed.
   */
  async submitIndexNow(orgId: string, auditId: string, userId: string, urls?: string[]) {
    const audit = await this.prisma.seoAudit.findFirst({
      where: { id: auditId, orgId },
      select: { url: true },
    });
    if (!audit) throw new NotFoundException("Audit not found");

    let targets = urls ?? [];
    if (targets.length === 0) {
      const verified = await this.prisma.seoFix.findMany({
        where: { auditId, orgId, status: "VERIFIED", kind: { not: "FILE" } },
        select: { targetUrl: true },
        distinct: ["targetUrl"],
      });
      targets = verified.map((f) => f.targetUrl);
    }
    if (targets.length === 0) {
      throw new BadRequestException(
        "No verified pages to submit yet — apply some fixes and verify them first",
      );
    }

    const result = await this.engine.submitIndexNow({
      orgId,
      siteUrl: audit.url,
      urls: targets,
    });
    this.auditLog.log({
      orgId,
      userId,
      action: "seo.indexnow_submitted",
      targetType: "SeoAudit",
      targetId: auditId,
      metadata: { requested: targets.length, status: result.status },
    });
    return result;
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

  @Get("audits/:id/fixes")
  @ApiOperation({ summary: "Actionable fixes derived from an audit's findings" })
  listFixes(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.listFixes(auth.orgId, id);
  }

  @Get("audits/:id/fix-pack.md")
  @Header("Content-Type", "text/markdown; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="godeye-seo-fixes.md"')
  @ApiOperation({ summary: "Every fix as one Markdown document, ready to hand to a developer" })
  fixPack(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.fixPack(auth.orgId, id);
  }

  @Patch("fixes/:id")
  @ApiOperation({ summary: "Mark a fix applied, dismissed, or back to proposed" })
  updateFix(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(updateFixSchema)) body: z.infer<typeof updateFixSchema>,
  ) {
    return this.seo.updateFixStatus(auth.orgId, id, auth.sub, body.status);
  }

  @Post("fixes/bulk")
  @ApiOperation({ summary: "Apply the same status change to several fixes" })
  bulkUpdateFixes(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(bulkFixSchema)) body: z.infer<typeof bulkFixSchema>,
  ) {
    return this.seo.bulkUpdateFixStatus(auth.orgId, auth.sub, body.ids, body.status);
  }

  @Post("audits/:id/verify")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Re-crawl to confirm applied fixes actually took effect" })
  verify(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.verifyFixes(auth.orgId, id, auth.sub);
  }

  @Get("audits/:id/indexnow")
  @ApiOperation({ summary: "IndexNow key and whether the site publishes it yet" })
  indexNowStatus(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.seo.indexNowStatus(auth.orgId, id);
  }

  @Post("audits/:id/indexnow")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Submit changed URLs to Bing, Yandex, Seznam and Naver" })
  submitIndexNow(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(indexNowSchema)) body: z.infer<typeof indexNowSchema>,
  ) {
    return this.seo.submitIndexNow(auth.orgId, id, auth.sub, body.urls);
  }
}

@Module({
  controllers: [SeoController],
  providers: [SeoService],
})
export class SeoModule {}
