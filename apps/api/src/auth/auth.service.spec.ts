import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import { WorkspaceAccessService } from "../billing/workspace-access.service";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { AuthService } from "./auth.service";
import { LoginBackoffService } from "./login-backoff.service";
import { EmailService } from "../email/email.service";
import { BreachedPasswordService } from "./breached-password.service";
import { BackupCodesService } from "./backup-codes.service";
import { MembershipService } from "../common/membership.service";

// A real 32-byte key. This was "a".repeat(64) — every byte 0xaa — which the
// weak-key check added for S-6 now rejects, correctly. The fixture moved;
// the rule did not weaken.
process.env.TOKEN_ENCRYPTION_KEY = "b3126e1542fa317004bc1c192e87c6afc2bbfae1674ffae2b159df41d7743209";
// >= 32 chars and distinct from each other, because requiredSecret() now
// enforces both (finding S-5). "test-access-secret" was 18 characters, which is
// a length a real deployment could plausibly ship.
process.env.JWT_ACCESS_SECRET = "test-access-secret-0123456789abcdef";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-0123456789abcdef";
process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789ab";

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
  let crypto: CryptoService;
  let audit: { log: jest.Mock };
  let breached: { assertNotBreached: jest.Mock };
  let email: { send: jest.Mock; sendOrThrow: jest.Mock };
  let backupCodes: Record<string, jest.Mock>;
  let service: AuthService;
  let backoff: Record<string, jest.Mock>;
  let memberships: Record<string, jest.Mock>;
  let access: { startTrial: jest.Mock; state: jest.Mock };

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
    crypto = new CryptoService();
    access = {
      startTrial: jest.fn().mockResolvedValue(new Date("2026-01-02T00:00:00.000Z")),
      state: jest.fn().mockResolvedValue({
        status: "TRIALING",
        locked: false,
        trialEndsAt: "2026-01-02T00:00:00.000Z",
        planCode: "PRO",
      }),
    };
    memberships = {
      current: jest.fn().mockResolvedValue({ role: "OWNER", sessionVersion: 0 }),
      invalidate: jest.fn(),
      bumpSessionVersion: jest.fn().mockResolvedValue(undefined),
      bumpAllSessions: jest.fn().mockResolvedValue(undefined),
    };
    backoff = {
      assertNotBackedOff: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn() };
    breached = { assertNotBreached: jest.fn().mockResolvedValue(undefined) };
    email = { send: jest.fn().mockResolvedValue({ sent: true }), sendOrThrow: jest.fn() };
    backupCodes = {
      redeem: jest.fn().mockResolvedValue(false),
      regenerate: jest.fn().mockResolvedValue(["AAAAA-BBBBB"]),
      revokeAll: jest.fn().mockResolvedValue(undefined),
      remaining: jest.fn().mockResolvedValue(10),
    };
    service = new AuthService(
      prisma as never,
      new JwtService({}),
      crypto,
      audit as unknown as AuditService,
      access as unknown as WorkspaceAccessService,
      // Graduated sign-in backoff (NIST SP 800-63B). A no-op here: its own
      // behaviour is covered in login-backoff.service.spec.ts, and stubbing it
      // keeps these tests about what they were about.
      backoff as unknown as LoginBackoffService,
      // S-10: the live membership, which is what authorization now follows.
      memberships as unknown as MembershipService,
      // Breach screening (NIST SP 800-63B 5.1.1.2). A permissive stub, so
      // these tests keep failing for the reason they were written for rather
      // than because a fixture password happens to be in a corpus. The
      // service's own behaviour -- k-anonymity, fail-open, the padding entries
      // -- is covered in breached-password.service.spec.ts.
      breached as unknown as BreachedPasswordService,
      // Transactional email. Records what would have been sent so the welcome
      // message can be asserted, and never throws -- which is the property the
      // real service guarantees too, because a failed courtesy email must not
      // fail a registration that already wrote three rows.
      email as unknown as EmailService,
      // Recovery codes. redeem() returns false here, so the TOTP path is the
      // one every existing MFA test exercises -- unchanged. The codes' own
      // behaviour is covered in backup-codes.service.spec.ts.
      backupCodes as unknown as BackupCodesService,
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

  it("puts a brand new workspace on its trial and reports it in the session", async () => {
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

    expect(access.startTrial).toHaveBeenCalledWith(org.id);
    expect(session.organization.access).toEqual(
      expect.objectContaining({ status: "TRIALING", locked: false }),
    );
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
        // AAD is the user the secret belongs to, so a TOTP secret lifted from
        // one row cannot be decrypted against another (NIST SP 800-38D).
        mfaSecret: new CryptoService().encrypt(SECRET, `user:${baseUser.id}`),
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

    it("refuses a code that has already been used (S-19)", async () => {
      // A code accepted every time it was presented inside its window meant one
      // observed over a shoulder, read from a notification, or captured by a
      // phishing proxy stayed usable. A replayable second factor is a second
      // factor in name only.
      prisma.user.findUniqueOrThrow.mockResolvedValue(await enabledUser());
      prisma.user.update.mockResolvedValue({});
      const code = authenticator.generate(SECRET);

      await service.disableMfa("user1", "correct-horse-9X", code);

      prisma.user.findUniqueOrThrow.mockResolvedValue(await enabledUser());
      await expect(service.disableMfa("user1", "correct-horse-9X", code)).rejects.toThrow(
        /already been used/i,
      );
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

  describe("editing your own profile", () => {
    const auth = { sub: "user1", orgId: "org1", role: "OWNER" } as never;

    it("saving a name does not wipe the avatar", async () => {
      // The card sends only the name. Coalescing an absent avatar to null
      // would clear the picture every time someone fixed a typo.
      prisma.user.update.mockResolvedValue({ ...baseUser, name: "Jane R" });
      await service.updateProfile(auth, { name: "Jane R" });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("avatarUrl");
      expect(data.name).toBe("Jane R");
    });

    it("an explicit blank does clear it, because that is somebody asking", async () => {
      prisma.user.update.mockResolvedValue(baseUser);
      await service.updateProfile(auth, { name: "Jane", avatarUrl: "" });
      expect(prisma.user.update.mock.calls[0][0].data.avatarUrl).toBeNull();
    });
  });


  /**
   * The screening is wired in, on every path that sets a password.
   *
   * A service that exists and is never called is the exact shape of S-1: five
   * controllers where @MinRole compiled, read correctly in review, and enforced
   * nothing because the guard reading it was not in the chain. A breach check
   * nobody invokes is the same defect with a different name, and its own unit
   * tests would still be green.
   */
  describe("breached-password screening is actually called", () => {
    it("screens on registration", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        ...baseUser,
        memberships: [{ orgId: org.id, role: "OWNER", org }],
      });
      await service.register(
        {
          name: "Jane",
          email: "jane@acme.com",
          password: "Str0ngPassw0rd!",
          accountType: "BUSINESS",
          organizationName: "Acme",
        },
        {},
      );
      expect(breached.assertNotBreached).toHaveBeenCalledWith("Str0ngPassw0rd!");
    });

    /**
     * And the rejection has to reach the caller. Screening that logs and
     * continues is screening that does nothing.
     */
    it("refuses to register when the password is breached", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      breached.assertNotBreached.mockRejectedValueOnce(new Error("PASSWORD_BREACHED"));
      await expect(
        service.register(
          {
            name: "Jane",
            email: "jane@acme.com",
            password: "Password12",
            accountType: "BUSINESS",
            organizationName: "Acme",
          },
          {},
        ),
      ).rejects.toThrow();
      // And nothing was written. The check runs before the hash for exactly this
      // reason: a rejected password must not leave a row behind.
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  /**
   * Recovery codes, from the AuthService side. The codes' own behaviour lives
   * in backup-codes.service.spec.ts; what matters here is that they are wired
   * into the three moments that decide whether an account is recoverable.
   */
  describe("MFA recovery codes", () => {
    it("hands the codes back when MFA is turned on", async () => {
      const secret = authenticator.generateSecret();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        mfaSecret: crypto.encrypt(secret, `user:${baseUser.id}`),
      });
      const result = await service.enableMfa(baseUser.id, authenticator.generate(secret));
      // Enrolling without them is how an account becomes unrecoverable the
      // moment a phone is replaced, so they are part of enabling rather than a
      // separate step somebody skips.
      expect(backupCodes.regenerate).toHaveBeenCalledWith(baseUser.id);
      expect(result.backupCodes).toEqual(["AAAAA-BBBBB"]);
    });

    it("revokes them when MFA is turned off", async () => {
      const secret = authenticator.generateSecret();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        mfaEnabled: true,
        mfaSecret: crypto.encrypt(secret, `user:${baseUser.id}`),
        passwordHash: await argon2.hash("Str0ngPassw0rd!", { type: argon2.argon2id }),
      });
      await service.disableMfa(baseUser.id, "Str0ngPassw0rd!", authenticator.generate(secret));
      // A code that outlives the MFA it was issued for is a password-equivalent
      // credential nobody remembers exists.
      expect(backupCodes.revokeAll).toHaveBeenCalledWith(baseUser.id);
    });

    describe("reissuing", () => {
      beforeEach(async () => {
        prisma.user.findUniqueOrThrow.mockResolvedValue({
          ...baseUser,
          mfaEnabled: true,
          passwordHash: await argon2.hash("Str0ngPassw0rd!", { type: argon2.argon2id }),
        });
      });

      it("issues a fresh set", async () => {
        const result = await service.regenerateBackupCodes(baseUser.id, "Str0ngPassw0rd!");
        expect(result.backupCodes).toEqual(["AAAAA-BBBBB"]);
      });

      /**
       * This endpoint hands out credentials that each complete a sign-in on
       * their own. A borrowed unlocked laptop has the session but not the
       * password, and must not be enough to mint a fresh set and walk off.
       */
      it("requires the password, not just a session", async () => {
        await expect(
          service.regenerateBackupCodes(baseUser.id, "not-the-password"),
        ).rejects.toThrow();
        expect(backupCodes.regenerate).not.toHaveBeenCalled();
      });

      it("refuses when MFA is not enabled", async () => {
        prisma.user.findUniqueOrThrow.mockResolvedValue({
          ...baseUser,
          mfaEnabled: false,
          passwordHash: await argon2.hash("Str0ngPassw0rd!", { type: argon2.argon2id }),
        });
        await expect(
          service.regenerateBackupCodes(baseUser.id, "Str0ngPassw0rd!"),
        ).rejects.toThrow();
      });
    });

    describe("signing in with one", () => {
      beforeEach(async () => {
        prisma.user.findUnique.mockResolvedValue({
          ...baseUser,
          mfaEnabled: true,
          mfaSecret: crypto.encrypt(authenticator.generateSecret(), `user:${baseUser.id}`),
          passwordHash: await argon2.hash("Str0ngPassw0rd!", { type: argon2.argon2id }),
          memberships: [{ orgId: org.id, role: "OWNER", org }],
        });
      });

      it("accepts a recovery code in place of a TOTP code", async () => {
        backupCodes.redeem.mockResolvedValue(true);
        const session = await service.login(
          { email: "jane@acme.com", password: "Str0ngPassw0rd!", mfaCode: "AAAAA-BBBBB" },
          {},
        );
        expect(session.accessToken).toBeTruthy();
      });

      it("records it, because it means somebody lost their authenticator", async () => {
        backupCodes.redeem.mockResolvedValue(true);
        await service.login(
          { email: "jane@acme.com", password: "Str0ngPassw0rd!", mfaCode: "AAAAA-BBBBB" },
          {},
        );
        expect(audit.log).toHaveBeenCalledWith(
          expect.objectContaining({ action: "auth.mfa_backup_code_used" }),
        );
      });

      /**
       * Redeeming is destructive and a code cannot be recovered, so the common
       * case -- a working authenticator -- must never spend one.
       */
      it("still refuses a wrong code when no recovery code matches", async () => {
        backupCodes.redeem.mockResolvedValue(false);
        await expect(
          service.login(
            { email: "jane@acme.com", password: "Str0ngPassw0rd!", mfaCode: "000000" },
            {},
          ),
        ).rejects.toThrow();
        // And a failed second factor is still a failed sign-in.
        expect(backoff.recordFailure).toHaveBeenCalled();
      });
    });
  });

});
