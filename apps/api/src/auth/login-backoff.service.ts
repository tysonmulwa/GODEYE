import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { env } from "../common/env";
import { loginBackoffRefusals } from "../common/metrics";

/**
 * Graduated backoff on failed sign-in, per account and per client address.
 *
 * The route throttle caps attempts per caller, which is the wrong axis on its
 * own: credential stuffing spreads one guess per address across thousands of
 * addresses, and every one of them stays under a per-caller limit. Counting
 * failures against the *account* closes that, and counting them against the
 * address as well keeps a single host from working through an address book.
 *
 * The delay grows with consecutive failures and resets on success, which is
 * NIST SP 800-63B §5.2.2's shape: make guessing expensive without giving an
 * attacker a way to lock a real person out permanently. The cap is 15 minutes
 * for exactly that reason — an unbounded lockout is a denial-of-service someone
 * else can trigger on your behalf.
 */

/** Failures tolerated before any delay. Room for a genuinely forgotten password. */
const FREE_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 15;
const MAX_DELAY_SECONDS = 15 * 60;
/** A counter with no failures for this long is forgotten. */
const WINDOW_SECONDS = 60 * 60;

/**
 * `2^n` seconds once the free attempts are spent, capped at 15 minutes.
 *
 * Exported and pure so the curve is testable without a Redis. The cap is not a
 * detail: an unbounded lockout is a denial-of-service anybody can trigger
 * against a real person by guessing at their address.
 */
export function backoffDelaySeconds(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const step = failures - FREE_ATTEMPTS;
  return Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** (step - 1));
}

@Injectable()
export class LoginBackoffService {
  private readonly logger = new Logger(LoginBackoffService.name);
  private client?: Redis;
  private warned = false;

  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times > 2 ? null : 100),
        enableOfflineQueue: false,
      });
      this.client.on("error", () => {
        // Reported per command; an unhandled 'error' event kills the process.
      });
    }
    return this.client;
  }


  private keys(email: string, ip: string | undefined): string[] {
    return [`login:fail:acct:${email.trim().toLowerCase()}`, `login:fail:ip:${ip ?? "unknown"}`];
  }

  /**
   * Refuse early if this account or address is inside its cool-off.
   *
   * Throws 429 with `Retry-After`. Deliberately the same answer for an account
   * that exists and one that does not, so this cannot be used to enumerate
   * users (CWE-204).
   */
  async assertNotBackedOff(email: string, ip: string | undefined): Promise<void> {
    let counts: (string | null)[];
    try {
      counts = await this.redis().mget(...this.keys(email, ip));
    } catch (e) {
      return this.onStoreFailure(e);
    }
    const worst = Math.max(...counts.map((c) => Number(c ?? 0)));
    const delay = backoffDelaySeconds(worst);
    if (delay <= 0) return;

    // The counter's own TTL is the window; the delay is compared against how
    // long ago the last failure was, which is what `pttl` on the key encodes.
    let elapsed: number;
    try {
      const ttls = await Promise.all(
        this.keys(email, ip).map((k) => this.redis().pttl(k).catch(() => -1)),
      );
      const remaining = Math.max(...ttls);
      // `pttl` answers -1 for a key with no expiry and -2 for a key that is
      // not there, and neither says anything about how long ago the last
      // failure was. Treat that as NO time served, not as fully served: the
      // latter reads "the whole window has passed" and silently switches the
      // delay off for that key — which is what a partially-failed pipeline
      // (incr applied, expire not) would produce. Being conservative costs
      // nothing here, because the 15-minute cap already bounds how long anyone
      // can be held out.
      elapsed = remaining > 0 ? WINDOW_SECONDS - Math.ceil(remaining / 1000) : 0;
    } catch {
      elapsed = 0;
    }
    const wait = delay - elapsed;
    if (wait <= 0) return;

    loginBackoffRefusals.add(1);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "TOO_MANY_ATTEMPTS",
        message: `Too many sign-in attempts. Try again in ${wait} seconds.`,
        retryAfter: wait,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Count a failure against both the account and the address. */
  async recordFailure(email: string, ip: string | undefined): Promise<void> {
    try {
      const pipeline = this.redis().pipeline();
      for (const key of this.keys(email, ip)) {
        pipeline.incr(key);
        pipeline.expire(key, WINDOW_SECONDS);
      }
      await pipeline.exec();
    } catch (e) {
      this.onStoreFailure(e);
    }
  }

  /** A successful sign-in clears the account's counter, never the address's:
   *  one correct password must not reset a host that is working through a list. */
  async recordSuccess(email: string): Promise<void> {
    try {
      await this.redis().del(`login:fail:acct:${email.trim().toLowerCase()}`);
    } catch (e) {
      this.onStoreFailure(e);
    }
  }

  /**
   * The store being down must not silently disable the control, and must not
   * lock everybody out either — the route throttle still applies underneath.
   * Logged once, loudly, so it is visible rather than inferred.
   */
  private onStoreFailure(error: unknown): void {
    if (!this.warned) {
      this.warned = true;
      this.logger.error(
        `Sign-in backoff store unreachable (${error instanceof Error ? error.message : String(error)}). ` +
          `Per-account backoff is not being applied; the per-caller route throttle still is.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // lint-rules:allow — shutdown. The connection is being discarded either
    // way, and a failure to close one has no consequence to report.
    await this.client?.quit().catch(() => undefined);
  }
}
