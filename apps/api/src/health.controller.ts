import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { env } from "./common/env";
import { EngineService } from "./engine/engine.service";
import { Public } from "./common/public.decorator";

/**
 * Which build is actually running, for the API and the engine behind it.
 *
 * Answering that has meant inferring it from the data each service produced:
 * whether generated images were JPEG, whether a TikTok post id began with p_.
 * That is slow, indirect, and was wrong at least once. Railway stamps the
 * commit on every deploy, so both services can simply say.
 *
 * Unauthenticated on purpose: it reports two commit hashes and whether the
 * engine can reach its own dependencies, and it is most wanted exactly when
 * signing in is not working.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly engine: EngineService) {}

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
