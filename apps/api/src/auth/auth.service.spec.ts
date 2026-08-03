import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { AuthService } from "./auth.service";

process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";

type MockPrisma = {
  $transaction: jest.Mock;
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
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
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

  describe("disabling MFA", () => {
    const SECRET = "JBSWY3DPEHPK3PXP";

    async function enabledUser() {
      return {
        ...baseUser,
        mfaEnabled: true,
        mfaSecret: new CryptoService().encrypt(SECRET),
        passwordHash: await argon2.hash("correct-horse-9X", { type: argon2.argon2id }),
      };
    }

    it("clears the secret as well as the flag", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await enabledUser());
      prisma.user.update.mockResolvedValue({});
      const code = authenticator.generate(SECRET);

      await service.disableMfa("user1", "correct-horse-9X", code);

      // Leaving the secret would mean re-enabling silently reactivates an old
      // authenticator entry the user may have deleted, or someone else holds.
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mfaEnabled: false, mfaSecret: null } }),
      );
    });

    it("refuses a wrong password even with a valid code", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await enabledUser());
      await expect(
        service.disableMfa("user1", "not-the-password", authenticator.generate(SECRET)),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("refuses a wrong code even with the right password", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await enabledUser());
      await expect(
        service.disableMfa("user1", "correct-horse-9X", "000000"),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("rejects turning off what was never on", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        passwordHash: await argon2.hash("correct-horse-9X", { type: argon2.argon2id }),
      });
      await expect(
        service.disableMfa("user1", "correct-horse-9X", "123456"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("changing your own password", () => {
    const CURRENT = "correct-horse-9X";

    async function existing() {
      return {
        ...baseUser,
        passwordHash: await argon2.hash(CURRENT, { type: argon2.argon2id }),
      };
    }

    const auth = { sub: "user1", orgId: "org1", role: "OWNER" } as never;

    it("refuses without the current password", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      await expect(
        service.changePassword(auth, { currentPassword: "wrong", newPassword: "Brand-New-42x" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("ends the other sessions", async () => {
      // Someone changing their password often thinks another person has it.
      // Leaving those tokens alive keeps that person signed in, which is the
      // one thing this action is for.
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });
      const result = await service.changePassword(auth, {
        currentPassword: CURRENT,
        newPassword: "Brand-New-42x",
      });
      expect(result.sessionsEnded).toBe(3);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    });

    it("keeps the session doing it", async () => {
      // Signing the user out of the tab they are working in would be its own
      // small betrayal, and they have just proved they know the password.
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.changePassword(
        auth,
        { currentPassword: CURRENT, newPassword: "Brand-New-42x" },
        "this-sessions-refresh-token",
      );
      const where = prisma.refreshToken.updateMany.mock.calls[0][0].where;
      expect(where.tokenHash).toEqual({ not: expect.any(String) });
    });

    it("stores a hash, never the password", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await service.changePassword(auth, {
        currentPassword: CURRENT,
        newPassword: "Brand-New-42x",
      });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.passwordHash).toMatch(/^\$argon2id\$/);
      expect(JSON.stringify(data)).not.toContain("Brand-New-42x");
    });
  });

  describe("changing your own email", () => {
    const PASSWORD = "correct-horse-9X";
    const auth = { sub: "user1", orgId: "org1", role: "OWNER" } as never;

    async function existing() {
      return {
        ...baseUser,
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      };
    }

    it("requires the password", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      await expect(
        service.changeEmail(auth, { email: "new@acme.com", password: "wrong" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("refuses an address someone else already uses", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      prisma.user.findUnique.mockResolvedValue({ id: "someone-else" });
      await expect(
        service.changeEmail(auth, { email: "taken@acme.com", password: PASSWORD }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("drops the verification, because the new address has proved nothing", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(await existing());
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.update.mockResolvedValue({ ...baseUser, email: "new@acme.com" });
      await service.changeEmail(auth, { email: "New@Acme.com", password: PASSWORD });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.emailVerifiedAt).toBeNull();
      // Stored lowercase, or the same person could hold two accounts.
      expect(data.email).toBe("new@acme.com");
    });
  });
});
