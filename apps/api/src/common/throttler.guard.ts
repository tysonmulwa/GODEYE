import { ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerStorage } from "@nestjs/throttler";
import { THROTTLER_OPTIONS } from "@nestjs/throttler/dist/throttler.constants";
import type { ThrottlerModuleOptions } from "@nestjs/throttler";
import type { ThrottlerRequest } from "@nestjs/throttler/dist/throttler.guard.interface";
import { Inject } from "@nestjs/common";
import type { AuthenticatedRequest } from "./jwt-auth.guard";
import type { CountingStorage } from "./throttler-storage";

export const COST_KEY = "throttleCost";

/**
 * How much of a bucket this route consumes.
 *
 * A request that costs 40 seconds of GPU is not equivalent to `GET /auth/me`
 * and must not share its allowance (OWASP API4 — unrestricted resource
 * consumption). Weighting the *same* bucket is better than a second limit,
 * because it means one workspace cannot dodge the cap by spreading spend across
 * several expensive endpoints.
 */
export const Cost = (units: number) => SetMetadata(COST_KEY, units);

/**
 * Rate limiting that knows who is calling. Finding S-4.
 *
 * The stock guard keys on `req.ips[0] ?? req.ip`. With `trust proxy` off — which
 * it was, everywhere — `req.ips` is empty and `req.ip` is Railway's edge, so
 * every bucket in the system was one bucket for the whole internet: 100 req/min
 * for the entire API, and the 11th login attempt by *anybody* failed. That is a
 * self-DoS and a failed brute-force control at the same time, since an attacker
 * could lock out every legitimate user and could not be isolated from them.
 *
 * `trust proxy` is now set to an exact hop count in main.ts. This guard adds the
 * other half: buckets keyed by identity where there is one, and by client
 * address where there is not.
 */
@Injectable()
export class GodeyeThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(THROTTLER_OPTIONS) options: ThrottlerModuleOptions,
    @Inject(ThrottlerStorage) storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
    // RFC 9331's draft shape (RateLimit-Limit / -Remaining / -Reset) rather than
    // the older X- prefixed names, so a client can read the budget it has left
    // from a standard header rather than a vendor one.
    this.headerPrefix = "RateLimit";
  }

  /**
   * Who this request counts against.
   *
   * Identity first: a shared office NAT is one IP and dozens of people, and an
   * attacker on a residential connection changes IP for free. Falling back to
   * the address only for callers with no session is what keeps the login and
   * register routes protected at all.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    if (auth?.sub) return `u:${auth.sub}:${auth.orgId}`;
    const ips = req.ips as string[] | undefined;
    const ip = (Array.isArray(ips) && ips.length ? ips[0] : (req.ip as string)) ?? "unknown";
    return `ip:${ip}`;
  }

  /**
   * One bucket per (tracker, throttler, route).
   *
   * Per-route rather than global so exhausting the SEO audit allowance does not
   * also lock the caller out of reading their own content — which is what a
   * single shared bucket did to everyone at once.
   */
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    // `burst` and `spend` are per caller across the whole API, so they must not
    // carry the route in the key; `default` is per route, so exhausting the SEO
    // audit allowance does not also lock the caller out of reading content.
    if (name === "burst" || name === "spend") return `${name}:${suffix}`;
    return `${name}:${context.getClass().name}.${context.getHandler().name}:${suffix}`;
  }

  /**
   * The stock implementation with two changes: a per-route cost, and
   * `Retry-After` in seconds on the rejection.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration, getTracker, generateKey } = requestProps;
    const { req, res } = this.getRequestResponse(context);

    const declaredCost = this.reflector.getAllAndOverride<number | undefined>(COST_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // The spend budget only counts routes that declare what they cost. A route
    // with no @Cost() is a read, and reads are covered by `default` and `burst`.
    if ((throttler.name ?? "default") === "spend" && declaredCost === undefined) return true;
    const cost = declaredCost ?? 1;

    const tracker = await getTracker(req, context);
    const key = generateKey(context, tracker, throttler.name ?? "default");

    const storage = this.storageService as Partial<CountingStorage>;
    const record = storage.incrementBy
      ? await storage.incrementBy(key, ttl, limit, blockDuration, throttler.name ?? "default", cost)
      : await this.storageService.increment(
          key,
          ttl,
          limit,
          blockDuration,
          throttler.name ?? "default",
        );

    const suffix = (throttler.name ?? "default") === "default" ? "" : `-${throttler.name}`;
    res.header(`${this.headerPrefix}-Limit${suffix}`, String(limit));
    res.header(`${this.headerPrefix}-Remaining${suffix}`, String(Math.max(0, limit - record.totalHits)));
    res.header(`${this.headerPrefix}-Reset${suffix}`, String(record.timeToExpire));

    if (record.isBlocked) {
      // Seconds, and always present on a 429. Without it a client's only
      // strategy is to retry immediately, which is how a rate limit becomes a
      // retry storm.
      res.header("Retry-After", String(Math.max(1, record.timeToBlockExpire)));
      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits: record.totalHits,
        timeToExpire: record.timeToExpire,
        isBlocked: record.isBlocked,
        timeToBlockExpire: record.timeToBlockExpire,
      });
    }
    return true;
  }
}
