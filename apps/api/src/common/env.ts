import { config } from "dotenv";
import { requiredHexKey, requiredSecret } from "./secrets";
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

/**
 * Where a platform sends someone back after they authorize.
 *
 * Every one of these used to fall back to http://localhost:4000, so a
 * deployment that forgot one variable sent live customers to a callback on
 * their own laptop. Deriving from API_URL means production is right by
 * default and the variable exists only to override it, which some platforms
 * need, since the URL must match what is registered with them exactly.
 */
function callbackUrl(platform: string, override: string | undefined): string {
  // A variable present but blank is treated as absent. Hosting dashboards keep
  // a key with an empty value once it has been added and cleared, and "" would
  // otherwise win over the derived URL and send the redirect nowhere at all.
  const explicit = override?.trim() ? override : undefined;
  return url(
    explicit,
    `${url(process.env.API_URL, "http://localhost:4000")}/connections/${platform}/callback`,
  );
}

/**
 * Registrable domain, used to decide whether two URLs are "same site".
 * Compares the last two labels, which is right for domains like
 * godeyeautomation.com but not for multi-part TLDs (foo.co.uk), those would be
 * treated as cross-site, which is the safe direction to be wrong in.
 */
function site(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.split(".").slice(-2).join(".");
  } catch {
    return rawUrl;
  }
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
  jwtAccessSecret: () => requiredSecret("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: () => requiredSecret("JWT_REFRESH_SECRET"),
  /**
   * Signs the OAuth `state` parameter, and nothing else.
   *
   * Separate key material because `state` travels through Meta, TikTok,
   * LinkedIn and Reddit by design, and lands in their logs, in browser history
   * and in Referer headers. Signed with the session key it *was* a session
   * credential (C-1). Split, a leaked state proves only that somebody started
   * an OAuth flow. NIST SP 800-57 calls this key-purpose separation; RFC 8725
   * §3.8 says the same thing for JWTs specifically.
   */
  oauthStateSecret: () => requiredSecret("OAUTH_STATE_SECRET"),
  tokenEncryptionKey: () => requiredHexKey("TOKEN_ENCRYPTION_KEY").toString("hex"),
  /**
   * Identifies tokens this API minted, so a token from any other issuer is
   * refused before its claims are read (RFC 8725 §3.8).
   */
  get jwtIssuer(): string {
    return this.apiUrl;
  },
  jwtAudience: "godeye-api",
  get engineInternalSecret(): string {
    return requiredSecret("ENGINE_INTERNAL_SECRET");
  },
  /**
   * True when the browser would treat an API call from the web app as
   * cross-site, which forces the session cookie to SameSite=None, and means
   * browsers blocking third-party cookies will drop it. Serving both from one
   * registrable domain (app + api on godeyeautomation.com) makes this false and
   * allows the stricter, CSRF-protective Lax.
   */
  get isCrossSite(): boolean {
    return site(this.webUrl) !== site(this.apiUrl);
  },
  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID ?? "",
    clientSecret: process.env.REDDIT_CLIENT_SECRET ?? "",
    userAgent: process.env.REDDIT_USER_AGENT ?? "godeye/0.1",
    redirectUri: callbackUrl("reddit", process.env.REDDIT_REDIRECT_URI),
  },
  /**
   * X's consumer keys identify this application, exactly as Meta's and
   * TikTok's do. They were being collected from every customer, which meant
   * each one needed their own X developer account and approved app, and the
   * product then ran under their rate limits rather than ours. Only the access
   * token and secret, which identify one account, come from the customer.
   */
  x: {
    apiKey: process.env.X_API_KEY ?? "",
    apiSecret: process.env.X_API_SECRET ?? "",
    // Must be listed verbatim under the X app's "Callback URI / Redirect URL".
    // X compares it as a string, so a trailing slash is a different URL.
    redirectUri: callbackUrl("x", process.env.X_REDIRECT_URI),
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
    redirectUri: callbackUrl("linkedin", process.env.LINKEDIN_REDIRECT_URI),
  },
  /**
   * Paystack, the only payment provider. It is the one that carries Apple Pay
   * for this merchant, and running a second processor alongside it would let a
   * workspace hold two live subscriptions for the same plan.
   *
   * `plans` are Paystack plan codes (PLN_...), which is what makes a charge
   * recurring. Without them a subscription would be a single payment that
   * silently never renews, so checkout refuses rather than take money on a
   * promise it cannot keep.
   *
   * The public key is here only so the API can hand it to the browser. The
   * secret key must never reach the client: it also signs webhooks, so anyone
   * holding it can both move money and forge payment confirmations.
   */
  paystack: {
    // Trimmed: a key pasted into a hosting dashboard often carries a trailing
    // space, and it is used both as a bearer token and as an HMAC key, the
    // second would fail every webhook signature with no hint as to why.
    secretKey: (process.env.PAYSTACK_SECRET_KEY ?? "").trim(),
    publicKey: (process.env.PAYSTACK_PUBLIC_KEY ?? "").trim(),
    plans: {
      PRO: (process.env.PAYSTACK_PLAN_PRO ?? "").trim(),
      PREMIUM: (process.env.PAYSTACK_PLAN_PREMIUM ?? "").trim(),
      VIP: (process.env.PAYSTACK_PLAN_VIP ?? "").trim(),
    } as Record<string, string>,
    /**
     * Which ways to pay the billing page offers.
     *
     * An allow-list, so a merchant who has not had Apple Pay or KES approved
     * can drop one without a deploy. It only ever narrows, since Paystack still
     * refuses a channel the account has not enabled.
     */
    methods: (process.env.PAYSTACK_METHODS ?? "card,apple_pay,mpesa")
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean),
    /**
     * Which Paystack mode these keys belong to, read from the key's own prefix.
     *
     * Worth knowing because plan codes are scoped to a mode: a PLN_ created in
     * test mode does not exist for a live key, and Paystack's answer is the
     * indistinguishable "plan not found". Half a day can go into checking a
     * code character by character when the code was never the problem.
     */
    get mode(): "live" | "test" | "unknown" {
      if (this.secretKey.startsWith("sk_live_")) return "live";
      if (this.secretKey.startsWith("sk_test_")) return "test";
      return "unknown";
    },
  },
  /**
   * TikTok Content Posting API. Note it calls the app identifier `client_key`,
   * not `client_id`, and the authorize host differs from the API host.
   */
  tiktok: {
    clientKey: (process.env.TIKTOK_CLIENT_KEY ?? "").trim(),
    clientSecret: (process.env.TIKTOK_CLIENT_SECRET ?? "").trim(),
    redirectUri: callbackUrl("tiktok", process.env.TIKTOK_REDIRECT_URI),
  },
  /**
   * Instagram API with Instagram Login, a separate Meta app product that
   * publishes to an Instagram Business/Creator account with NO linked Facebook
   * Page, which the Facebook-Login path requires. Kept apart from `meta`
   * because it has its own app credentials, OAuth host and API host.
   */
  instagram: {
    appId: (process.env.INSTAGRAM_APP_ID ?? "").trim(),
    appSecret: (process.env.INSTAGRAM_APP_SECRET ?? "").trim(),
    redirectUri: callbackUrl("instagram", process.env.INSTAGRAM_REDIRECT_URI),
  },
  meta: {
    appId: (process.env.META_APP_ID ?? "").trim(),
    appSecret: (process.env.META_APP_SECRET ?? "").trim(),
    redirectUri: callbackUrl("meta", process.env.META_REDIRECT_URI),
    get webhookVerifyToken(): string {
      return requiredSecret("META_WEBHOOK_VERIFY_TOKEN", { minLength: 16 });
    },
    graphVersion: "v21.0",
  },
};

/**
 * Boot-time configuration gate.
 *
 * Every secret above throws when it is missing, published, or entropy-free, but
 * a lazy getter only throws on the first request that happens to need it — so a
 * misconfigured deploy passes its health check and fails hours later on one
 * endpoint. This reads them all once, at startup, and refuses to boot.
 *
 * It also asserts key *separation*: reusing JWT_ACCESS_SECRET as
 * OAUTH_STATE_SECRET reintroduces C-1 exactly, and nothing else in the system
 * would notice.
 */
export function validateConfig(): void {
  const problems: string[] = [];
  const read = (label: string, fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      problems.push(`  - ${e instanceof Error ? e.message : `${label}: ${String(e)}`}`);
    }
  };

  read("DATABASE_URL", () => env.databaseUrl());
  read("JWT_ACCESS_SECRET", () => env.jwtAccessSecret());
  read("JWT_REFRESH_SECRET", () => env.jwtRefreshSecret());
  read("OAUTH_STATE_SECRET", () => env.oauthStateSecret());
  read("TOKEN_ENCRYPTION_KEY", () => env.tokenEncryptionKey());
  read("ENGINE_INTERNAL_SECRET", () => env.engineInternalSecret);

  try {
    const access = env.jwtAccessSecret();
    const refresh = env.jwtRefreshSecret();
    const state = env.oauthStateSecret();
    if (state === access) {
      problems.push("  - OAUTH_STATE_SECRET must not equal JWT_ACCESS_SECRET (finding C-1)");
    }
    if (state === refresh) {
      problems.push("  - OAUTH_STATE_SECRET must not equal JWT_REFRESH_SECRET");
    }
    if (access === refresh) {
      problems.push("  - JWT_ACCESS_SECRET must not equal JWT_REFRESH_SECRET");
    }
  } catch {
    // Already reported above; the separation check needs all three present.
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start: ${problems.length} configuration problem(s)\n${problems.join("\n")}\n` +
        `\nSee docs/CONFIGURATION.md. For a local box only, set NODE_ENV=development and ` +
        `ALLOW_INSECURE_DEV_DEFAULTS=true.`,
    );
  }
}
