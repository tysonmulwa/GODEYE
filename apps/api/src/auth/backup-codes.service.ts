import { Injectable, Logger } from "@nestjs/common";
import * as argon2 from "argon2";
import { randomInt } from "crypto";
import { PrismaService } from "../common/prisma.service";
import { mfaBackupCodeUse } from "../common/metrics";

/**
 * Single-use recovery codes for MFA.
 *
 * ASVS 5.0 V2.8.4 and NIST SP 800-63B §5.1.4.3 both require a recovery path for
 * a lost authenticator, and this product had none. Enabling MFA left exactly one
 * way back in — the TOTP app on the phone that enrolled it. A dropped, wiped or
 * replaced phone locked the owner out of a workspace with a live subscription,
 * connected social accounts, and scheduled posts still publishing to the
 * public, with no remedy short of somebody running an UPDATE against production.
 *
 * That is a worse outcome than the risk MFA was turned on for, and it is the
 * reason people turn MFA off.
 */

/** Ten codes. Enough that losing the printout is not immediately fatal, few
 *  enough that a full set is realistically kept somewhere. */
const CODE_COUNT = 10;

/**
 * Crockford base32 without I, L, O, U.
 *
 * These get read off paper and typed by a person who has just lost their phone
 * and is not enjoying it. `0`/`O` and `1`/`I`/`l` are the transcription errors
 * that turn a recovery into a support ticket; U is dropped because its absence
 * is what stops the alphabet spelling things.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 10 characters of that alphabet is ~51.5 bits. */
const CODE_LENGTH = 10;

/** Formatted `XXXXX-XXXXX`: people read grouped digits far more reliably. */
export function formatCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Accept what somebody actually types.
 *
 * The hyphen is presentation, case is not meaningful, and a pasted code brings
 * whitespace with it. Normalising here rather than in the schema means every
 * caller gets the same treatment and none of them has to remember.
 */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

@Injectable()
export class BackupCodesService {
  private readonly logger = new Logger(BackupCodesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One code's worth of randomness.
   *
   * `randomInt` rather than `Math.random()`, and rejection-free because
   * `randomInt(32)` is uniform over exactly the alphabet's length — a modulo of
   * a wider range would bias the first few characters, which is the classic way
   * a token generator quietly loses entropy.
   */
  private generateCode(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    return code;
  }

  /**
   * Issue a fresh set, invalidating every previous one.
   *
   * Returned in the clear **exactly once** — this is the only moment the
   * plaintext exists outside the caller's hands, and the caller has to show them
   * now or never. Stored as argon2id, because a recovery code alone completes a
   * sign-in and is therefore a second password.
   *
   * Regeneration deletes rather than marks used: a set the user has replaced
   * should not be usable, and should not be sitting in the table to be leaked.
   */
  async regenerate(userId: string): Promise<string[]> {
    const codes = Array.from({ length: CODE_COUNT }, () => this.generateCode());
    const hashes = await Promise.all(
      codes.map((code) => argon2.hash(code, { type: argon2.argon2id })),
    );

    await this.prisma.$transaction([
      this.prisma.mfaBackupCode.deleteMany({ where: { userId } }),
      this.prisma.mfaBackupCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);

    mfaBackupCodeUse.add(1, { result: "issued" });
    return codes.map(formatCode);
  }

  /**
   * One verification.
   *
   * A method rather than a direct `argon2.verify` call so the no-short-circuit
   * property below is observable: argon2's exports are non-configurable, so a
   * spy cannot be attached to them, and a property nothing can watch is a
   * property that quietly stops holding.
   */
  protected verifyHash(hash: string, candidate: string): Promise<boolean> {
    return argon2.verify(hash, candidate);
  }

  /** How many are left, for the "you have 3 codes remaining" line. */
  async remaining(userId: string): Promise<number> {
    return this.prisma.mfaBackupCode.count({ where: { userId, usedAt: null } });
  }

  /** Drop every code. Called when MFA is switched off, so nothing outlives it. */
  async revokeAll(userId: string): Promise<void> {
    await this.prisma.mfaBackupCode.deleteMany({ where: { userId } });
  }

  /**
   * Redeem a code. True if it was valid and has now been spent.
   *
   * Single use is enforced by the update's own `where`, not by a read followed
   * by a write: two sign-ins racing with the same code both pass the read, and
   * `updateMany ... where usedAt IS NULL` lets exactly one of them win. The
   * loser sees count 0 and is refused.
   *
   * There is no short-circuit on the first match and no early return on a miss:
   * every unused code is verified, so the time taken does not depend on how far
   * down the list the right one was, or on whether there was one at all.
   */
  async redeem(userId: string, input: string): Promise<boolean> {
    const candidate = normalizeCode(input);
    if (!candidate) return false;

    const codes = await this.prisma.mfaBackupCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
      take: CODE_COUNT * 2,
    });

    let matched: string | null = null;
    for (const { id, codeHash } of codes) {
      let ok = false;
      try {
        ok = await this.verifyHash(codeHash, candidate);
      } catch {
        // A row whose hash will not parse must not abort the loop and lock the
        // account out of its remaining codes. Skipped, and the rest are still
        // checked.
        ok = false;
      }
      if (ok && matched === null) matched = id;
    }

    if (matched === null) {
      mfaBackupCodeUse.add(1, { result: "rejected" });
      return false;
    }

    const spent = await this.prisma.mfaBackupCode.updateMany({
      where: { id: matched, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (spent.count !== 1) {
      // Another request redeemed it between the read and here.
      mfaBackupCodeUse.add(1, { result: "raced" });
      return false;
    }

    const left = await this.remaining(userId);
    if (left === 0) {
      this.logger.warn(`User ${userId} has used their last MFA recovery code`);
    }
    mfaBackupCodeUse.add(1, { result: "redeemed" });
    return true;
  }
}
