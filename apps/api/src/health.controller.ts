import { Controller, Get, Query } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { env } from "./common/env";
import { EngineService } from "./engine/engine.service";
import { Public } from "./common/public.decorator";

/**
 * Liveness, readiness, and "which build is running".
 *
 * `GET /health` used to call the engine synchronously with no timeout, so the
 * health check itself could hang for five minutes — the precise inverse of its
 * purpose (B-4). Worse, an orchestrator pointed at it would restart a perfectly
 * healthy API because a *different* service was slow.
 *
 * Split, per the Kubernetes/SRE distinction:
 *
 *   /health/live   the process is up. No dependencies, always fast. Point
 *                  restart policies here.
 *   /health/ready  dependencies answered inside a hard budget. Point load
 *                  balancers and deploy gates here.
 *   /health        the human-readable roll-up, unchanged in shape so nothing
 *                  that already reads it breaks.
 *
 * Unauthenticated on purpose: it reports two commit hashes and whether the
 * engine can reach its dependencies, and it is most wanted exactly when signing
 * in is not working. It reveals no key and no plan code — booleans only.
 */
/**
 * Never throttled.
 *
 * The rate-limit store is Redis, and in production it fails CLOSED: unreachable
 * counters mean the request is refused. Applied to a probe that is a cascade.
 * Redis went down, so every request 503'd -- including /health/ready, which is
 * Railway's healthcheck path. The deploy could then never become healthy, so it
 * retried for two days while reporting "building", and /health could not say
 * why because it was refused too.
 *
 * A probe is infrastructure, not traffic. It is unauthenticated, constant-rate,
 * and the one thing that must keep answering while everything else is broken.
 * Throttling it protects nothing and costs the ability to diagnose an incident
 * during the incident.
 */
@SkipThrottle()
@ApiTags("health")
@Controller("health")
export class HealthController {
  /** Readiness is cached briefly so a load balancer polling every second does
   *  not turn into a load test of the engine. */
  private static readonly READY_CACHE_MS = 5_000;
  private readyCache: { at: number; body: unknown; ok: boolean } | null = null;

  constructor(private readonly engine: EngineService) {}

  /**
   * Is this process alive?
   *
   * Deliberately answers without touching anything: a liveness probe that can
   * fail because a dependency is slow causes restarts that make an incident
   * worse. Restart policies belong here.
   */
  @Get("live")
  @Public()
  @ApiOperation({ summary: "Process liveness. No dependencies, always fast." })
  live() {
    return { status: "ok", uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Should this instance receive traffic?
   *
   * Checks the engine with a 3s budget. A slow dependency makes this instance
   * "not ready", which removes it from rotation — it does not kill it.
   */
  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Dependency readiness, with a hard 3s budget." })
  async ready() {
    const now = Date.now();
    if (this.readyCache && now - this.readyCache.at < HealthController.READY_CACHE_MS) {
      return this.readyCache.body;
    }
    let body: { status: string; checks: Record<string, string> };
    try {
      const engine = await this.engine.health();
      const ok = engine.status === "ok";
      body = { status: ok ? "ok" : "degraded", checks: { engine: engine.status } };
    } catch (e) {
      body = {
        status: "degraded",
        checks: { engine: e instanceof Error ? e.message : String(e) },
      };
    }
    this.readyCache = { at: now, body, ok: body.status === "ok" };
    return body;
  }

  @Get()
  @Public()
  @ApiOperation({ summary: "Deployed build of the API and the engine" })
  async health(@Query("render") render?: string) {
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? "";
    const api = {
      status: "ok",
      build: sha ? sha.slice(0, 8) : "unknown",
      // Whether this deploy can take money, without asking anyone to sign in.
      // "Upgrade does nothing" and "the key is not set on this service" look
      // identical from the browser, and the answer is one env var either way.
      // Booleans only, never the keys, and never the plan codes.
      payments: {
        provider: "paystack",
        secretKey: !!env.paystack.secretKey,
        // Test or live, from the key's prefix, never the key. Plan codes are
        // scoped to a mode, so a plan built on one side of that switch is
        // invisible to a key from the other, and this is the fastest way to
        // see it.
        mode: env.paystack.mode,
        plans: {
          PRO: !!env.paystack.plans.PRO,
          PREMIUM: !!env.paystack.plans.PREMIUM,
          VIP: !!env.paystack.plans.VIP,
        },
      },
    };

    try {
      // ?render=1 queues a throwaway encode on a worker and reads the result
      // on a later call, the encode outlives the request, so it cannot be
      // answered inline. ?render=refresh discards a cached result first.
      // Opt-in: it costs real CPU, and it is the only way to tell a container
      // that has ffmpeg from one that can finish a render.
      const engine = await this.engine.health(render ?? "");
      return { status: engine.status === "ok" ? "ok" : "degraded", api, engine };
    } catch (e) {
      // The API being up while the engine is not is a normal state worth
      // reporting, not a 500.
      return {
        status: "degraded",
        api,
        engine: { status: "unreachable", error: e instanceof Error ? e.message : String(e) },
      };
    }
  }
}
