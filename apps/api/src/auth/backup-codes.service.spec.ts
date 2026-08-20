/**
 * MFA recovery codes (ASVS 5.0 V2.8.4, NIST SP 800-63B §5.1.4.3).
 *
 * A recovery code alone completes a sign-in, which makes it a second password
 * rather than a convenience. Everything below follows from that: it is hashed
 * the way a password is, it works exactly once, and it does not outlive the MFA
 * it was issued for.
 */
import * as argon2 from "argon2";
import { BackupCodesService, formatCode, normalizeCode } from "./backup-codes.service";
import type { PrismaService } from "../common/prisma.service";

/**
 * argon2id is deliberately expensive, and this file hashes ten codes per
 * `regenerate` and verifies up to ten per `redeem`. Alone that is a few
 * seconds; under jest's parallel workers, all competing for the same cores, it
 * exceeds the 5s default.
 *
 * Raising the timeout rather than lowering the argon2 cost for tests: the cost
 * IS the control, and a suite that exercises a cheaper hash than production
 * runs is a suite that has stopped testing the thing.
 */
jest.setTimeout(120_000);

/** An in-memory stand-in for the one table this service touches. */
function fakePrisma() {
  let rows: { id: string; userId: string; codeHash: string; usedAt: Date | null }[] = [];
  let next = 0;

  const api = {
    rows: () => rows,
    mfaBackupCode: {
      deleteMany: jest.fn(async ({ where }: { where: { userId: string } }) => {
        const before = rows.length;
        rows = rows.filter((r) => r.userId !== where.userId);
        return { count: before - rows.length };
      }),
      createMany: jest.fn(async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
        for (const row of data) rows.push({ id: `c${next++}`, ...row, usedAt: null });
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: { where: { userId: string; usedAt: null } }) =>
        rows
          .filter((r) => r.userId === where.userId && r.usedAt === null)
          .map(({ id, codeHash }) => ({ id, codeHash })),
      ),
      count: jest.fn(
        async ({ where }: { where: { userId: string; usedAt: null } }) =>
          rows.filter((r) => r.userId === where.userId && r.usedAt === null).length,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; usedAt: null };
          data: { usedAt: Date };
        }) => {
          const row = rows.find((r) => r.id === where.id && r.usedAt === null);
          if (!row) return { count: 0 };
          row.usedAt = data.usedAt;
          return { count: 1 };
        },
      ),
    },
    // The real one is atomic; here it is enough that both statements run.
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return api;
}

describe("formatting", () => {
  it("groups a code so a person can read it off paper", () => {
    expect(formatCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
  });

  it("accepts what somebody actually types", () => {
    // Pasted, lowercased, spaced, unhyphenated — all the same code.
    expect(normalizeCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeCode("ABCDE FGHJK")).toBe("ABCDEFGHJK");
    expect(normalizeCode("abcdefghjk")).toBe("ABCDEFGHJK");
  });
});

describe("BackupCodesService", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: BackupCodesService;

  beforeEach(() => {
    prisma = fakePrisma();
    service = new BackupCodesService(prisma as unknown as PrismaService);
  });

  describe("issuing", () => {
    it("returns ten codes", async () => {
      expect(await service.regenerate("u1")).toHaveLength(10);
    });

    it("returns them formatted, and stores them hashed", async () => {
      const codes = await service.regenerate("u1");
      for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

      // The plaintext must appear nowhere in the table. A reversible store here
      // would make one database read an MFA bypass for every account at once.
      const stored = JSON.stringify(prisma.rows());
      for (const code of codes) {
        expect(stored).not.toContain(normalizeCode(code));
        expect(stored).not.toContain(code);
      }
      for (const row of prisma.rows()) expect(row.codeHash.startsWith("$argon2id$")).toBe(true);
    });

    /** Excluding I, L, O and U is what keeps a transcription from failing. */
    it("uses an alphabet without the characters people misread", async () => {
      const codes = await service.regenerate("u1");
      for (const code of codes) expect(normalizeCode(code)).not.toMatch(/[ILOU]/);
    });

    it("does not issue the same code twice", async () => {
      const codes = await service.regenerate("u1");
      expect(new Set(codes).size).toBe(codes.length);
    });

    /**
     * Two users, two sets, no overlap. A generator seeded per-process, or one
     * using Math.random, would show up here first.
     */
    it("issues different codes to different users", async () => {
      const a = await service.regenerate("u1");
      const b = await service.regenerate("u2");
      expect(a.filter((code) => b.includes(code))).toEqual([]);
    });

    it("invalidates the previous set", async () => {
      const first = await service.regenerate("u1");
      await service.regenerate("u1");
      expect(await service.redeem("u1", first[0])).toBe(false);
      expect(await service.remaining("u1")).toBe(10);
    });
  });

  describe("redeeming", () => {
    it("accepts a valid code", async () => {
      const codes = await service.regenerate("u1");
      expect(await service.redeem("u1", codes[3])).toBe(true);
    });

    it("accepts it however the user typed it", async () => {
      const codes = await service.regenerate("u1");
      expect(await service.redeem("u1", codes[0].toLowerCase().replace("-", " "))).toBe(true);
    });

    /** The single-use property, which is the whole point of the design. */
    it("refuses the same code a second time", async () => {
      const codes = await service.regenerate("u1");
      expect(await service.redeem("u1", codes[0])).toBe(true);
      expect(await service.redeem("u1", codes[0])).toBe(false);
    });

    it("leaves the other nine usable", async () => {
      const codes = await service.regenerate("u1");
      await service.redeem("u1", codes[0]);
      expect(await service.remaining("u1")).toBe(9);
      expect(await service.redeem("u1", codes[1])).toBe(true);
    });

    it("refuses a code that was never issued", async () => {
      await service.regenerate("u1");
      expect(await service.redeem("u1", "ZZZZZ-ZZZZZ")).toBe(false);
    });

    /** Tenant isolation, on a credential. One user's code is not another's. */
    it("refuses another user's code", async () => {
      const mine = await service.regenerate("u1");
      await service.regenerate("u2");
      expect(await service.redeem("u2", mine[0])).toBe(false);
      // And mine is untouched by the attempt.
      expect(await service.redeem("u1", mine[0])).toBe(true);
    });

    it.each(["", "   ", "-"])("refuses %p rather than matching something", async (input) => {
      await service.regenerate("u1");
      expect(await service.redeem("u1", input)).toBe(false);
    });

    it("refuses when the user has no codes at all", async () => {
      expect(await service.redeem("nobody", "ABCDE-FGHJK")).toBe(false);
    });

    /**
     * Two sign-ins racing the same code. Both pass the read; the update's own
     * `where usedAt IS NULL` is what lets exactly one win. A read-then-write
     * without it would let both through, which is the difference between
     * single-use and nearly-single-use.
     */
    it("lets only one of two simultaneous redemptions win", async () => {
      const codes = await service.regenerate("u1");
      const [a, b] = await Promise.all([
        service.redeem("u1", codes[0]),
        service.redeem("u1", codes[0]),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await service.remaining("u1")).toBe(9);
    });

    /**
     * A corrupt row must not lock the account out of its remaining codes. Left
     * unhandled, argon2.verify throws and every code after it goes unchecked.
     */
    it("survives a row whose hash will not parse", async () => {
      const codes = await service.regenerate("u1");
      prisma.rows()[0].codeHash = "not-a-hash";
      expect(await service.redeem("u1", codes[5])).toBe(true);
    });

    /**
     * Constant work regardless of the answer. Returning on the first match
     * would make a hit measurably faster than a miss, and the position of the
     * match observable — this checks the loop does not short-circuit.
     */
    it("verifies every unused code, so timing does not leak the match position", async () => {
      const codes = await service.regenerate("u1");
      const verify = jest.spyOn(
        service as unknown as { verifyHash: (h: string, c: string) => Promise<boolean> },
        "verifyHash",
      );

      await service.redeem("u1", codes[0]); // matches the FIRST row
      const forFirst = verify.mock.calls.length;
      verify.mockClear();

      await service.redeem("u1", codes[9]); // matches the LAST remaining row
      const forLast = verify.mock.calls.length;
      verify.mockRestore();

      // Ten checked when the match was first, nine when it was last — nine
      // because one is already spent. Both verified every row available to
      // them, which is the property: a `break` on match would have made the
      // first call stop at one.
      expect(forFirst).toBe(10);
      expect(forLast).toBe(9);
    });
  });

  describe("revoking", () => {
    /** A code that outlives its MFA is a password-equivalent nobody remembers. */
    it("drops every code, used or not", async () => {
      const codes = await service.regenerate("u1");
      await service.redeem("u1", codes[0]);
      await service.revokeAll("u1");
      expect(prisma.rows()).toHaveLength(0);
      expect(await service.redeem("u1", codes[1])).toBe(false);
    });

    it("leaves another user's codes alone", async () => {
      await service.regenerate("u1");
      const theirs = await service.regenerate("u2");
      await service.revokeAll("u1");
      expect(await service.redeem("u2", theirs[0])).toBe(true);
    });
  });

  describe("counting", () => {
    it("reports how many are left", async () => {
      const codes = await service.regenerate("u1");
      expect(await service.remaining("u1")).toBe(10);
      await service.redeem("u1", codes[0]);
      await service.redeem("u1", codes[1]);
      expect(await service.remaining("u1")).toBe(8);
    });

    it("warns when the last one is spent", async () => {
      const codes = await service.regenerate("u1");
      const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
      for (const code of codes) await service.redeem("u1", code);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await service.remaining("u1")).toBe(0);
      // Ten redemptions, each verifying every remaining hash: argon2 is
      // deliberately slow, so this one needs the room rather than a weaker
      // hash. Lowering the argon2 cost for tests would be tuning the thing
      // under test.
    });
  });
});
