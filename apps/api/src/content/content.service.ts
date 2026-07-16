import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { GenerateContentInput } from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly audit: AuditService,
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

  async listContent(orgId: string, status?: string) {
    const rows = await this.prisma.contentItem.findMany({
      where: { orgId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((c) => this.toDto(c));
  }

  async getContent(orgId: string, id: string) {
    const row = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
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
      evergreen?: boolean;
    },
  ) {
    const existing = await this.prisma.contentItem.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException("Content not found");
    const row = await this.prisma.contentItem.update({
      where: { id },
      data: {
        title: input.title,
        body: input.body,
        hashtags: input.hashtags,
        status: input.status as never,
        variants: input.variants as never,
        evergreen: input.evergreen,
      },
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
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
