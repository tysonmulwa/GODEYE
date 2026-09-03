/**
 * What the rate limiter does when its store is gone.
 *
 * This is written from a real outage. Redis stopped answering
 * (`ECONNREFUSED redis.railway.internal:6379`) and the API returned 503 to
 * every request, because the throttler guard is global and the storage refused
 * in production.
 *
 * The part that turned an incident into a two-day one: `/health/ready` is
 * Railway's healthcheck path, so it 503'd too. The deploy could never become
 * healthy, retried for two days reporting "building", and `/health` could not
 * say why — it was refused as well. The diagnostics disappeared exactly when
 * they were needed.
 *
 * So the behaviour changed deliberately, and these tests are the record of
 * which way and why.
 */
import { RedisThrottlerStorage } from "./throttler-storage";

const ORIGINAL_ENV = { ...process.env };

/** A storage whose Redis always refuses, without opening a socket. */
function brokenStorage(): RedisThrottlerStorage {
  const storage = new RedisThrottlerStorage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (storage as any).redis = () => ({
    eval: () => Promise.reject(new Error("ECONNREFUSED redis.railway.internal:6379")),
  });
  return storage;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("when Redis cannot answer", () => {
  /**
   * The regression, stated plainly. Production used to throw
   * ServiceUnavailableException here, which the global guard turned into a 503
   * on every route in the API.
   */
  it("does not refuse the request in production", async () => {
    process.env.NODE_ENV = "production";
    const storage = brokenStorage();
    await expect(storage.increment("ip:1.2.3.4", 60_000, 10, 0, "default")).resolves.toBeDefined();
  });

  it("keeps counting, per process, rather than not counting at all", async () => {
    process.env.NODE_ENV = "production";
    const storage = brokenStorage();

    const first = await storage.increment("ip:5.5.5.5", 60_000, 3, 0, "default");
    const second = await storage.increment("ip:5.5.5.5", 60_000, 3, 0, "default");

    // Degrading is not disabling. The counter still moves, so a burst is still
    // limited within one replica.
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });

  it("still blocks once the per-process limit is passed", async () => {
    process.env.NODE_ENV = "production";
    const storage = brokenStorage();
    const key = "ip:9.9.9.9";

    for (let i = 0; i < 3; i++) await storage.increment(key, 60_000, 3, 0, "default");
    const overLimit = await storage.increment(key, 60_000, 3, 0, "default");

    expect(overLimit.totalHits).toBe(4);
    expect(overLimit.isBlocked).toBe(true);
  });

  it("behaves the same outside production, so the two cannot drift", async () => {
    process.env.NODE_ENV = "development";
    const storage = brokenStorage();
    const result = await storage.increment("ip:1.1.1.1", 60_000, 10, 0, "default");
    expect(result.totalHits).toBe(1);
  });

  /**
   * `cost` is how an endpoint that burns 40 seconds of GPU consumes more of a
   * bucket than `GET /auth/me`. It has to survive the fallback, or the
   * expensive routes become the cheap ones during an outage.
   */
  it("honours a weighted cost in the fallback", async () => {
    process.env.NODE_ENV = "production";
    const storage = brokenStorage();
    const result = await storage.incrementBy("ip:2.2.2.2", 60_000, 10, 0, "default", 5);
    expect(result.totalHits).toBe(5);
  });
});

describe("the health probes are never throttled", () => {
  /**
   * Asserted against the source rather than by booting Nest: standing an
   * application up here would need a database, Redis and the engine, which is
   * three dependencies to test that one decorator is present.
   *
   * The decorator is what breaks the cascade. Even with the storage degrading
   * rather than refusing, a probe should not be spending a rate-limit bucket:
   * it is unauthenticated, constant-rate infrastructure, and it is the one
   * endpoint that must answer while everything else is broken.
   */
  it("marks the health controller @SkipThrottle", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "health.controller.ts"),
      "utf8",
    ) as string;

    expect(source).toContain("@SkipThrottle()");
    // Immediately above the controller, not on one handler: /live, /ready and
    // /health all need it, and /ready is the one the deploy gate reads.
    const skipAt = source.indexOf("@SkipThrottle()");
    const controllerAt = source.indexOf('@Controller("health")');
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(controllerAt);
  });
});
