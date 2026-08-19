import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import type { OrgRole } from "./roles.guard";

/**
 * The live answer to "may this person still do this here?". Finding S-10.
 *
 * Authorization used to read the role out of the JWT and stop there, so a
 * demoted ADMIN kept ADMIN for the life of their 15-minute access token, and a
 * removed member kept full access long enough to delete every social connection
 * and export the product catalogue. `AuthService.me()` echoed the token's role
 * too, so the UI agreed with the stale claim.
 *
 * Every authenticated request now reads the membership. That is one indexed
 * lookup on a unique key, cached briefly.
 *
 * ## Why a small in-process cache and not Redis
 *
 * A Redis round trip per request costs about what an indexed Postgres lookup on
 * a unique key costs, so it buys nothing on latency; what it would buy is
 * instant cross-replica invalidation. The cache TTL is the bound on staleness
 * instead: five seconds, against the fifteen minutes the finding describes.
 *
 * The tradeoff is stated rather than hidden: a demotion is enforced within 5s on
 * every replica, immediately on the one that processed it. If that is ever not
 * good enough — say a compliance requirement for instant revocation — move
 * `invalidate` onto a Redis pub/sub channel; the call sites do not change.
 */

const CACHE_TTL_MS = 5_000;

export interface LiveMembership {
  role: OrgRole;
  sessionVersion: number;
}

interface CacheEntry {
  value: LiveMembership | null;
  at: number;
}

@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  private key(userId: string, orgId: string): string {
    return `${userId}:${orgId}`;
  }

  /** `null` means "not a member", which is a decision, not a missing answer. */
  async current(userId: string, orgId: string): Promise<LiveMembership | null> {
    const key = this.key(userId, orgId);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const row = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { role: true, sessionVersion: true },
    });
    const value: LiveMembership | null = row
      ? // `?? 0` because rows written before the sessionVersion column existed
        // read back as null, and treating that as "no version" would sign every
        // existing session out on deploy.
        { role: row.role as OrgRole, sessionVersion: row.sessionVersion ?? 0 }
      : null;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Drop the cached answer for one person in one workspace. */
  invalidate(userId: string, orgId: string): void {
    this.cache.delete(this.key(userId, orgId));
  }

  /**
   * Invalidate every session this person holds in this workspace.
   *
   * Bumping `sessionVersion` is what makes already-issued access tokens stop
   * working: the guard compares the token's copy against the row's, and any
   * token minted before the bump no longer matches.
   */
  async bumpSessionVersion(userId: string, orgId: string, reason: string): Promise<void> {
    try {
      await this.prisma.membership.updateMany({
        where: { userId, orgId },
        data: { sessionVersion: { increment: 1 } },
      });
    } catch (e) {
      // Loud. A bump that silently failed would leave a demoted admin holding
      // admin, which is the finding itself.
      this.logger.error(
        `Could not invalidate sessions for ${userId} in ${orgId} (${reason}): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      throw e;
    } finally {
      this.invalidate(userId, orgId);
    }
  }

  /** Every workspace this person belongs to, for a password or MFA change. */
  async bumpAllSessions(userId: string, reason: string): Promise<void> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
      take: 100,
    });
    await this.prisma.membership.updateMany({
      where: { userId },
      data: { sessionVersion: { increment: 1 } },
    });
    for (const { orgId } of memberships) this.invalidate(userId, orgId);
    this.logger.log(`Invalidated ${memberships.length} session scope(s) for ${userId}: ${reason}`);
  }
}
