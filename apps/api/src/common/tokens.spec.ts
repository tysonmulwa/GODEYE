/**
 * Typed JWTs — the C-1 fix, from the verifier's side.
 *
 * OAuth `state` used to be a JWT signed with JWT_ACCESS_SECRET, and the auth
 * guard checked signature and expiry and nothing else. A value *designed* to
 * travel through Meta, TikTok, LinkedIn and Reddit — and to land in their logs,
 * in browser history and in Referer headers — was a bearer session credential.
 *
 * Two independent defences were added, and the point of testing them here is
 * that each must hold **on its own**. Either one can be undone by a future
 * change nobody reviews closely, and a test that only ever exercises both
 * together would not notice.
 *
 * RFC 8725 §3.1, §3.2, §3.8, §3.11, §3.12.
 */

// Set before anything reads env: the accessors are lazy, so this is the whole
// of the fixture. Real 32+ character values with byte variety, because
// requiredSecret() refuses anything less — that refusal is finding S-5 working.
process.env.JWT_ACCESS_SECRET = "tokens-spec-access-4f8c1e2a9d7b3e5c0a";
process.env.JWT_REFRESH_SECRET = "tokens-spec-refresh-7b3d5f0c2e9a1d4f6b";
process.env.OAUTH_STATE_SECRET = "tokens-spec-oauth-state-9a1e6c4b8d2f7e3a";
process.env.API_URL = "http://localhost:4000";

import { JwtService } from "@nestjs/jwt";
import { env } from "./env";
import {
  signOptions,
  signToken,
  TOKEN_TYPES,
  verifyOptions,
  verifyToken,
  type TokenType,
} from "./tokens";

const jwt = new JwtService({});

describe("key separation", () => {
  /**
   * The claim check and the key check must be independent. If `oauth_state`
   * ever shared the access key again, only the `typ` claim would stand between
   * a leaked query parameter and a session — and a `typ` check is one line for
   * somebody to "simplify".
   */
  it("signs oauth_state with different key material from access", () => {
    expect(signOptions("oauth_state", "10m").secret).not.toBe(
      signOptions("access", "15m").secret,
    );
  });

  it("signs refresh with its own key too", () => {
    expect(signOptions("refresh", "30d").secret).not.toBe(signOptions("access", "15m").secret);
  });

  /**
   * Invites share the OAuth state key deliberately, and that is a decision
   * rather than an oversight: an invite link travels through email, so it is in
   * the same "seen by third parties" class as `state`, and it must never be in
   * the same class as a session.
   */
  it("signs invites with the state key, not the session key", () => {
    expect(signOptions("invite", "7d").secret).toBe(signOptions("oauth_state", "10m").secret);
    expect(signOptions("invite", "7d").secret).not.toBe(signOptions("access", "15m").secret);
  });

  it("covers every declared type", () => {
    for (const typ of TOKEN_TYPES) {
      expect(signOptions(typ, "5m").secret).toBeTruthy();
      expect(verifyOptions(typ).secret).toBe(signOptions(typ, "5m").secret);
    }
  });
});

describe("signing options", () => {
  it("pins HS256 and states issuer and audience", () => {
    const options = signOptions("access", "15m");
    expect(options.algorithm).toBe("HS256");
    expect(options.issuer).toBe(env.jwtIssuer);
    expect(options.audience).toBe("godeye-api");
  });

  /**
   * An allow-list, not a preference. Trusting the `alg` header is how
   * `alg: none` and RS256/HS256 confusion get in (RFC 8725 §3.2), and the
   * library will happily honour whatever the token asks for if you let it.
   */
  it("verifies against exactly one algorithm", () => {
    expect(verifyOptions("access").algorithms).toEqual(["HS256"]);
  });
});

describe("round trip", () => {
  it.each([...TOKEN_TYPES])("signs and verifies a %s token", async (typ) => {
    const token = await signToken(jwt, typ, { sub: "user_1" }, "5m");
    const claims = await verifyToken<{ sub: string }>(jwt, typ, token);
    expect(claims.sub).toBe("user_1");
    expect(claims.typ).toBe(typ);
  });

  it("stamps the type as a claim, not as a convention", async () => {
    const token = await signToken(jwt, "oauth_state", { orgId: "org_1" }, "10m");
    expect(jwt.decode(token)).toMatchObject({ typ: "oauth_state", orgId: "org_1" });
  });
});

describe("cross-type rejection", () => {
  /**
   * The whole matrix, both directions. C-1 was one cell of it — a state token
   * accepted where an access token belonged — and testing only that cell would
   * leave the mirror image, and every other pair, unexamined.
   */
  const pairs: [TokenType, TokenType][] = [];
  for (const signed of TOKEN_TYPES) {
    for (const expected of TOKEN_TYPES) {
      if (signed !== expected) pairs.push([signed, expected]);
    }
  }

  it.each(pairs)("refuses a %s token where a %s is expected", async (signed, expected) => {
    const token = await signToken(jwt, signed, { sub: "user_1" }, "5m");
    await expect(verifyToken(jwt, expected, token)).rejects.toThrow();
  });

  /**
   * The exploit, restated: a `state` value lifted from a provider's logs or
   * from browser history, replayed as a session.
   */
  it("refuses an oauth_state token as an access token", async () => {
    const state = await signToken(jwt, "oauth_state", { sub: "user_1", orgId: "org_1" }, "10m");
    await expect(verifyToken(jwt, "access", state)).rejects.toThrow();
  });
});

describe("tokens minted the old way", () => {
  /**
   * Every token this API ever issued without a `typ` is, by construction, one
   * of the tokens C-1 was about. An untyped token signed with the *current*
   * access key must still be refused — the claim check runs after signature
   * verification and is not conditional on it.
   */
  it("refuses a correctly-signed token that carries no typ at all", async () => {
    const untyped = await jwt.signAsync({ sub: "user_1" }, signOptions("access", "15m"));
    await expect(verifyToken(jwt, "access", untyped)).rejects.toThrow(/untyped/);
  });

  /**
   * The claim check ALONE, with the key check taken out of the picture.
   *
   * A state token presented as an access token fails on the signature first,
   * because the keys differ — which is the layering working, and which is also
   * why a test that only tried that would prove nothing about the `typ` check.
   * So: mint a token with the *access* key and a foreign `typ`, exactly what a
   * regression that re-merged the two keys would produce, and require it to be
   * refused anyway.
   */
  it("refuses a foreign typ even when the signature is valid", async () => {
    const shapedLikeState = await jwt.signAsync(
      { sub: "user_1", typ: "oauth_state" },
      signOptions("access", "15m"),
    );
    await expect(verifyToken(jwt, "access", shapedLikeState)).rejects.toThrow(/oauth_state/);
  });

  /** And the key check alone: same claim, wrong key material. */
  it("refuses a correctly-typed token signed with the wrong key class", async () => {
    const token = await jwt.signAsync(
      { sub: "user_1", typ: "access" },
      { ...signOptions("access", "15m"), secret: signOptions("oauth_state", "10m").secret },
    );
    await expect(verifyToken(jwt, "access", token)).rejects.toThrow(/signature/);
  });
});

describe("the rest of the envelope", () => {
  it("refuses a token from another issuer", async () => {
    const foreign = await jwt.signAsync(
      { sub: "user_1", typ: "access" },
      { ...signOptions("access", "15m"), issuer: "https://someone-else.example.com" },
    );
    await expect(verifyToken(jwt, "access", foreign)).rejects.toThrow();
  });

  it("refuses a token minted for another audience", async () => {
    const foreign = await jwt.signAsync(
      { sub: "user_1", typ: "access" },
      { ...signOptions("access", "15m"), audience: "some-other-api" },
    );
    await expect(verifyToken(jwt, "access", foreign)).rejects.toThrow();
  });

  it("refuses an expired token", async () => {
    const expired = await signToken(jwt, "access", { sub: "user_1" }, "-1s");
    await expect(verifyToken(jwt, "access", expired)).rejects.toThrow();
  });

  it("refuses a token signed with the wrong key", async () => {
    const wrong = await jwt.signAsync(
      { sub: "user_1", typ: "access" },
      { ...signOptions("access", "15m"), secret: "a-different-secret-entirely-0123456789" },
    );
    await expect(verifyToken(jwt, "access", wrong)).rejects.toThrow();
  });

  /** `alg: none` — the oldest one, and still worth a test. */
  it("refuses an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "user_1", typ: "access", iss: env.jwtIssuer, aud: "godeye-api" }),
    ).toString("base64url");
    await expect(verifyToken(jwt, "access", `${header}.${payload}.`)).rejects.toThrow();
  });

  it("refuses something that is not a token at all", async () => {
    await expect(verifyToken(jwt, "access", "not.a.token")).rejects.toThrow();
    await expect(verifyToken(jwt, "access", "")).rejects.toThrow();
  });
});
