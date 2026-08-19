import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import Redis from "ioredis";
import { env } from "./env";

/**
 * Rate-limit counters, shared across replicas.
 *
 * The default storage is a Map in the process. On a horizontally-scaled service
 * that is not rate limiting: N replicas means N times the limit, and a rolling
 * deploy resets every counter. Combined with S-4 — `trust proxy` never enabled,
 * so every bucket was keyed on the proxy's address — the throttling in this API
 * was decorative in both directions at once.
 *
 * Counters live in Redis with the same TTL the throttler asked for. A `cost`
 * greater than 1 lets an endpoint that burns 40 seconds of GPU consume more of
 * a bucket than `GET /auth/me` does (OWASP API4).
 */

/**
 * INCRBY the counter, set the window on first hit, and report what is left.
 *
 * One round trip and atomic. The read-then-write shape this replaces is a race:
 * two requests arriving together both read "9 of 10" and both proceed.
 */
const INCREMENT = `
local hits = redis.call('INCRBY', KEYS[1], tonumber(ARGV[3]))
if hits <= tonumber(ARGV[3]) then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local blocked = 0
if hits > tonumber(ARGV[2]) then
  blocked = 1
  local blockMs = tonumber(ARGV[4])
  local ttl = redis.call('PTTL', KEYS[1])
  if blockMs > ttl then redis.call('PEXPIRE', KEYS[1], blockMs) end
end
return { hits, redis.call('PTTL', KEYS[1]), blocked }
`;

export interface CountingStorage extends ThrottlerStorage {
  /** `increment`, with a weight. See the `@Cost()` decorator. */
  incrementBy(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
    cost: number,
  ): Promise<ThrottlerStorageRecord>;
}

/** The in-process fallback, used only outside production. */
class MemoryCounters {
  private readonly map = new Map<string, { hits: number; expiresAt: number }>();

  bump(key: string, ttlMs: number, cost: number): { hits: number; ttlMs: number } {
    const now = Date.now();
    const current = this.map.get(key);
    if (!current || current.expiresAt <= now) {
      const fresh = { hits: cost, expiresAt: now + ttlMs };
      this.map.set(key, fresh);
      return { hits: fresh.hits, ttlMs };
    }
    current.hits += cost;
    return { hits: current.hits, ttlMs: current.expiresAt - now };
  }
}

@Injectable()
export class RedisThrottlerStorage implements CountingStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private client?: Redis;
  private readonly memory = new MemoryCounters();
  private warnedAboutFallback = false;

  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis(env.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        // A rate limiter must answer fast or it becomes the outage it exists to
        // prevent. Two short attempts, then the decision below.
        retryStrategy: (times) => (times > 2 ? null : 100),
        enableOfflineQueue: false,
      });
      this.client.on("error", () => {
        // Reported per command; an unhandled 'error' event kills the process.
      });
    }
    return this.client;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    return this.incrementBy(key, ttl, limit, blockDuration, throttlerName, 1);
  }

  async incrementBy(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
    cost: number,
  ): Promise<ThrottlerStorageRecord> {
    const namespaced = `throttle:${key}`;
    try {
      const [hits, pttl, blocked] = (await this.redis().eval(
        INCREMENT,
        1,
        namespaced,
        String(ttl),
        String(limit),
        String(Math.max(1, cost)),
        String(blockDuration),
      )) as [number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(Math.max(0, pttl) / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(Math.max(0, pttl) / 1000),
      };
    } catch (e) {
      return this.onStorageFailure(e, namespaced, ttl, limit, cost);
    }
  }

  /**
   * What to do when the counter store is unreachable.
   *
   * Production fails closed: a rate limiter that opens under load is missing
   * exactly when it is needed, and "Redis is struggling" is the same moment an
   * attacker is hammering the login route. §1.8 — a check that cannot reach its
   * dependency denies.
   *
   * Outside production it degrades to per-process counting and says so, loudly
   * and once. A developer without Redis running should get a working API, not a
   * wall of 503s that teaches them to disable the limiter.
   */
  private onStorageFailure(
    error: unknown,
    key: string,
    ttl: number,
    limit: number,
    cost: number,
  ): ThrottlerStorageRecord {
    const reason = error instanceof Error ? error.message : String(error);
    if (env.nodeEnv === "production") {
      this.logger.error(`Rate-limit store unreachable, refusing the request: ${reason}`);
      throw new ServiceUnavailableException(
        "Service temporarily unavailable. Please retry in a moment.",
      );
    }
    if (!this.warnedAboutFallback) {
      this.warnedAboutFallback = true;
      this.logger.warn(
        `Rate-limit store unreachable (${reason}). Falling back to per-process counters. ` +
          `This is a development-only behaviour; in production the request would be refused.`,
      );
    }
    const { hits, ttlMs } = this.memory.bump(key, ttl, Math.max(1, cost));
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(ttlMs / 1000),
      isBlocked: hits > limit,
      timeToBlockExpire: Math.ceil(ttlMs / 1000),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
