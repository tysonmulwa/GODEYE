/**
 * Redis is faked at the module boundary. The service builds its own client
 * rather than taking one, which is right for a control that must keep working
 * when the module wiring around it changes — and means the only seam is here.
 */
const redis = {
  mget: jest.fn(),
  pttl: jest.fn(),
  del: jest.fn(),
  pipeline: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
};
jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn(() => redis),
}));

import { HttpStatus } from "@nestjs/common";
import { backoffDelaySeconds, LoginBackoffService } from "./login-backoff.service";

/**
 * The shape of the curve, which is the part worth pinning.
 *
 * The route throttle caps attempts per caller. That is the wrong axis on its
 * own: credential stuffing spreads one guess per address across thousands of
 * addresses and never trips a per-caller limit. This counts against the account
 * as well.
 */
describe("backoffDelaySeconds", () => {
  it("does not punish someone who forgot their password", () => {
    for (let n = 0; n <= 5; n++) expect(backoffDelaySeconds(n)).toBe(0);
  });

  it("grows exponentially once the free attempts are spent", () => {
    expect(backoffDelaySeconds(6)).toBe(15);
    expect(backoffDelaySeconds(7)).toBe(30);
    expect(backoffDelaySeconds(8)).toBe(60);
    expect(backoffDelaySeconds(9)).toBe(120);
  });

  it("caps, because an unbounded lockout is a denial-of-service", () => {
    // Anybody can trigger this against a real person just by guessing at their
    // address, so it must always end.
    expect(backoffDelaySeconds(50)).toBe(15 * 60);
    expect(backoffDelaySeconds(1_000)).toBe(15 * 60);
  });

  it("is monotonic, so more failures never means a shorter wait", () => {
    let previous = -1;
    for (let n = 0; n < 40; n++) {
      const delay = backoffDelaySeconds(n);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});

describe("LoginBackoffService", () => {
  let service: LoginBackoffService;
  /** Every pipeline command queued, so the key set can be asserted. */
  let queued: [string, ...unknown[]][];

  beforeEach(() => {
    jest.clearAllMocks();
    queued = [];
    redis.pipeline.mockImplementation(() => {
      const chain = {
        incr: (key: string) => (queued.push(["incr", key]), chain),
        expire: (key: string, ttl: number) => (queued.push(["expire", key, ttl]), chain),
        exec: () => Promise.resolve([]),
      };
      return chain;
    });
    redis.mget.mockResolvedValue([null, null]);
    redis.pttl.mockResolvedValue(-1);
    redis.del.mockResolvedValue(1);
    service = new LoginBackoffService();
  });

  describe("assertNotBackedOff", () => {
    it("lets a first attempt through", async () => {
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).resolves.toBeUndefined();
    });

    it("lets the free attempts through", async () => {
      redis.mget.mockResolvedValue(["5", "0"]);
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).resolves.toBeUndefined();
    });

    it("refuses once the free attempts are spent", async () => {
      redis.mget.mockResolvedValue(["9", "0"]);
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it("tells the caller how long to wait", async () => {
      redis.mget.mockResolvedValue(["7", "0"]);
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).rejects.toMatchObject({
        response: { code: "TOO_MANY_ATTEMPTS", retryAfter: expect.any(Number) },
      });
    });

    /**
     * The address axis is the one that matters against credential stuffing:
     * one guess per account across thousands of accounts never trips a
     * per-account counter, and never trips a per-caller route throttle either.
     */
    it("refuses on the address counter even when the account is clean", async () => {
      redis.mget.mockResolvedValue([null, "12"]);
      await expect(service.assertNotBackedOff("fresh@example.com", "1.2.3.4")).rejects.toThrow();
    });

    it("counts against both the account and the address", async () => {
      await service.assertNotBackedOff("A@Example.com ", "1.2.3.4");
      expect(redis.mget).toHaveBeenCalledWith(
        "login:fail:acct:a@example.com",
        "login:fail:ip:1.2.3.4",
      );
    });

    /** A caller behind a proxy the API cannot read still gets a bucket. */
    it("uses a placeholder when the address is unknown", async () => {
      await service.assertNotBackedOff("a@example.com", undefined);
      expect(redis.mget).toHaveBeenCalledWith(
        "login:fail:acct:a@example.com",
        "login:fail:ip:unknown",
      );
    });

    /**
     * Time already served counts. Without this the wait restarts on every
     * attempt, which turns a 15-minute cap into an indefinite lockout — the
     * denial-of-service the cap exists to prevent.
     */
    it("lets the caller through once the delay has already elapsed", async () => {
      redis.mget.mockResolvedValue(["6", "0"]); // 15s delay
      // 15s of the 3600s window consumed => 15s already served.
      redis.pttl.mockResolvedValue((3600 - 15) * 1000);
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).resolves.toBeUndefined();
    });

    /**
     * Fail OPEN here, deliberately, and it is the one place in this codebase
     * that does. The route throttle still applies underneath, so the request is
     * not unlimited — whereas failing closed would turn a Redis blip into
     * "nobody can sign in", which is a worse outage than the control is worth.
     * Stated out loud because it contradicts the default rule.
     */
    it("does not lock everybody out when the store is unreachable", async () => {
      redis.mget.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).resolves.toBeUndefined();
    });

    /**
     * A counter with no expiry answers `pttl` -1, which says nothing about how
     * long ago the failure was. Reading that as "the whole window has elapsed"
     * switched the delay off entirely for that key — the state a partially
     * applied pipeline (incr done, expire not) leaves behind.
     */
    it("does not treat a missing TTL as time already served", async () => {
      redis.mget.mockResolvedValue(["9", "0"]);
      redis.pttl.mockResolvedValue(-1);
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).rejects.toThrow();
    });

    it("survives a pttl that fails after mget succeeded", async () => {
      redis.mget.mockResolvedValue(["9", "0"]);
      redis.pttl.mockRejectedValue(new Error("gone"));
      // Still refuses: the failure costs the elapsed-time credit, not the check.
      await expect(service.assertNotBackedOff("a@example.com", "1.2.3.4")).rejects.toThrow();
    });
  });

  describe("recordFailure", () => {
    it("increments both counters and gives each a window", async () => {
      await service.recordFailure("a@example.com", "1.2.3.4");
      expect(queued).toEqual([
        ["incr", "login:fail:acct:a@example.com"],
        ["expire", "login:fail:acct:a@example.com", 3600],
        ["incr", "login:fail:ip:1.2.3.4"],
        ["expire", "login:fail:ip:1.2.3.4", 3600],
      ]);
    });

    it("does not throw when the store is unreachable", async () => {
      redis.pipeline.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });
      await expect(service.recordFailure("a@example.com", "1.2.3.4")).resolves.toBeUndefined();
    });
  });

  describe("recordSuccess", () => {
    /**
     * The asymmetry is the point. One correct password clears the account, and
     * must NOT clear the address — otherwise a host working through a list
     * resets its own counter every time it happens to guess one right, which is
     * exactly the case the address counter exists for.
     */
    it("clears the account counter and not the address one", async () => {
      await service.recordSuccess("A@Example.com");
      expect(redis.del).toHaveBeenCalledTimes(1);
      expect(redis.del).toHaveBeenCalledWith("login:fail:acct:a@example.com");
    });

    it("does not throw when the store is unreachable", async () => {
      redis.del.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(service.recordSuccess("a@example.com")).resolves.toBeUndefined();
    });
  });

  it("closes its connection on shutdown", async () => {
    redis.quit.mockResolvedValue("OK");
    await service.recordSuccess("a@example.com"); // force the client to exist
    await service.onModuleDestroy();
    expect(redis.quit).toHaveBeenCalled();
  });
});
