import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { InviteMemberInput, OrgSettingsInput, UpdateMemberRoleInput } from "@godeye/shared";
import { randomBytes } from "crypto";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { env } from "../common/env";
import { AccessTokenPayload } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { ROLE_RANK, type OrgRole } from "../common/roles.guard";

const INVITE_TTL_DAYS = 7;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  async list(orgId: string) {
    const [memberships, invitations] = await Promise.all([
      this.prisma.membership.findMany({
        where: { orgId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.invitation.findMany({
        where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { invitedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      members: memberships.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedByName: i.invitedBy?.name ?? null,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Create an invite link. The raw token is returned once (inside the URL) and
   * only its sha256 is stored. A pending invite for the same email is replaced.
   */
  async invite(auth: AccessTokenPayload, input: InviteMemberInput) {
    this.assertGrantable(auth.role, input.role);
    await this.billing.assertWithinLimit(auth.orgId, "seats");

    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { memberships: { where: { orgId: auth.orgId }, select: { id: true } } },
    });
    if (existingUser && existingUser.memberships.length > 0) {
      throw new ConflictException("That email already belongs to a member of this organization");
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000);

    const [, invitation] = await this.prisma.$transaction([
      // reissue: retire any still-pending invite for this email
      this.prisma.invitation.updateMany({
        where: { orgId: auth.orgId, email: input.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.invitation.create({
        data: {
          orgId: auth.orgId,
          email: input.email,
          role: input.role,
          tokenHash: this.crypto.sha256(token),
          invitedById: auth.sub,
          expiresAt,
        },
      }),
    ]);

    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "member.invited",
      targetType: "Invitation",
      targetId: invitation.id,
      metadata: { email: input.email, role: input.role },
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: expiresAt.toISOString(),
      inviteUrl: `${env.webUrl}/invite/${token}`,
    };
  }

  async revokeInvitation(auth: AccessTokenPayload, invitationId: string) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, orgId: auth.orgId },
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.acceptedAt) throw new BadRequestException("Invitation was already accepted");

    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "member.invitation_revoked",
      targetType: "Invitation",
      targetId: invitationId,
      metadata: { email: invitation.email },
    });
    return { ok: true };
  }

  async changeRole(auth: AccessTokenPayload, targetUserId: string, input: UpdateMemberRoleInput) {
    if (targetUserId === auth.sub) {
      throw new BadRequestException("You cannot change your own role");
    }
    const target = await this.membership(auth.orgId, targetUserId);
    this.assertOutranks(auth.role, target.role, "change the role of");
    this.assertGrantable(auth.role, input.role);

    await this.prisma.membership.update({
      where: { id: target.id },
      data: { role: input.role },
    });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "member.role_changed",
      targetType: "User",
      targetId: targetUserId,
      metadata: { from: target.role, to: input.role },
    });
    return { userId: targetUserId, role: input.role };
  }

  /** Remove a teammate (must outrank them) — or leave the org yourself (non-owners). */
  async remove(auth: AccessTokenPayload, targetUserId: string) {
    const target = await this.membership(auth.orgId, targetUserId);
    if (targetUserId === auth.sub) {
      if (target.role === "OWNER") {
        throw new BadRequestException("The owner cannot leave their own organization");
      }
    } else {
      // the route allows self-leave for everyone, so admin-ness is enforced here
      if (ROLE_RANK[auth.role] < ROLE_RANK.ADMIN) {
        throw new ForbiddenException("Only admins can remove teammates");
      }
      this.assertOutranks(auth.role, target.role, "remove");
    }

    await this.prisma.membership.delete({ where: { id: target.id } });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: targetUserId === auth.sub ? "member.left" : "member.removed",
      targetType: "User",
      targetId: targetUserId,
      metadata: { role: target.role },
    });
    return { ok: true };
  }

  async updateSettings(auth: AccessTokenPayload, input: OrgSettingsInput) {
    const org = await this.prisma.organization.update({
      where: { id: auth.orgId },
      data: { requireApproval: input.requireApproval },
      select: { requireApproval: true },
    });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "org.settings_updated",
      targetType: "Organization",
      targetId: auth.orgId,
      metadata: { requireApproval: input.requireApproval },
    });
    return org;
  }

  private async membership(orgId: string, userId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException("Member not found in this organization");
    return membership;
  }

  /** Callers may only grant roles strictly below their own (nobody grants OWNER). */
  private assertGrantable(caller: OrgRole, granted: OrgRole): void {
    if (ROLE_RANK[granted] >= ROLE_RANK[caller]) {
      throw new ForbiddenException(`Your role (${caller}) cannot grant the ${granted} role`);
    }
  }

  private assertOutranks(caller: OrgRole, target: OrgRole, verb: string): void {
    if (ROLE_RANK[target] >= ROLE_RANK[caller]) {
      throw new ForbiddenException(`Your role (${caller}) cannot ${verb} a ${target}`);
    }
  }
}
