import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@godeye/db";
import type { GenerateContentInput } from "@godeye/shared";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Kick off AI content generation: creates a QUEUED AgentRun, hands it to the
   * Python engine, and returns ids the client can watch (WS + polling).
   */
  async generate(orgId: string, userId: string, input: GenerateContentInput) {
    const profile = await this.prisma.businessProfile.findUnique({ where: { orgId } });
    if (!profile) {
      throw new BadRequestException("Set up your business profile before generating content");
    }

    // Token metering is post-hoc (runs record usage), so gate on what's already spent
    await this.billing.assertWithinLimit(orgId, "aiTokensPerMonth", 0);

    const run = await this.prisma.agentRun.create({
      data: {
        orgId,
        agent: "CONTENT",
        status: "QUEUED",
        input: {
          goal: input.goal,
          platforms: input.platforms,
          tone: input.tone,
          topic: input.topic,
          callToAction: input.callToAction,
          abTest: input.abTest,
          requestedBy: userId,
        },
      },
    });

    try {
      const { taskId } = await this.engine.enqueueGenerateContent({
        agentRunId: run.id,
        orgId,
        goal: input.goal,
        platforms: input.platforms,
        tone: input.tone,
        topic: input.topic,
        callToAction: input.callToAction,
        abTest: input.abTest,
      });
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { taskId } });
      this.audit.log({
        orgId,
        userId,
        action: "content.generate_requested",
        targetType: "AgentRun",
        targetId: run.id,
      });
      return { agentRunId: run.id, taskId };
    } catch (e) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: e instanceof Error ? e.message : "enqueue failed" },
      });
      throw e;
    }
  }

  async getAgentRun(orgId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, orgId } });
    if (!run) throw new NotFoundException("Agent run not found");
    return {
      id: run.id,
      agent: run.agent,
      status: run.status,
      output: run.output,
      error: run.error,
      model: run.model,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd?.toString() ?? null,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  private readonly reviewerInclude = {
    submittedBy: { select: { name: true } },
    reviewedBy: { select: { name: true } },
  } as const;

  async listContent(orgId: string, status?: string) {
    const rows = await this.prisma.contentItem.findMany({
      where: { orgId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: this.reviewerInclude,
    });
    return rows.map((c) => this.toDto(c));
  }

  async getContent(orgId: string, id: string) {
    const row = await this.prisma.contentItem.findFirst({
      where: { id, orgId },
      include: this.reviewerInclude,
    });
    if (!row) throw new NotFoundException("Content not found");
    return this.toDto(row);
  }

  async createManual(
    orgId: string,
    userId: string,
    input: { title?: string; body: string; hashtags?: string[] },
  ) {
    const row = await this.prisma.contentItem.create({
      data: {
        orgId,
        createdById: userId,
        body: input.body,
        title: input.title,
        hashtags: input.hashtags ?? [],
        aiGenerated: false,
      },
    });
    return this.toDto(row);
  }

  async update(
    orgId: string,
    id: string,
    input: {
      title?: string;
      body?: string;
      hashtags?: string[];
      status?: string;
      variants?: unknown;
      abVariants?: unknown;
      evergreen?: boolean;
    },
  ) {
    const existing = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException("Content not found");
    const row = await this.prisma.contentItem.update({
      where: { id, orgId },
      data: {
        title: input.title,
        body: input.body,
        hashtags: input.hashtags,
        status: input.status as never,
        variants: input.variants as never,
        // null clears the A/B split; undefined leaves it unchanged.
        abVariants:
          input.abVariants === undefined
            ? undefined
            : input.abVariants === null
              ? Prisma.JsonNull
              : (input.abVariants as never),
        evergreen: input.evergreen,
      },
      include: this.reviewerInclude,
    });
    return this.toDto(row);
  }

  // ---------- Approval workflow ----------

  async submitForReview(orgId: string, userId: string, id: string) {
    const content = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
    if (!content) throw new NotFoundException("Content not found");
    if (content.status !== "DRAFT") {
      throw new BadRequestException(`Only drafts can be submitted (status: ${content.status})`);
    }
    const row = await this.prisma.contentItem.update({
      where: { id, orgId },
      data: {
        status: "PENDING_APPROVAL",
        submittedAt: new Date(),
        submittedById: userId,
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
      },
      include: this.reviewerInclude,
    });
    this.audit.log({
      orgId,
      userId,
      action: "content.submitted",
      targetType: "ContentItem",
      targetId: id,
    });
    return this.toDto(row);
  }

  async approve(orgId: string, userId: string, id: string) {
    const content = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
    if (!content) throw new NotFoundException("Content not found");
    if (content.status !== "PENDING_APPROVAL") {
      throw new BadRequestException(`Only pending content can be approved (status: ${content.status})`);
    }
    const row = await this.prisma.contentItem.update({
      where: { id, orgId },
      data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: userId, reviewNote: null },
      include: this.reviewerInclude,
    });
    this.audit.log({
      orgId,
      userId,
      action: "content.approved",
      targetType: "ContentItem",
      targetId: id,
    });
    return this.toDto(row);
  }

  /**
   * Reject back to draft. Any still-pending scheduled posts (autopilot content
   * awaits approval with its slots already booked) are cancelled.
   */
  async reject(orgId: string, userId: string, id: string, note?: string) {
    const content = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
    if (!content) throw new NotFoundException("Content not found");
    if (content.status !== "PENDING_APPROVAL") {
      throw new BadRequestException(`Only pending content can be rejected (status: ${content.status})`);
    }
    const [row] = await this.prisma.$transaction([
      this.prisma.contentItem.update({
        where: { id, orgId },
        data: {
          status: "DRAFT",
          reviewedAt: new Date(),
          reviewedById: userId,
          reviewNote: note ?? null,
        },
        include: this.reviewerInclude,
      }),
      this.prisma.scheduledPost.updateMany({
        where: { contentItemId: id, orgId, status: "PENDING" },
        data: { status: "CANCELLED" },
      }),
    ]);
    this.audit.log({
      orgId,
      userId,
      action: "content.rejected",
      targetType: "ContentItem",
      targetId: id,
      metadata: note ? { note } : undefined,
    });
    return this.toDto(row);
  }

  private toDto(c: {
    id: string;
    type: string;
    status: string;
    title: string | null;
    body: string;
    hashtags: string[];
    variants: unknown;
    abVariants?: unknown;
    evergreen?: boolean;
    aiGenerated: boolean;
    submittedAt?: Date | null;
    submittedBy?: { name: string } | null;
    reviewedAt?: Date | null;
    reviewedBy?: { name: string } | null;
    reviewNote?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      title: c.title,
      body: c.body,
      hashtags: c.hashtags,
      variants: c.variants ?? null,
      abVariants: c.abVariants ?? null,
      evergreen: c.evergreen ?? false,
      aiGenerated: c.aiGenerated,
      submittedAt: c.submittedAt?.toISOString() ?? null,
      submittedByName: c.submittedBy?.name ?? null,
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      reviewedByName: c.reviewedBy?.name ?? null,
      reviewNote: c.reviewNote ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
