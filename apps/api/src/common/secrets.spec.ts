/**
 * S-5 / S-6 — a secret with a fallback produces a *working* system.
 *
 * That is what made both findings survive: nothing broke, nothing warned, and
 * the system was authenticated by a string published on GitHub. These tests fix
 * the shape of the replacement — a secret that is missing, published, weak, or
 * reused fails, and it fails at boot.
 */
// env.ts loads the repo-root .env on import. Without this the developer's real
// secrets leak into the assertions and two of them pass for the wrong reason.
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import {
  InsecureConfigError,
  assertStrongKey,
  requiredHexKey,
  requiredSecret,
  shannonBits,
} from "./secrets";

const STRONG = "b3126e1542fa317004bc1c192e87c6afc2bbfae1674ffae2b159df41d7743209";

describe("requiredSecret", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses a missing value", () => {
    delete process.env.SOME_SECRET;
    expect(() => requiredSecret("SOME_SECRET")).toThrow(InsecureConfigError);
  });

  it.each([
    ["the engine's published default", "dev-engine-secret"],
    ["the Meta webhook's published default", "godeye-verify"],
    ["a docs placeholder", "change-me"],
  ])("refuses %s", (_label, value) => {
    process.env.SOME_SECRET = value;
    expect(() => requiredSecret("SOME_SECRET")).toThrow(/published in this repository/);
  });

  it("refuses a value too short to be a secret", () => {
    process.env.SOME_SECRET = "short";
    expect(() => requiredSecret("SOME_SECRET")).toThrow(/shorter than 32/);
  });

  it("refuses a long value with no entropy", () => {
    process.env.SOME_SECRET = "a".repeat(64);
    expect(() => requiredSecret("SOME_SECRET")).toThrow(/not random enough/);
  });

  it("accepts a real one", () => {
    process.env.SOME_SECRET = STRONG;
    expect(requiredSecret("SOME_SECRET")).toBe(STRONG);
  });

  it("permits a documented dev default only when both dev flags are set", () => {
    process.env.SOME_SECRET = "dev-engine-secret";
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_DEV_DEFAULTS = "true";
    expect(requiredSecret("SOME_SECRET")).toBe("dev-engine-secret");

    // The flag must be inert outside development — this is the half that
    // matters, since production is where the published default did its damage.
    process.env.NODE_ENV = "production";
    expect(() => requiredSecret("SOME_SECRET")).toThrow();
  });
});

describe("requiredHexKey", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    ["all zeros — what .env.example shipped", "0".repeat(64)],
    ["one byte repeated", "ab".repeat(32)],
    ["a counting sequence", Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("")],
  ])("refuses a format-valid key that is %s", (_label, hex) => {
    process.env.KEY = hex;
    expect(() => requiredHexKey("KEY")).toThrow(InsecureConfigError);
  });

  it("refuses the wrong length", () => {
    process.env.KEY = "abcd";
    expect(() => requiredHexKey("KEY")).toThrow(/64 hex characters/);
  });

  it("accepts a real key", () => {
    process.env.KEY = STRONG;
    expect(requiredHexKey("KEY").toString("hex")).toBe(STRONG);
  });
});

describe("assertStrongKey", () => {
  it("names why it refused, so the operator can act on it", () => {
    expect(() => assertStrongKey("K", "0".repeat(64))).toThrow(/single byte repeated/);
  });
});

describe("shannonBits", () => {
  it("separates a real secret from a placeholder", () => {
    expect(shannonBits(STRONG)).toBeGreaterThan(3);
    expect(shannonBits("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeLessThan(1);
  });
});

describe("validateConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function load() {
    let mod!: typeof import("./env");
    jest.isolateModules(() => {
      mod = require("./env");
    });
    return mod;
  }

  const good = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    JWT_ACCESS_SECRET: "access-".padEnd(40, "x7f3a9b2c"),
    JWT_REFRESH_SECRET: "refresh-".padEnd(40, "q1w2e3r4t"),
    OAUTH_STATE_SECRET: "state-".padEnd(40, "z9y8x7w6v"),
    TOKEN_ENCRYPTION_KEY: STRONG,
    ENGINE_INTERNAL_SECRET: "engine-".padEnd(40, "m5n6b7v8c"),
  };

  it("passes on a fully configured environment", () => {
    Object.assign(process.env, good);
    expect(() => load().validateConfig()).not.toThrow();
  });

  it("refuses to boot when a secret is missing, and names it", () => {
    Object.assign(process.env, good);
    delete process.env.OAUTH_STATE_SECRET;
    expect(() => load().validateConfig()).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("refuses to boot when the OAuth state key is the session key (C-1)", () => {
    Object.assign(process.env, good, { OAUTH_STATE_SECRET: good.JWT_ACCESS_SECRET });
    expect(() => load().validateConfig()).toThrow(/must not equal JWT_ACCESS_SECRET/);
  });

  it("refuses to boot when access and refresh share key material", () => {
    Object.assign(process.env, good, { JWT_REFRESH_SECRET: good.JWT_ACCESS_SECRET });
    expect(() => load().validateConfig()).toThrow(/must not equal/);
  });

  it("reports every problem at once rather than one per restart", () => {
    Object.assign(process.env, good);
    delete process.env.OAUTH_STATE_SECRET;
    delete process.env.ENGINE_INTERNAL_SECRET;
    expect(() => load().validateConfig()).toThrow(/2 configuration problem/);
  });
});
