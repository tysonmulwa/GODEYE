import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Load the repo-root .env regardless of where the process was started from
 * (turbo runs from apps/api, tests may run elsewhere). Walks up from both
 * cwd and __dirname until a .env is found.
 */
function loadRootEnv(): void {
  const starts = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, ".env");
      if (existsSync(candidate)) {
        config({ path: candidate });
        return;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

loadRootEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  apiPort: parseInt(process.env.API_PORT ?? "4000", 10),
  webUrl: process.env.WEB_URL ?? "http://localhost:3000",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  engineUrl: process.env.ENGINE_URL ?? "http://localhost:8000",
  databaseUrl: () => required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379/0",
  jwtAccessSecret: () => required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: () => required("JWT_REFRESH_SECRET"),
  tokenEncryptionKey: () => required("TOKEN_ENCRYPTION_KEY"),
  engineInternalSecret: process.env.ENGINE_INTERNAL_SECRET ?? "dev-engine-secret",
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID ?? "",
    clientSecret: process.env.REDDIT_CLIENT_SECRET ?? "",
    userAgent: process.env.REDDIT_USER_AGENT ?? "godeye/0.1",
    redirectUri:
      process.env.REDDIT_REDIRECT_URI ?? "http://localhost:4000/connections/reddit/callback",
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.LINKEDIN_REDIRECT_URI ?? "http://localhost:4000/connections/linkedin/callback",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    prices: {
      PRO: process.env.STRIPE_PRICE_PRO ?? "",
      SCALE: process.env.STRIPE_PRICE_SCALE ?? "",
    } as Record<string, string>,
  },
  meta: {
    appId: process.env.META_APP_ID ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    redirectUri:
      process.env.META_REDIRECT_URI ?? "http://localhost:4000/connections/meta/callback",
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "godeye-verify",
    graphVersion: "v21.0",
  },
};
