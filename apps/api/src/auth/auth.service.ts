import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  passwordSchema,
  type AcceptInvitationInput,
  type ChangeEmailInput,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
  type UpdateProfileInput,
  type WorkspaceAccess,
} from "@godeye/shared";
import * as argon2 from "argon2";
import { randomBytes } from "crypto";
import { authenticator } from "otplib";
import { WorkspaceAccessService } from "../billing/workspace-access.service";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { env } from "../common/env";
import { AccessTokenPayload } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";
import { refreshTokenReuse } from "../common/metrics";
import { signToken } from "../common/tokens";
import { LoginBackoffService } from "./login-backoff.service";
import { BreachedPasswordService } from "./breached-password.service";
import { MembershipService } from "../common/membership.service";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface SessionResult {
  user: { id: string; email: string; name: string; avatarUrl: string | null; mfaEnabled: boolean };
  organization: {
    id: string;
    name: string;
    slug: string;
    role: string;
    type: string;
    hasProfile: boolean;
    requireApproval: boolean;
    /** Trial clock and read-only state, so the app can say what is happening
     *  before the first refused request rather than after it. */
    access: WorkspaceAccess;
  };
  accessToken: string;
  refreshToken: string;
}

/**
 * How long a used TOTP code stays refused: the 30-second step plus one step of
 * drift either side, which is the whole span in which it could be accepted.
 */
const MFA_REPLAY_WINDOW_MS = 90_000;

@Injectable()
export class AuthService {
  /** `<userId>:<sha256(code)>` -> when it stops being worth remembering. */
  private readonly consumedMfaCodes = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly access: WorkspaceAccessService,
    private readonly backoff: LoginBackoffService,
    private readonly memberships: MembershipService,
    private readonly breached: BreachedPasswordService,
  ) {}

  // ---------- Registration & login ----------

  async register(input: RegisterInput, ctx: RequestContext): Promise<SessionResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException("An account with this email already exists");

    const accountType = input.accountType ?? "BUSINESS";
    // Solo creators get a personal workspace named after them unless they set a brand name
    const orgName = input.organizationName?.trim() || input.name;
    if (accountType === "BUSINESS" && !input.organizationName?.trim()) {
      throw new BadRequestException("Business / organization name is required");
    }

    // NIST SP 800-63B 5.1.1.2. Before the hash, so a breached password is
    // never written -- not even briefly, and not into a row that a failed
    // transaction might leave behind.
    await this.breached.assertNotBreached(input.password);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const slug = await this.uniqueSlug(orgName);

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        memberships: {
          create: {
            role: "OWNER",
            org: { create: { name: orgName, slug, type: accountType } },
          },
        },
      },
      include: { memberships: { include: { org: true } } },
    });

    const membership = user.memberships[0];

    // The workspace starts its 24 hours here, not on first publish and not on
    // first login. Recorded as a TRIALING subscription with an end date, so the
    // clock is a row anyone can read rather than an assumption about createdAt.
    const trialEndsAt = await this.access.startTrial(membership.orgId);

    this.audit.log({
      userId: user.id,
      orgId: membership.orgId,
      action: "auth.register",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { trialEndsAt: trialEndsAt?.toISOString() ?? null },
    });
    return this.createSession(user, membership.org, membership.role, ctx, false);
  }

  async login(
    input: LoginInput & { mfaCode?: string },
    ctx: RequestContext,
  ): Promise<SessionResult> {
    // Before the password check, and before the database read: an account or a
    // client address inside its cool-off gets the same answer whether or not
    // the account exists (NIST SP 800-63B §5.2.2).
    await this.backoff.assertNotBackedOff(input.email, ctx.ip);

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { memberships: { include: { org: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      await this.backoff.recordFailure(input.email, ctx.ip);
      throw new UnauthorizedException("Invalid email or password");
    }
    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new UnauthorizedException({ code: "MFA_REQUIRED", message: "MFA code required" });
      }
      try {
        this.assertValidMfaCode(user.mfaSecret, input.mfaCode, user.id);
      } catch (e) {
        // A wrong second factor is a failed sign-in. Not counting it would
        // leave the MFA code guessable at the full route-throttle rate.
        await this.backoff.recordFailure(input.email, ctx.ip);
        throw e;
      }
    }
    const membership = user.memberships[0];
    if (!membership) throw new UnauthorizedException("User has no organization");

    await this.backoff.recordSuccess(input.email);
    this.audit.log({
      userId: user.id,
      orgId: membership.orgId,
      action: "auth.login",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.createSession(user, membership.org, membership.role, ctx, undefined);
  }

  // ---------- Refresh token rotation ----------

  async refresh(refreshTokenPlain: string, ctx: RequestContext): Promise<SessionResult> {
    const tokenHash = this.crypto.sha256(refreshTokenPlain);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: { include: { memberships: { include: { org: true }, orderBy: { createdAt: "asc" } } } },
      },
    });
    if (!stored) throw new UnauthorizedException("Invalid refresh token");

    if (stored.revokedAt) {
      // S-15. An already-rotated token being presented means one of two things:
      // the legitimate holder replayed an old value, or somebody else holds a
      // copy. They are indistinguishable from here and one of them is theft, so
      // the whole family is revoked and everybody re-authenticates. Rejecting
      // just the token, which is what happened before, left the thief's rotated
      // copy live and told nobody (RFC 9700 4.14.2).
      // Pages. Either a client replayed an old value or somebody else holds a
      // copy; they are indistinguishable from here and one of them is theft.
      refreshTokenReuse.add(1);
      if (stored.familyId) {
        const { count } = await this.prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.audit.log({
          userId: stored.userId,
          orgId: stored.orgId ?? undefined,
          action: "auth.refresh_reuse_detected",
          targetType: "RefreshToken",
          targetId: stored.familyId,
          metadata: { revoked: count } as never,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    // Rotation: revoke the presented token, issue a fresh one.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    // B-1: back to the workspace this session was actually scoped to. `orgId`
    // is null only for rows written before the column existed; those fall back
    // to the old behaviour for one rotation and are correct after it.
    const membership =
      (stored.orgId && stored.user.memberships.find((m) => m.orgId === stored.orgId)) ||
      stored.user.memberships[0];
    if (!membership) throw new UnauthorizedException("User has no organization");

    // The role is re-read here too, so a demotion reaches the next access token
    // rather than surviving another fifteen minutes.
    return this.createSession(
      stored.user,
      membership.org,
      membership.role,
      ctx,
      undefined,
      stored.familyId ?? undefined,
    );
  }

  async logout(refreshTokenPlain: string | undefined): Promise<void> {
    if (!refreshTokenPlain) return;
    const tokenHash = this.crypto.sha256(refreshTokenPlain);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---------- Current session ----------

  async me(auth: AccessTokenPayload) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    // The role the DATABASE holds, not the token's copy (S-10). Echoing the
    // token meant the UI agreed with a claim that had already been revoked, and
    // showed a demoted admin controls they could no longer use.
    const live = await this.memberships.current(auth.sub, auth.orgId);
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: auth.orgId },
      include: { businessProfile: { select: { id: true } } },
    });
    return {
      user: this.publicUser(user),
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: live?.role ?? auth.role,
        type: org.type,
        hasProfile: !!org.businessProfile,
        requireApproval: org.requireApproval,
        access: await this.access.state(org.id),
      },
    };
  }

  // ---------- Your own account ----------

  async updateProfile(auth: AccessTokenPayload, input: UpdateProfileInput) {
    const user = await this.prisma.user.update({
      where: { id: auth.sub },
      data: {
        name: input.name,
        // Only touched when the caller sent it. Coalescing an absent field to
        // null would clear an existing avatar every time somebody corrected a
        // typo in their name, which is not what saving a name should do. An
        // explicit "" still clears it, because that is somebody asking.
        ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl || null }),
      },
    });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "account.profile_updated",
      targetType: "User",
      targetId: auth.sub,
    });
    return this.publicUser(user);
  }

  /**
   * Change the password, and end every other session while doing it.
   *
   * Someone changing their password is often doing it because they think
   * somebody else has it. Leaving the other refresh tokens alive would keep
   * that person signed in, which is the one outcome the action is meant to
   * prevent. The caller's own session survives, so they are not signed out of
   * the tab they just did this in.
   */
  async changePassword(
    auth: AccessTokenPayload,
    input: ChangePasswordInput,
    keepRefreshToken?: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException("That is not your current password");
    }

    await this.breached.assertNotBreached(input.newPassword);
    const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    // Retires every access token already issued, in every workspace. Revoking
    // the refresh tokens alone left the current ones working for up to fifteen
    // more minutes — which is exactly the window somebody changing a password
    // under duress is trying to close (S-10).
    await this.memberships.bumpAllSessions(auth.sub, "password changed");
    // Everything except the session doing this. Signing the user out of the
    // tab they are working in would be its own small betrayal, and they have
    // just proved they know the password.
    const keepHash = keepRefreshToken ? this.crypto.sha256(keepRefreshToken) : null;
    const [, revoked] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: auth.sub }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: {
          userId: auth.sub,
          revokedAt: null,
          ...(keepHash ? { tokenHash: { not: keepHash } } : {}),
        },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "account.password_changed",
      targetType: "User",
      targetId: auth.sub,
      metadata: { sessionsEnded: revoked.count },
    });
    return { ok: true, sessionsEnded: revoked.count };
  }

  async changeEmail(auth: AccessTokenPayload, input: ChangeEmailInput) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (!(await argon2.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException("That password is not correct");
    }

    const email = input.email.toLowerCase().trim();
    if (email === user.email) return this.publicUser(user);

    const taken = await this.prisma.user.findUnique({ where: { email } });
    if (taken) throw new ConflictException("That email is already in use");

    const updated = await this.prisma.user.update({
      where: { id: auth.sub },
      // The new address has not been proven to belong to anyone yet, so the
      // verification does not carry over from the old one.
      data: { email, emailVerifiedAt: null },
    });
    this.audit.log({
      orgId: auth.orgId,
      userId: auth.sub,
      action: "account.email_changed",
      targetType: "User",
      targetId: auth.sub,
      metadata: { from: user.email, to: email },
    });
    return this.publicUser(updated);
  }

  // ---------- Invitations ----------

  /** Public preview of an invite link: who invited you, to which org, as what role. */
  async previewInvitation(tokenPlain: string) {
    const invitation = await this.validInvitation(tokenPlain);
    // `accountExists` used to be returned here. It is a user-enumeration oracle
    // (S-16, CWE-204): anyone holding any invite token could ask whether a given
    // address has an account. The accept flow handles both cases without being
    // told which - it asks for a password either way, and the answer decides.
    return {
      orgName: invitation.org.name,
      email: invitation.email,
      role: invitation.role,
      inviterName: invitation.invitedBy?.name ?? null,
    };
  }

  /**
   * Accept an invite. New emails create an account (name + strong password
   * required); existing accounts verify their current password (+ MFA when
   * enabled). Either way the caller ends up logged into the inviting org.
   */
  async acceptInvitation(input: AcceptInvitationInput, ctx: RequestContext): Promise<SessionResult> {
    const invitation = await this.validInvitation(input.token);

    let user = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      include: { memberships: { select: { orgId: true } } },
    });

    if (user) {
      if (!(await argon2.verify(user.passwordHash, input.password))) {
        throw new UnauthorizedException("Invalid password for the invited account");
      }
      if (user.mfaEnabled) {
        if (!input.mfaCode) {
          throw new UnauthorizedException({ code: "MFA_REQUIRED", message: "MFA code required" });
        }
        this.assertValidMfaCode(user.mfaSecret, input.mfaCode, user.id);
      }
      if (user.memberships.some((m) => m.orgId === invitation.orgId)) {
        await this.markInvitationAccepted(invitation.id);
        throw new ConflictException("You are already a member of this organization");
      }
    } else {
      if (!input.name) throw new BadRequestException("name is required to create your account");
      const parsed = passwordSchema.safeParse(input.password);
      if (!parsed.success) {
        throw new BadRequestException(parsed.error.issues[0]?.message ?? "Password too weak");
      }
      await this.breached.assertNotBreached(input.password);
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      user = await this.prisma.user.create({
        data: { email: invitation.email, passwordHash, name: input.name },
        include: { memberships: { select: { orgId: true } } },
      });
    }

    const [membership] = await this.prisma.$transaction([
      this.prisma.membership.create({
        data: { userId: user.id, orgId: invitation.orgId, role: invitation.role },
      }),
      this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    this.audit.log({
      userId: user.id,
      orgId: invitation.orgId,
      action: "member.joined",
      targetType: "Invitation",
      targetId: invitation.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { role: invitation.role },
    });
    return this.createSession(user, invitation.org, membership.role, ctx, undefined);
  }

  // ---------- Multi-org ----------

  async listOrgs(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { org: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: "asc" },
      // Somebody in more workspaces than this is a support conversation, not a
      // page render (D-4: no query's cost may be set by how long a customer has
      // been here).
      take: 100,
    });
    return memberships.map((m) => ({
      orgId: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      role: m.role,
    }));
  }

  /** Issue a fresh session scoped to another org the user belongs to. */
  async switchOrg(userId: string, orgId: string, ctx: RequestContext): Promise<SessionResult> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { org: true, user: true },
    });
    if (!membership) throw new NotFoundException("You are not a member of that organization");
    return this.createSession(membership.user, membership.org, membership.role, ctx, undefined);
  }

  private async validInvitation(tokenPlain: string) {
    const tokenHash = this.crypto.sha256(tokenPlain);
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: {
        org: true,
        invitedBy: { select: { name: true } },
      },
    });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt) {
      throw new NotFoundException("This invitation is no longer valid");
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException("This invitation has expired, ask for a new one");
    }
    return invitation;
  }

  private async markInvitationAccepted(id: string): Promise<void> {
    await this.prisma.invitation.update({ where: { id }, data: { acceptedAt: new Date() } });
  }

  // ---------- MFA (TOTP) ----------

  async setupMfa(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new BadRequestException("MFA is already enabled");
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: this.crypto.encrypt(secret, `user:${userId}`) },
    });
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, "GODEYE", secret),
    };
  }

  async enableMfa(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    this.assertValidMfaCode(user.mfaSecret, code, userId);
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    // Turning MFA on changes what a session is worth; sessions that predate it
    // were established without it.
    await this.memberships.bumpAllSessions(userId, "MFA enabled");
    this.audit.log({ userId, action: "auth.mfa_enabled" });
  }

  /**
   * Turn MFA off. Requires the account password and a current code.
   *
   * Both, because either alone is a way in: a borrowed unlocked laptop has the
   * session but not the password, and a leaked password has no authenticator.
   * Disabling is the one action that removes the protection guarding everything
   * else, so it asks for proof of both factors it is about to stop requiring.
   *
   * The secret is cleared as well as the flag. Leaving it would mean re-enabling
   * silently reactivates an old authenticator entry the user may have deleted,
   * or that someone else still holds.
   */
  async disableMfa(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled) throw new BadRequestException("MFA is not enabled");
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException("Incorrect password");
    }
    this.assertValidMfaCode(user.mfaSecret, code, userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    await this.memberships.bumpAllSessions(userId, "MFA disabled");
    this.audit.log({ userId, action: "auth.mfa_disabled" });
  }

  /**
   * Verify a TOTP code, once. Finding S-19.
   *
   * A code was accepted every time it was presented inside its window, so one
   * observed over a shoulder, read from a notification, or captured in a
   * phishing proxy stayed usable for the rest of that window. A second factor
   * that can be replayed is a second factor in name only.
   *
   * `consumedMfaCodes` is deliberately in-process. It is a small, bounded map
   * and the window is 90 seconds; the cost of getting it wrong across replicas
   * is that a code could be replayed once on a *different* instance, which is a
   * far smaller window than the one being closed. Moving it to Redis is a
   * one-line change if that ever matters.
   */
  private assertValidMfaCode(
    encryptedSecret: string | null,
    code: string,
    userId: string,
  ): void {
    if (!encryptedSecret) throw new BadRequestException("MFA has not been set up");
    const secret = this.crypto.decrypt(encryptedSecret, `user:${userId}`);

    // otplib's default window is 1 step either side (±30s), which is the drift
    // tolerance NIST SP 800-63B §5.1.4.1 expects. Stated rather than inherited.
    authenticator.options = { window: 1 };
    if (!authenticator.verify({ token: code, secret })) {
      throw new UnauthorizedException("Invalid MFA code");
    }

    const fingerprint = `${userId}:${this.crypto.sha256(code)}`;
    this.forgetExpiredMfaCodes();
    if (this.consumedMfaCodes.has(fingerprint)) {
      throw new UnauthorizedException("That code has already been used");
    }
    this.consumedMfaCodes.set(fingerprint, Date.now() + MFA_REPLAY_WINDOW_MS);
  }

  private forgetExpiredMfaCodes(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumedMfaCodes) {
      if (expiresAt <= now) this.consumedMfaCodes.delete(key);
    }
  }

  // ---------- Internals ----------

  private async createSession(
    user: { id: string; email: string; name: string; avatarUrl: string | null; mfaEnabled: boolean },
    org: { id: string; name: string; slug: string; type?: string; requireApproval?: boolean },
    role: string,
    ctx: RequestContext,
    hasProfileOverride: boolean | undefined,
    /** Continues an existing rotation chain; a fresh login starts a new one. */
    familyId?: string,
  ): Promise<SessionResult> {
    // The membership's current version travels in the token. RolesGuard
    // compares it against the row, so bumping the row retires every token
    // minted before the bump (S-10).
    const live = await this.memberships.current(user.id, org.id);
    const payload: AccessTokenPayload = {
      sub: user.id,
      orgId: org.id,
      role: role as AccessTokenPayload["role"],
      sv: live?.sessionVersion ?? 0,
    };
    // signToken stamps typ/iss/aud. JwtAuthGuard demands all three, so a token
    // minted for any other purpose — an OAuth state, an invite — cannot be
    // presented as a session (finding C-1).
    const accessToken = await signToken(this.jwt, "access", payload, ACCESS_TOKEN_TTL);

    const refreshToken = randomBytes(64).toString("hex");
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        // B-1: the row records WHICH workspace this session is for. Without it
        // refresh() returned memberships[0], silently moving an agency user
        // back to their first client - and the next post went to that client's
        // channels.
        orgId: org.id,
        // S-15: every token rotated from one login shares a family, so reuse of
        // a rotated token can revoke the whole chain rather than one token.
        familyId: familyId ?? randomBytes(16).toString("hex"),
        tokenHash: this.crypto.sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    const [hasProfile, access] = await Promise.all([
      hasProfileOverride !== undefined
        ? Promise.resolve(hasProfileOverride)
        : this.prisma.businessProfile
            .findUnique({ where: { orgId: org.id }, select: { id: true } })
            .then((p) => !!p),
      this.access.state(org.id),
    ]);

    return {
      user: this.publicUser(user),
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role,
        type: org.type ?? "BUSINESS",
        hasProfile,
        requireApproval: org.requireApproval ?? false,
        access,
      },
      accessToken,
      refreshToken,
    };
  }

  private publicUser(user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    mfaEnabled: boolean;
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      mfaEnabled: user.mfaEnabled,
    };
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "org";
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const exists = await this.prisma.organization.findUnique({ where: { slug } });
      if (!exists) return slug;
      slug = `${base}-${randomBytes(3).toString("hex")}`;
    }
    return `${base}-${randomBytes(6).toString("hex")}`;
  }
}
