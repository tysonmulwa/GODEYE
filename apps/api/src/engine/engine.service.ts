import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { env } from "../common/env";

/**
 * Typed HTTP client for the Python automation engine (FastAPI).
 * All calls carry the shared internal secret; the engine rejects anything else.
 */
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  async enqueueGenerateContent(payload: {
    agentRunId: string;
    orgId: string;
    goal: string;
    platforms: string[];
    tone?: string;
    topic?: string;
    callToAction?: string;
    abTest?: boolean;
  }): Promise<{ taskId: string }> {
    return this.post("/tasks/generate-content", payload);
  }

  async enqueueGenerateImage(payload: {
    agentRunId: string;
    orgId: string;
    brief: string;
    preset: string;
    style?: string;
    contentItemId?: string;
    applyBrand?: boolean;
  }): Promise<{ taskId: string }> {
    return this.post("/tasks/generate-image", payload);
  }

  async enqueueGenerateVideo(payload: {
    agentRunId: string;
    orgId: string;
    brief: string;
    preset: string;
    durationSec: number;
    voice: string;
    style?: string;
    includeCaptions: boolean;
    contentItemId?: string;
  }): Promise<{ taskId: string }> {
    return this.post("/tasks/generate-video", payload);
  }

  async enqueueSeoAudit(payload: {
    agentRunId: string;
    orgId: string;
    auditId: string;
    url: string;
    maxPages: number;
  }): Promise<{ taskId: string }> {
    return this.post("/tasks/run-seo-audit", payload);
  }

  /** Re-crawl the pages an audit's applied fixes touched and record the verdict. */
  async enqueueVerifySeoFixes(payload: {
    orgId: string;
    auditId: string;
  }): Promise<{ taskId: string }> {
    return this.post("/tasks/verify-seo-fixes", payload);
  }

  /** Push changed URLs to IndexNow (Bing, Yandex, Seznam, Naver). */
  async submitIndexNow(payload: {
    orgId: string;
    siteUrl: string;
    urls: string[];
  }): Promise<{ submitted: number; status: string; reason?: string; key?: string }> {
    return this.post("/seo/indexnow", payload);
  }

  /** Whether the site serves its IndexNow key file yet. */
  async indexNowStatus(
    orgId: string,
    siteUrl: string,
  ): Promise<{ key: string; keyFileUrl: string; published: boolean }> {
    const query = new URLSearchParams({ orgId, siteUrl }).toString();
    return this.get(`/seo/indexnow/status?${query}`);
  }

  /** Store a brand logo in object storage via the engine (which owns S3 creds). */
  async storeLogo(payload: {
    orgId: string;
    filename: string;
    dataBase64: string;
    contentType: string;
  }): Promise<{ storageKey: string; url: string }> {
    return this.post("/storage/logo", payload);
  }

  /** Store a workspace's background track for mixing under generated video. */
  async storeBrandMusic(payload: {
    orgId: string;
    filename: string;
    dataBase64: string;
    contentType: string;
  }): Promise<{ storageKey: string; url: string }> {
    return this.post("/storage/brand-music", payload);
  }

  async storeMedia(payload: {
    orgId: string;
    dataBase64: string;
    contentType: string;
  }): Promise<{ storageKey: string; url: string; sizeBytes: number }> {
    return this.post("/storage/upload", payload);
  }

  /** OAuth1 signing lives in the engine — it validates X credentials for us. */
  async validateX(credentials: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
  }): Promise<{ id: string; username: string; name: string }> {
    return this.post("/validate/x", credentials);
  }

  async bestTimes(
    orgId: string,
    platform: string,
    timezone: string,
  ): Promise<{ platform: string; timezone: string; times: string[]; dataDriven: boolean }> {
    const params = new URLSearchParams({ orgId, platform, timezone });
    return this.get(`/intel/best-times?${params}`);
  }

  async health(): Promise<{ status: string }> {
    return this.get("/health");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { headers: this.headers() });
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      "X-Internal-Secret": env.engineInternalSecret,
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${env.engineUrl}${path}`, init);
    } catch (e) {
      // Log the underlying cause — "unreachable" alone can't distinguish a
      // wrong ENGINE_URL from an engine that just died mid-request.
      const cause = e instanceof Error ? e.message : String(e);
      this.logger.error(`Engine unreachable at ${env.engineUrl}${path}: ${cause}`);
      throw new ServiceUnavailableException(
        env.nodeEnv === "production"
          ? "The automation engine is unreachable. It may be restarting — try again in a moment."
          : "The automation engine is not running. Start it with: cd apps/engine && python -m godeye_engine.run",
      );
    }
    if (!res.ok) {
      const body = await res.text();
      // 4xx from the engine carries a user-actionable message (e.g. bad credentials)
      if (res.status >= 400 && res.status < 500) {
        let detail = body;
        try {
          detail = JSON.parse(body)?.detail ?? body;
        } catch {
          /* keep raw body */
        }
        throw new BadRequestException(detail);
      }
      this.logger.error(`Engine error ${res.status}: ${body}`);
      throw new ServiceUnavailableException(`Automation engine error (${res.status})`);
    }
    return (await res.json()) as T;
  }
}
