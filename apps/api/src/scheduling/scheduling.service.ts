import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  PostingPlanInput,
  SchedulePostInput,
  UpdatePostingPlanInput,
} from "@godeye/shared";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: EngineService,
    private readonly billing: BillingService,
  ) {}

  /** Create one ScheduledPost per target connection. */
  async schedule(orgId: string, userId: string, input: SchedulePostInput) {
    const content = await this.prisma.contentItem.findFirst({
      where: { id: input.contentItemId, orgId },
    });
    if (!content) throw new NotFoundException("Content not found");

    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { requireApproval: true },
    });
    if (org.requireApproval && content.status !== "APPROVED") {
      throw new BadRequestException(
        "This organization requires approval before publishing — submit the content for review first",
      );
    }

    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) throw new BadRequestException("Invalid scheduledAt");
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException("scheduledAt is in the past");
    }

    const connections = await this.prisma.socialConnection.findMany({
      where: { id: { in: input.connectionIds }, orgId, status: "ACTIVE" },
    });
    if (connections.length !== input.connectionIds.length) {
      throw new BadRequestException("One or more connections not found or inactive");
    }

    await this.billing.assertWithinLimit(orgId, "postsPerMonth", connections.length);

    // If the content carries A/B variants, split them evenly across connections.
    const isAb = !!content.abVariants;

    const posts = await this.prisma.$transaction([
      ...connections.map((conn, index) =>
        this.prisma.scheduledPost.create({
          data: {
            orgId,
            contentItemId: content.id,
            connectionId: conn.id,
            scheduledAt,
            timezone: input.timezone,
            variantKey: isAb ? (index % 2 === 0 ? "A" : "B") : null,
          },
        }),
      ),
      this.prisma.contentItem.update({
        where: { id: content.id },
        data: {
          status: "SCHEDULED",
          // Only overwrite what the caller actually chose, so scheduling from
          // somewhere that does not offer these does not silently reset them.
          ...(input.slideshowSeconds !== undefined
            ? { slideshowSeconds: input.slideshowSeconds }
            : {}),
          ...(input.renderAsVideo !== undefined ? { renderAsVideo: input.renderAsVideo } : {}),
        },
      }),
    ]);

    this.audit.log({
      orgId,
      userId,
      action: "post.scheduled",
      targetType: "ContentItem",
      targetId: content.id,
      metadata: { connections: connections.length, scheduledAt: scheduledAt.toISOString() },
    });

    return posts.slice(0, connections.length);
  }

  async list(orgId: string, from?: string, to?: string, includeCancelled = false) {
    const rows = await this.prisma.scheduledPost.findMany({
      where: {
        orgId,
        // Changing a plan's times cancels its upcoming posts and re-plans
        // them. Leaving the old ones on the calendar fills it with rows
        // marked CANCELLED sitting beside their replacements, which reads as
        // "autopilot cancelled everything" rather than "these moved".
        ...(includeCancelled ? {} : { status: { not: "CANCELLED" as const } }),
        ...(from || to
          ? {
              scheduledAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      include: {
        contentItem: { select: { body: true, title: true } },
        connection: { select: { platform: true, displayName: true } },
      },
      orderBy: { scheduledAt: "asc" },
      take: 200,
    });
    return rows.map((p) => ({
      id: p.id,
      contentItemId: p.contentItemId,
      connectionId: p.connectionId,
      platform: p.connection.platform,
      connectionName: p.connection.displayName,
      scheduledAt: p.scheduledAt.toISOString(),
      timezone: p.timezone,
      status: p.status,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      externalPostUrl: p.externalPostUrl,
      error: p.error,
      contentPreview: (p.contentItem.title ?? p.contentItem.body).slice(0, 140),
    }));
  }

  async cancel(orgId: string, id: string, userId: string) {
    const post = await this.prisma.scheduledPost.findFirst({ where: { id, orgId } });
    if (!post) throw new NotFoundException("Scheduled post not found");
    if (post.status !== "PENDING") {
      throw new BadRequestException(`Cannot cancel a post in status ${post.status}`);
    }
    const updated = await this.prisma.scheduledPost.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    this.audit.log({
      orgId,
      userId,
      action: "post.cancelled",
      targetType: "ScheduledPost",
      targetId: id,
    });
    return { id: updated.id, status: updated.status };
  }

  /** Re-queue a failed post: reset to PENDING so the scheduler dispatches it again. */
  /**
   * Edit a post that hasn't gone out yet: change its text and/or its time, and
   * re-queue it. A failed post otherwise had to be retried unchanged, which is
   * useless when the failure was caused by the content itself.
   *
   * The body edit applies to the underlying content item, so sibling posts of
   * the same content see it too — that is the same object, not a copy.
   */
  async editPending(
    orgId: string,
    id: string,
    userId: string,
    input: { body?: string; scheduledAt?: string },
  ) {
    const post = await this.prisma.scheduledPost.findFirst({ where: { id, orgId } });
    if (!post) throw new NotFoundException("Scheduled post not found");
    if (post.status === "PUBLISHED") {
      throw new BadRequestException("This post is already published — it can't be edited here");
    }
    if (post.status === "PROCESSING") {
      throw new BadRequestException("This post is publishing right now — try again in a moment");
    }

    if (input.body !== undefined) {
      await this.prisma.contentItem.update({
        where: { id: post.contentItemId },
        data: { body: input.body },
      });
    }

    const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (when && Number.isNaN(when.getTime())) {
      throw new BadRequestException("Invalid scheduled time");
    }

    const updated = await this.prisma.scheduledPost.update({
      where: { id },
      data: {
        // Editing re-queues it: the point is to send the corrected version.
        status: "PENDING",
        error: null,
        lockedAt: null,
        attempts: 0,
        ...(when ? { scheduledAt: when } : {}),
      },
    });
    this.audit.log({
      orgId,
      userId,
      action: "post.edited",
      targetType: "ScheduledPost",
      targetId: id,
      metadata: { rescheduled: !!when, bodyChanged: input.body !== undefined },
    });
    return {
      id: updated.id,
      status: updated.status,
      scheduledAt: updated.scheduledAt.toISOString(),
    };
  }

  async retry(orgId: string, id: string, userId: string) {
    const post = await this.prisma.scheduledPost.findFirst({ where: { id, orgId } });
    if (!post) throw new NotFoundException("Scheduled post not found");
    if (post.status !== "FAILED") {
      throw new BadRequestException(`Only failed posts can be retried (status ${post.status})`);
    }
    const updated = await this.prisma.scheduledPost.update({
      where: { id },
      data: { status: "PENDING", error: null, lockedAt: null, attempts: 0 },
    });
    this.audit.log({
      orgId,
      userId,
      action: "post.retried",
      targetType: "ScheduledPost",
      targetId: id,
    });
    return { id: updated.id, status: updated.status };
  }

  // ---------- Posting plans ----------

  async createPlan(orgId: string, userId: string, input: PostingPlanInput) {
    if (input.cadence === "CUSTOM" && !input.customCron) {
      throw new BadRequestException("customCron is required for CUSTOM cadence");
    }
    const plan = await this.prisma.postingPlan.create({
      data: {
        orgId,
        name: input.name,
        cadence: input.cadence,
        customCron: input.customCron,
        timezone: input.timezone,
        platforms: input.platforms,
        preferredTimes: input.preferredTimes,
        autoGenerate: input.autoGenerate,
        topics: input.topics,
        abTesting: input.abTesting,
        recycleEvergreen: input.recycleEvergreen,
        generateImages: input.generateImages,
        // Inherited by every post this plan generates.
        slideshowSeconds: input.slideshowSeconds,
        renderAsVideo: input.renderAsVideo,
      },
    });
    this.audit.log({
      orgId,
      userId,
      action: "posting_plan.created",
      targetType: "PostingPlan",
      targetId: plan.id,
      metadata: { autoGenerate: input.autoGenerate, cadence: input.cadence },
    });
    return plan;
  }

  async updatePlan(orgId: string, id: string, userId: string, input: UpdatePostingPlanInput) {
    const existing = await this.prisma.postingPlan.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException("Posting plan not found");
    if ((input.cadence ?? existing.cadence) === "CUSTOM" && !(input.customCron ?? existing.customCron)) {
      throw new BadRequestException("customCron is required for CUSTOM cadence");
    }
    // Changing when or where a plan publishes has to reach the slots it already
    // booked. The planner works 24 hours ahead, so without this an edit looks
    // like it did nothing: the next few posts still go out at the old times, to
    // the old channels, and the new settings only appear a day later.
    const timingChanged =
      (input.cadence !== undefined && input.cadence !== existing.cadence) ||
      (input.customCron !== undefined && input.customCron !== existing.customCron) ||
      (input.timezone !== undefined && input.timezone !== existing.timezone) ||
      (input.preferredTimes !== undefined &&
        input.preferredTimes.join() !== existing.preferredTimes.join()) ||
      (input.platforms !== undefined &&
        input.platforms.join() !== existing.platforms.join());

    const plan = await this.prisma.postingPlan.update({
      where: { id },
      data: {
        name: input.name,
        cadence: input.cadence,
        customCron: input.customCron,
        timezone: input.timezone,
        platforms: input.platforms,
        preferredTimes: input.preferredTimes,
        autoGenerate: input.autoGenerate,
        topics: input.topics,
        abTesting: input.abTesting,
        recycleEvergreen: input.recycleEvergreen,
        generateImages: input.generateImages,
        slideshowSeconds: input.slideshowSeconds,
        renderAsVideo: input.renderAsVideo,
        active: input.active,
        // Clearing the high-water mark makes the planner re-plan from now.
        ...(timingChanged ? { lastPlannedAt: null } : {}),
      },
    });

    let rescheduled = 0;
    if (timingChanged) {
      // Only posts that have not gone out yet, and only this plan's. Anything
      // already published, or publishing right now, is left alone.
      const { count } = await this.prisma.scheduledPost.updateMany({
        where: {
          orgId,
          planId: id,
          status: "PENDING",
          scheduledAt: { gt: new Date() },
        },
        data: { status: "CANCELLED" },
      });
      rescheduled = count;
    }

    this.audit.log({
      orgId,
      userId,
      action: "posting_plan.updated",
      targetType: "PostingPlan",
      targetId: id,
      metadata: { timingChanged, cancelledUpcoming: rescheduled },
    });
    return { ...plan, cancelledUpcoming: rescheduled };
  }

  listPlans(orgId: string) {
    return this.prisma.postingPlan.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });
  }

  /** Ask the engine for engagement-driven best posting times (with heuristic fallback). */
  async bestTimes(orgId: string, platform: string, timezone: string) {
    return this.engine.bestTimes(orgId, platform, timezone);
  }

  /**
   * A/B report: aggregate the latest engagement snapshot per scheduled post,
   * grouped by variant, for a given content item.
   */
  async abReport(orgId: string, contentItemId: string) {
    const content = await this.prisma.contentItem.findFirst({
      where: { id: contentItemId, orgId },
    });
    if (!content) throw new NotFoundException("Content not found");

    const posts = await this.prisma.scheduledPost.findMany({
      where: { orgId, contentItemId, variantKey: { not: null } },
      select: { id: true, variantKey: true, status: true },
    });
    const snapshots = await this.prisma.analyticsSnapshot.findMany({
      where: { orgId, metric: "post_engagement" },
      orderBy: { capturedAt: "desc" },
    });

    // latest snapshot per scheduledPost id (via dimensions.scheduledPostId)
    const latestByPost = new Map<string, number>();
    for (const snap of snapshots) {
      const spId = (snap.dimensions as { scheduledPostId?: string } | null)?.scheduledPostId;
      if (spId && !latestByPost.has(spId)) latestByPost.set(spId, snap.value);
    }

    const variants: Record<string, { posts: number; totalEngagement: number; measured: number }> = {
      A: { posts: 0, totalEngagement: 0, measured: 0 },
      B: { posts: 0, totalEngagement: 0, measured: 0 },
    };
    for (const post of posts) {
      const key = post.variantKey!;
      variants[key] ??= { posts: 0, totalEngagement: 0, measured: 0 };
      variants[key].posts += 1;
      const engagement = latestByPost.get(post.id);
      if (engagement !== undefined) {
        variants[key].totalEngagement += engagement;
        variants[key].measured += 1;
      }
    }

    const summary = Object.entries(variants).map(([key, v]) => ({
      variant: key,
      posts: v.posts,
      measuredPosts: v.measured,
      avgEngagement: v.measured > 0 ? v.totalEngagement / v.measured : null,
    }));
    const scored = summary.filter((s) => s.avgEngagement !== null);
    const winner =
      scored.length === 2
        ? scored.reduce((a, b) => (a.avgEngagement! >= b.avgEngagement! ? a : b)).variant
        : null;

    return { contentItemId, variants: summary, winner };
  }
}
