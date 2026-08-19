import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { env } from "./env";

/**
 * Run a periodic job on exactly one replica. Finding D-5.
 *
 * `backfillMissing` was scheduled from `onModuleInit`, so every replica ran the
 * same unbounded anti-join over `organizations` every fifteen minutes. Correct,
 * and N times redundant — and its cost grew with total tenant count rather than
 * with the number of orphans, which is normally zero.
 *
 * `SET key value NX PX ttl` is the whole mechanism. It is not a distributed lock
 * in the Redlock sense and does not need to be: every job behind it is
 * idempotent, so the worst case of a lost lock is the work happening twice,
 * which is what happens today on every replica anyway.
 *
 * If Redis is unreachable the job is **skipped**, not run. A sweep that runs
 * everywhere when the coordinator is down is the failure mode this exists to
 * remove.
 */
export class LeaderLock {
  private static readonly logger = new Logger("LeaderLock");
  private static client?: Redis;

  private static redis(): Redis {
    if (!LeaderLock.client) {
      LeaderLock.client = new Redis(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times > 2 ? null : 200),
        enableOfflineQueue: false,
      });
      LeaderLock.client.on("error", () => {
        // Reported per command; an unhandled 'error' event kills the process.
      });
    }
    return LeaderLock.client;
  }

  /**
   * Run `job` if this instance wins the lock for `name`.
   *
   * `ttlMs` should comfortably exceed the job's normal runtime: the lock is
   * released by expiry as well as by the `finally`, so a process killed
   * mid-sweep does not hold it forever.
   */
  static async runExclusively(name: string, ttlMs: number, job: () => Promise<void>): Promise<boolean> {
    const key = `lock:${name}`;
    const token = randomUUID();
    let acquired: string | null;
    try {
      acquired = await LeaderLock.redis().set(key, token, "PX", ttlMs, "NX");
    } catch (e) {
      LeaderLock.logger.warn(
        `Skipping ${name}: cannot reach the lock store (${e instanceof Error ? e.message : String(e)})`,
      );
      return false;
    }
    if (acquired !== "OK") return false;

    try {
      await job();
      return true;
    } finally {
      // Compare-and-delete, so a job that overran its TTL cannot delete the
      // lock a different replica has since taken.
      await LeaderLock.redis()
        .eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
          1,
          key,
          token,
        )
        .catch((e: unknown) => {
          LeaderLock.logger.warn(
            `Could not release ${name}: ${e instanceof Error ? e.message : String(e)} ` +
              `(it will expire in ${ttlMs}ms)`,
          );
        });
    }
  }

  static async shutdown(): Promise<void> {
    const client = LeaderLock.client;
    LeaderLock.client = undefined;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      // Already gone. Nothing to report and nothing to do about it.
    }
  }
}
