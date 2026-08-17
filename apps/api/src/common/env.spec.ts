/**
 * Where OAuth sends people back.
 *
 * Every platform's redirect used to fall back to http://localhost:4000, which
 * is silent in the worst way: the app boots, the connect button works, the
 * consent screen appears, and only after the customer presses Approve does the
 * browser try to reach a server on their own machine. Nothing in the API logs
 * anything, because the request never arrives.
 */
// env.ts loads the repo-root .env on import, and that file sets several
// *_REDIRECT_URI values for local development. Deleting them from process.env
// is not enough — dotenv simply puts them back during the require, and the
// test then measures the developer's machine instead of the code.
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

describe("OAuth callback URLs", () => {
  const PLATFORMS = ["reddit", "x", "linkedin", "tiktok", "instagram", "meta"] as const;

  function loadEnv(vars: Record<string, string | undefined>) {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    let loaded!: typeof import("./env").env;
    jest.isolateModules(() => {
      loaded = require("./env").env;
    });
    process.env = saved;
    return loaded;
  }

  it("derives every platform from API_URL", () => {
    const env = loadEnv({
      API_URL: "https://api.godeyeautomation.com",
      REDDIT_REDIRECT_URI: undefined,
      X_REDIRECT_URI: undefined,
      LINKEDIN_REDIRECT_URI: undefined,
      TIKTOK_REDIRECT_URI: undefined,
      INSTAGRAM_REDIRECT_URI: undefined,
      META_REDIRECT_URI: undefined,
    });
    for (const p of PLATFORMS) {
      expect((env as any)[p].redirectUri).toBe(
        `https://api.godeyeautomation.com/connections/${p}/callback`,
      );
    }
  });

  it("never points a configured deployment at localhost", () => {
    const env = loadEnv({ API_URL: "https://api.godeyeautomation.com" });
    for (const p of PLATFORMS) {
      expect((env as any)[p].redirectUri).not.toContain("localhost");
    }
  });

  it("still lets a variable override, since the URL must match what is registered", () => {
    const env = loadEnv({
      API_URL: "https://api.godeyeautomation.com",
      REDDIT_REDIRECT_URI: "https://legacy.example.com/reddit/cb",
    });
    expect(env.reddit.redirectUri).toBe("https://legacy.example.com/reddit/cb");
    // The override is per platform and must not leak into the others.
    expect(env.x.redirectUri).toBe("https://api.godeyeautomation.com/connections/x/callback");
  });

  it("strips a trailing slash off API_URL rather than doubling it", () => {
    // A pasted dashboard value often carries one, and "//connections" is a
    // different path to every provider that string-matches the redirect.
    const env = loadEnv({ API_URL: "https://api.godeyeautomation.com/" });
    expect(env.reddit.redirectUri).toBe(
      "https://api.godeyeautomation.com/connections/reddit/callback",
    );
  });

  /**
   * Paystack plan codes belong to one mode. A plan created with the dashboard
   * switched to Test is invisible to a live key, and Paystack reports that as
   * "plan not found" — indistinguishable from a mistyped code.
   */
  describe("Paystack mode", () => {
    it("reads live and test from the key's own prefix", () => {
      expect(loadEnv({ PAYSTACK_SECRET_KEY: "sk_live_abc123" }).paystack.mode).toBe("live");
      expect(loadEnv({ PAYSTACK_SECRET_KEY: "sk_test_abc123" }).paystack.mode).toBe("test");
    });

    it("says unknown rather than guessing when the key is absent or odd", () => {
      expect(loadEnv({ PAYSTACK_SECRET_KEY: undefined }).paystack.mode).toBe("unknown");
      expect(loadEnv({ PAYSTACK_SECRET_KEY: "pk_live_abc" }).paystack.mode).toBe("unknown");
    });

    it("survives a key pasted with surrounding whitespace", () => {
      // It is used as an HMAC key as well as a bearer token, so an untrimmed
      // value would fail every webhook signature with no hint as to why.
      expect(loadEnv({ PAYSTACK_SECRET_KEY: "  sk_live_abc123 " }).paystack.mode).toBe("live");
    });
  });
});
