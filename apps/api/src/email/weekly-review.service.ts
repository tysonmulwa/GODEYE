import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { EmailService, redact } from "./email.service";
import { weeklyReviewEmail, type WeeklySummary } from "./templates";

/**
 * The Monday summary of the week.
 *
 * ## Why this lives in the API and not the engine
 *
 * The engine owns scheduled work, so the obvious home is a Celery task. But the
 * templates, the Resend client and the redaction helper are all here, and a
 * second implementation in Python would be a second set of email bugs and a
 * second place for the sending domain to be got wrong. The engine's beat calls
 * this over the internal endpoint instead, which keeps one implementation of
 * "how GODEYE sends mail".
 *
 * ## Every number is counted, none are compared
 *
 * The summary states what happened: published, scheduled, failed. There is no
 * "up 40% on last week", because nothing in the product stores a baseline to
 * compare against, and a fabricated trend in a recurring email is a lie told
 * every week to the same person.
 *
 * ## Sending is idempotent by high-water mark
 *
 * `weeklyReviewAt` is written before the send and checked before selecting, so
 * a beat tick that fires twice, or a worker that restarts halfway through a
 * batch, cannot send the same summary again. Sending twice is the failure mode
 * that gets a domain reported.
 */

/** How long since the last send before a workspace is due another. */
const DUE_AFTER_DAYS = 6;
const WINDOW_DAYS = 7;

@Injectable()
export class WeeklyReviewService {
  private readonly logger = new Logger(WeeklyReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Sends to every workspace that is opted in and due.
   *
   * @returns how many were sent, skipped and failed, for the caller to log.
   */
  async runDue(now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    if (!this.email.enabled) {
      this.logger.warn("weekly review skipped: transactional email is not configured");
      return { sent: 0, skipped: 0, failed: 0 };
    }

    const dueBefore = new Date(now.getTime() - DUE_AFTER_DAYS * 86_400_000);
    const orgs = await this.prisma.organization.findMany({
      where: {
        weeklyReview: true,
        OR: [{ weeklyReviewAt: null }, { weeklyReviewAt: { lt: dueBefore } }],
      },
      select: { id: true, name: true },
      // Bounded. A backlog after an outage should go out over several ticks
      // rather than as one burst that trips Resend's rate limit and gets the
      // whole batch rejected.
      take: 200,
    });

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of orgs) {
      const owner = await this.prisma.membership.findFirst({
        where: { orgId: org.id, role: "OWNER" },
        select: { user: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (!owner?.user?.email) {
        skipped++;
        continue;
      }

      const summary = await this.summarise(org.id, now);

      // Claim it BEFORE sending. A crash between the write and the send costs
      // one missed summary; a crash between the send and the write costs a
      // duplicate every time the worker restarts, and the second is the one
      // that gets a sender reported.
      await this.prisma.organization.update({
        where: { id: org.id },
        data: { weeklyReviewAt: now },
      });

      const result = await this.email.send(
        weeklyReviewEmail(owner.user.email, org.name, summary),
      );
      if (result.sent) {
        sent++;
      } else {
        failed++;
        this.logger.warn(
          `weekly review for ${org.id} to ${redact(owner.user.email)} not sent: ${result.reason}`,
        );
      }
    }

    this.logger.log(`weekly review: ${sent} sent, ${skipped} skipped, ${failed} failed`);
    return { sent, skipped, failed };
  }

  /** Counted from this workspace's own rows, over the last seven days. */
  private async summarise(orgId: string, now: Date): Promise<WeeklySummary> {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

    const [published, scheduled, failedPosts, byConnection] = await Promise.all([
      this.prisma.scheduledPost.count({
        where: { orgId, status: "PUBLISHED", publishedAt: { gte: since } },
      }),
      this.prisma.scheduledPost.count({
        where: { orgId, status: "PENDING", scheduledAt: { gte: now } },
      }),
      this.prisma.scheduledPost.count({
        where: { orgId, status: "FAILED", updatedAt: { gte: since } },
      }),
      // Grouped by connection, not by platform: ScheduledPost records WHICH
      // connection it goes to, and the platform lives on SocialConnection. The
      // first draft of this grouped by a `platform` column that does not exist
      // on the table, which is what broke the API build.
      this.prisma.scheduledPost.groupBy({
        by: ["connectionId"],
        where: { orgId, status: "PUBLISHED", publishedAt: { gte: since } },
        _count: { connectionId: true },
        orderBy: { _count: { connectionId: "desc" } },
        take: 1,
      }),
    ]);

    // One extra lookup rather than a raw join, because this runs once a week
    // per workspace and legibility is worth more than the round trip.
    let topPlatform: string | null = null;
    const topConnectionId = byConnection[0]?.connectionId;
    if (topConnectionId) {
      const connection = await this.prisma.socialConnection.findUnique({
        where: { id: topConnectionId },
        select: { platform: true },
      });
      topPlatform = connection?.platform ?? null;
    }

    return {
      published,
      scheduled,
      failed: failedPosts,
      topPlatform,
      // Left out rather than guessed at. The SEO score belongs to a crawl that
      // may be weeks old, and presenting a stale number weekly as if it were
      // this week's is the same problem as inventing a trend.
      seoScore: null,
    };
  }
}
