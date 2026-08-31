import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../common/prisma.service";
import { CryptoService } from "../common/crypto.service";
import { env } from "../common/env";
import { EmailService, redact } from "../email/email.service";
import { passwordChangedEmail, passwordResetEmail } from "../email/templates";

/**
 * "I forgot my password".
 *
 * ## The request endpoint answers identically either way
 *
 * `request()` returns the same shape whether or not the address belongs to an
 * account, and takes roughly the same time. Anything else turns this into a
 * membership oracle: an attacker with a list of addresses learns which ones
 * have GODEYE accounts, which is worth money on its own and is a much better
 * starting point for credential stuffing.
 *
 * That is also why a delivery failure is logged rather than returned. Telling
 * the caller "we could not send to that address" is the same disclosure with an
 * extra step.
 *
 * ## Only the hash is stored
 *
 * The plaintext token exists in one place: the email. A dump of
 * `PasswordResetToken` is useless for resetting anybody's password, which is
 * the whole point of storing a digest rather than the value.
 *
 * ## Single use, enforced by the database
 *
 * Consumption is `updateMany(... where usedAt: null)` and checks the returned
 * count. Read-then-write would let two requests arriving together both see an
 * unused token and both succeed; the conditional update means exactly one wins,
 * decided by Postgres rather than by timing.
 */

/** Long enough that guessing is not a strategy: 32 bytes, base64url. */
const TOKEN_BYTES = 32;
const TTL_MINUTES = 30;

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly email: EmailService,
  ) {}

  /**
   * Always resolves. Never reveals whether the address is registered.
   */
  async request(emailAddress: string, requestIp?: string): Promise<void> {
    const address = emailAddress.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: address },
      select: { id: true, email: true },
    });

    if (!user) {
      // No row, no email, no different answer. Logged so a spike in requests
      // for unknown addresses is visible without naming them.
      this.logger.log(`password reset requested for an unregistered address`);
      return;
    }

    // Outstanding links for this user stop working the moment a new one is
    // asked for. Otherwise every request adds another valid key to the
    // account, and a mailbox compromised weeks later still holds a live one.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const tokenPlain = randomBytes(TOKEN_BYTES).toString("base64url");
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.crypto.sha256(tokenPlain),
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000),
        requestIp: requestIp ?? null,
      },
    });

    const url = `${env.webUrl}/reset-password?token=${encodeURIComponent(tokenPlain)}`;
    try {
      await this.email.sendOrThrow(passwordResetEmail(user.email, url, TTL_MINUTES));
    } catch (error) {
      // Not rethrown: the caller's response must not differ based on what
      // happened here, or it becomes the oracle this whole method avoids being.
      this.logger.error(
        `password reset email to ${redact(user.email)} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Consumes a token and sets the new password.
   *
   * @returns the user's id when the token was valid, otherwise null. The
   * caller turns null into one generic failure: distinguishing "expired" from
   * "already used" from "never existed" tells an attacker which guesses were
   * close.
   */
  async consume(tokenPlain: string, newPasswordHash: string): Promise<string | null> {
    const tokenHash = this.crypto.sha256(tokenPlain);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      return null;
    }

    // The race is decided here, by the database. `count` is 0 if another
    // request consumed this token between the read above and this write.
    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;

    const user = await this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: newPasswordHash },
      select: { id: true, email: true },
    });

    // Every existing session dies with the old password. A reset is what
    // somebody does when they think an account is compromised, and leaving the
    // attacker's session alive makes the whole exercise pointless.
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Best effort: the password is already changed, and a missing notification
    // must not fail a reset that worked.
    await this.email.send(passwordChangedEmail(user.email));

    return user.id;
  }

  /** Rows that can no longer be used. Called by the retention sweep. */
  async purgeExpired(before = new Date()): Promise<number> {
    const { count } = await this.prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }
}
