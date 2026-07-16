import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { LoginInput, RegisterInput } from "@godeye/shared";
import * as argon2 from "argon2";
import { randomBytes } from "crypto";
import { authenticator } from "otplib";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { env } from "../common/env";
import { AccessTokenPayload } from "../common/jwt-auth.guard";
import { PrismaService } from "../common/prisma.service";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_DAYS = 30;

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface SessionResult {
  user: { id: string; email: string; name: string; avatarUrl: string | null; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string; role: string; hasProfile: boolean };
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ---------- Registration & login ----------

  async register(input: RegisterInput, ctx: RequestContext): Promise<SessionResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException("An account with this email already exists");

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const slug = await this.uniqueSlug(input.organizationName);

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        memberships: {
          create: {
            role: "OWNER",
            org: { create: { name: input.organizationName, slug } },
          },
        },
      },
      include: { memberships: { include: { org: true } } },
    });

    const membership = user.memberships[0];
    this.audit.log({
      userId: user.id,
      orgId: membership.orgId,
      action: "auth.register",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.createSession(user, membership.org, membership.role, ctx, false);
  }

  async login(
    input: LoginInput & { mfaCode?: string },
    ctx: RequestContext,
  ): Promise<SessionResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { memberships: { include: { org: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new UnauthorizedException({ code: "MFA_REQUIRED", message: "MFA code required" });
      }
      this.assertValidMfaCode(user.mfaSecret, input.mfaCode);
    }
    const membership = user.memberships[0];
    if (!membership) throw new UnauthorizedException("User has no organization");

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
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    // Rotation: revoke the presented token, issue a fresh one
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const membership = stored.user.memberships[0];
    if (!membership) throw new UnauthorizedException("User has no organization");
    return this.createSession(stored.user, membership.org, membership.role, ctx, undefined);
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
        role: auth.role,
        hasProfile: !!org.businessProfile,
      },
    };
  }

  // ---------- MFA (TOTP) ----------

  async setupMfa(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new BadRequestException("MFA is already enabled");
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: this.crypto.encrypt(secret) },
    });
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, "GODEYE", secret),
    };
  }

  async enableMfa(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    this.assertValidMfaCode(user.mfaSecret, code);
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    this.audit.log({ userId, action: "auth.mfa_enabled" });
  }

  private assertValidMfaCode(encryptedSecret: string | null, code: string): void {
    if (!encryptedSecret) throw new BadRequestException("MFA has not been set up");
    const secret = this.crypto.decrypt(encryptedSecret);
    if (!authenticator.verify({ token: code, secret })) {
      throw new UnauthorizedException("Invalid MFA code");
    }
  }

  // ---------- Internals ----------

  private async createSession(
    user: { id: string; email: string; name: string; avatarUrl: string | null; mfaEnabled: boolean },
    org: { id: string; name: string; slug: string },
    role: string,
    ctx: RequestContext,
    hasProfileOverride: boolean | undefined,
  ): Promise<SessionResult> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      orgId: org.id,
      role: role as AccessTokenPayload["role"],
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: env.jwtAccessSecret(),
      expiresIn: ACCESS_TOKEN_TTL,
    });

    const refreshToken = randomBytes(64).toString("hex");
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.crypto.sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    const hasProfile =
      hasProfileOverride ??
      !!(await this.prisma.businessProfile.findUnique({
        where: { orgId: org.id },
        select: { id: true },
      }));

    return {
      user: this.publicUser(user),
      organization: { id: org.id, name: org.name, slug: org.slug, role, hasProfile },
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
