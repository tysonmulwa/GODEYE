import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { AuthService } from "./auth.service";

process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";

type MockPrisma = {
  user: Record<string, jest.Mock>;
  organization: Record<string, jest.Mock>;
  refreshToken: Record<string, jest.Mock>;
  businessProfile: Record<string, jest.Mock>;
};

function makePrisma(): MockPrisma {
  return {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    organization: { findUnique: jest.fn().mockResolvedValue(null), findUniqueOrThrow: jest.fn() },
    refreshToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    businessProfile: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

describe("AuthService", () => {
  let prisma: MockPrisma;
  let service: AuthService;

  const org = { id: "org1", name: "Acme", slug: "acme" };
  const baseUser = {
    id: "user1",
    email: "jane@acme.com",
    name: "Jane",
    avatarUrl: null,
    mfaEnabled: false,
    mfaSecret: null,
  };

  beforeEach(() => {
    prisma = makePrisma();
    const crypto = new CryptoService();
    service = new AuthService(
      prisma as never,
      new JwtService({}),
      crypto,
      { log: jest.fn() } as unknown as AuditService,
    );
  });

  it("registers a new user with an organization and returns tokens", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      ...baseUser,
      memberships: [{ orgId: org.id, role: "OWNER", org }],
    });

    const session = await service.register(
      {
        name: "Jane",
        email: "jane@acme.com",
        password: "Str0ngPassw0rd!",
        accountType: "BUSINESS",
        organizationName: "Acme",
      },
      {},
    );

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toHaveLength(128);
    expect(session.organization.role).toBe("OWNER");
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    // password must be hashed, never stored raw
    const createArgs = prisma.user.create.mock.calls[0][0];
    expect(createArgs.data.passwordHash).not.toContain("Str0ngPassw0rd!");
    await expect(argon2.verify(createArgs.data.passwordHash, "Str0ngPassw0rd!")).resolves.toBe(true);
  });

  it("rejects duplicate email registration", async () => {
    prisma.user.findUnique.mockResolvedValue(baseUser);
    await expect(
      service.register(
        {
          name: "J",
          email: "jane@acme.com",
          password: "Str0ngPassw0rd!",
          accountType: "BUSINESS",
          organizationName: "A",
        },
        {},
      ),
    ).rejects.toThrow(ConflictException);
  });

  it("registers a solo creator with a personal workspace named after them", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      ...baseUser,
      memberships: [{ orgId: org.id, role: "OWNER", org: { ...org, type: "CREATOR" } }],
    });

    const session = await service.register(
      {
        name: "Jane",
        email: "jane@acme.com",
        password: "Str0ngPassw0rd!",
        accountType: "CREATOR",
        organizationName: "",
      },
      {},
    );

    const createArgs = prisma.user.create.mock.calls[0][0];
    const orgCreate = createArgs.data.memberships.create.org.create;
    expect(orgCreate.name).toBe("Jane"); // defaults to the creator's own name
    expect(orgCreate.type).toBe("CREATOR");
    expect(session.organization.type).toBe("CREATOR");
  });

  it("requires an organization name for business accounts", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.register(
        {
          name: "J2",
          email: "biz@acme.com",
          password: "Str0ngPassw0rd!",
          accountType: "BUSINESS",
          organizationName: "",
        },
        {},
      ),
    ).rejects.toThrow(/organization name is required/i);
  });

  it("logs in with correct credentials", async () => {
    const passwordHash = await argon2.hash("correct-horse-9X", { type: argon2.argon2id });
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      passwordHash,
      memberships: [{ orgId: org.id, role: "OWNER", org }],
    });
    const session = await service.login({ email: baseUser.email, password: "correct-horse-9X" }, {});
    expect(session.user.email).toBe(baseUser.email);
    expect(session.accessToken).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const passwordHash = await argon2.hash("correct-horse-9X", { type: argon2.argon2id });
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      passwordHash,
      memberships: [{ orgId: org.id, role: "OWNER", org }],
    });
    await expect(
      service.login({ email: baseUser.email, password: "wrong" }, {}),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("requires an MFA code when MFA is enabled", async () => {
    const passwordHash = await argon2.hash("correct-horse-9X", { type: argon2.argon2id });
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      mfaEnabled: true,
      mfaSecret: new CryptoService().encrypt("JBSWY3DPEHPK3PXP"),
      passwordHash,
      memberships: [{ orgId: org.id, role: "OWNER", org }],
    });
    await expect(
      service.login({ email: baseUser.email, password: "correct-horse-9X" }, {}),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rotates refresh tokens (old one is revoked)", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: "rt1",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 100_000),
      user: {
        ...baseUser,
        memberships: [{ orgId: org.id, role: "OWNER", org }],
      },
    });
    const session = await service.refresh("some-refresh-token", {});
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rt1" } }),
    );
    expect(session.refreshToken).toBeTruthy();
  });

  it("rejects an expired refresh token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: "rt1",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: { ...baseUser, memberships: [{ orgId: org.id, role: "OWNER", org }] },
    });
    await expect(service.refresh("stale", {})).rejects.toThrow(UnauthorizedException);
  });
});
