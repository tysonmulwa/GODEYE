import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { AccessTokenPayload } from "../common/jwt-auth.guard";
import { MembersService } from "./members.service";

process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
process.env.WEB_URL = "http://localhost:3000";

function makePrisma() {
  return {
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    invitation: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    organization: { update: jest.fn() },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

const asAuth = (role: AccessTokenPayload["role"], sub = "caller"): AccessTokenPayload => ({
  sub,
  orgId: "org1",
  role,
});

describe("MembersService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: MembersService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new MembersService(
      prisma as never,
      new CryptoService(),
      { log: jest.fn() } as unknown as AuditService,
    );
    prisma.invitation.create.mockImplementation(({ data }: never) =>
      Promise.resolve({ id: "inv1", ...(data as object) }),
    );
  });

  describe("invite", () => {
    it("returns a one-time invite URL and stores only the token hash", async () => {
      const result = await service.invite(asAuth("OWNER"), {
        email: "new@acme.com",
        role: "EDITOR",
      });

      expect(result.inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[0-9a-f]{64}$/);
      const stored = prisma.invitation.create.mock.calls[0][0].data;
      expect(result.inviteUrl).not.toContain(stored.tokenHash);
      expect(stored.tokenHash).toHaveLength(64);
    });

    it("lets an OWNER grant ADMIN but blocks an ADMIN granting ADMIN", async () => {
      await expect(
        service.invite(asAuth("OWNER"), { email: "a@acme.com", role: "ADMIN" }),
      ).resolves.toMatchObject({ role: "ADMIN" });
      await expect(
        service.invite(asAuth("ADMIN"), { email: "b@acme.com", role: "ADMIN" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects inviting an existing member", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u2",
        memberships: [{ id: "m2" }],
      });
      await expect(
        service.invite(asAuth("OWNER"), { email: "member@acme.com", role: "EDITOR" }),
      ).rejects.toThrow(ConflictException);
    });

    it("retires any pending invite for the same email before reissuing", async () => {
      await service.invite(asAuth("OWNER"), { email: "again@acme.com", role: "VIEWER" });
      expect(prisma.invitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ email: "again@acme.com", acceptedAt: null }),
        }),
      );
    });
  });

  describe("changeRole", () => {
    it("refuses to change your own role", async () => {
      await expect(
        service.changeRole(asAuth("OWNER", "caller"), "caller", { role: "ADMIN" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("blocks an ADMIN from touching another ADMIN or the OWNER", async () => {
      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "ADMIN" });
      await expect(
        service.changeRole(asAuth("ADMIN"), "peer", { role: "EDITOR" }),
      ).rejects.toThrow(ForbiddenException);

      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "OWNER" });
      await expect(
        service.changeRole(asAuth("ADMIN"), "boss", { role: "EDITOR" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("lets the OWNER demote an ADMIN", async () => {
      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "ADMIN" });
      await expect(
        service.changeRole(asAuth("OWNER"), "admin-user", { role: "VIEWER" }),
      ).resolves.toEqual({ userId: "admin-user", role: "VIEWER" });
    });
  });

  describe("remove", () => {
    it("never lets the OWNER leave their own org", async () => {
      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "OWNER" });
      await expect(service.remove(asAuth("OWNER", "owner"), "owner")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("lets a non-owner leave the org themselves", async () => {
      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "EDITOR" });
      await expect(service.remove(asAuth("EDITOR", "self"), "self")).resolves.toEqual({
        ok: true,
      });
      expect(prisma.membership.delete).toHaveBeenCalled();
    });

    it("blocks an EDITOR from removing anyone else", async () => {
      prisma.membership.findUnique.mockResolvedValue({ id: "m1", role: "VIEWER" });
      await expect(service.remove(asAuth("EDITOR"), "victim")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
