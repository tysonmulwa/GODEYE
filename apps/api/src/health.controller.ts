import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { EngineService } from "./engine/engine.service";

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
  @ApiOperation({ summary: "Deployed build of the API and the engine" })
  async health() {
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? "";
    const api = { status: "ok", build: sha ? sha.slice(0, 8) : "unknown" };

    try {
      const engine = await this.engine.health();
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
