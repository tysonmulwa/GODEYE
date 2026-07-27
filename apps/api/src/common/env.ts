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

/**
 * A URL from the environment, with surrounding whitespace and any trailing
 * slash removed. Pasting into a hosting dashboard easily leaves a trailing
 * space, and for OAuth that is not cosmetic: the authorize URL builds its query
 * with URLSearchParams (space -> "+") while the token exchange used
 * encodeURIComponent (space -> "%20"), so the provider sees two different
 * redirect_uri values and rejects the code.
 */
function url(value: string | undefined, fallback: string): string {
  return (value ?? fallback).trim().replace(/\/+$/, "");
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Container hosts (Railway, Render, Fly) inject PORT and route to it; API_PORT
  // is the local-dev override. Ignoring PORT makes the platform mark the deploy
  // unhealthy because nothing is listening where it forwards traffic.
  apiPort: parseInt(process.env.PORT ?? process.env.API_PORT ?? "4000", 10),
  webUrl: url(process.env.WEB_URL, "http://localhost:3000"),
  apiUrl: url(process.env.API_URL, "http://localhost:4000"),
  engineUrl: url(process.env.ENGINE_URL, "http://localhost:8000"),
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
    redirectUri: url(
      process.env.REDDIT_REDIRECT_URI,
      "http://localhost:4000/connections/reddit/callback",
    ),
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
    redirectUri: url(
      process.env.LINKEDIN_REDIRECT_URI,
      "http://localhost:4000/connections/linkedin/callback",
    ),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    prices: {
      PRO: process.env.STRIPE_PRICE_PRO ?? "",
      SCALE: process.env.STRIPE_PRICE_SCALE ?? "",
    } as Record<string, string>,
  },
  /**
   * Instagram API with Instagram Login — a separate Meta app product that
   * publishes to an Instagram Business/Creator account with NO linked Facebook
   * Page, which the Facebook-Login path requires. Kept apart from `meta`
   * because it has its own app credentials, OAuth host and API host.
   */
  instagram: {
    appId: (process.env.INSTAGRAM_APP_ID ?? "").trim(),
    appSecret: (process.env.INSTAGRAM_APP_SECRET ?? "").trim(),
    redirectUri: url(
      process.env.INSTAGRAM_REDIRECT_URI,
      "http://localhost:4000/connections/instagram/callback",
    ),
  },
  meta: {
    appId: (process.env.META_APP_ID ?? "").trim(),
    appSecret: (process.env.META_APP_SECRET ?? "").trim(),
    redirectUri: url(
      process.env.META_REDIRECT_URI,
      "http://localhost:4000/connections/meta/callback",
    ),
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "godeye-verify",
    graphVersion: "v21.0",
  },
};
